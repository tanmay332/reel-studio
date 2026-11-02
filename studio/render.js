/* Driven by tools/render_studio.cjs: draws one exact frame at a time with the same engine
   as the Studio preview, so the MP4 matches what was picked. */

// The source's own frame rate (iPhone clips are 29.97, older clips 25); guessing wrong skips or repeats frames.
let SOURCE_FPS = 30;

window.renderer = {
  player: null,
  shown: -1,

  async init(picks) {
    await loadData();
    SOURCE_FPS = clip.fps || 30;
    picks = migratePicks(picks);
    const spec = compose(picks);
    this.player = new Player($("#host"), { src: `${DATA_DIR}/render.mp4` });
    const v = this.player.video;
    await new Promise(r => (v.readyState >= 2 ? r() : v.addEventListener("loadeddata", r, { once: true })));

    // Load every face this edit can draw before the first frame.
    const { title: T, cap: C } = spec.font;
    await Promise.all([
      `${T.s || "normal"} ${T.w} 80px "${T.f}"`, `italic ${T.w} 80px "${T.f}"`,
      `normal ${C.w} 80px "${C.f}"`, `normal 500 80px "${C.f}"`, `normal 900 80px "${C.f}"`,
    ].map(f => document.fonts.load(f).catch(() => {})));
    const img = new Image();
    img.src = page.src;
    await img.decode().catch(() => {});

    this.player.setSpec(spec);
    await document.fonts.ready;
    return {
      duration: clip.duration,
      voice: clip.source,
      events: soundEvents(spec).filter(e => picks.sounds.includes(e.kind)).sort((a, b) => a.t - b.t),
      music: picks.sounds.includes("music"),
      sounds: SOUNDS.map(({ id, file, gain }) => ({ id, file: `studio/${file}`, gain })),
    };
  },

  async frame(t) {
    const v = this.player.video;
    // Seek only when the source frame changes; aim at the middle of the frame so decoding lands on it.
    const idx = Math.min(Math.floor(t * SOURCE_FPS), Math.floor(clip.duration * SOURCE_FPS) - 1);
    if (idx !== this.shown) {
      await new Promise(resolve => {
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };
        if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(() => finish());
        v.addEventListener("seeked", () => setTimeout(finish, 120), { once: true });
        v.currentTime = (idx + 0.5) / SOURCE_FPS;
        setTimeout(finish, 2000);
      });
      this.shown = idx;
    }
    this.player.tick(t);
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  },
};
