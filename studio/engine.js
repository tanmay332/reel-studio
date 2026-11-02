/* Shared by the Studio (app.js) and the renderer (render.js): clip data, composing picks
   into a spec, and the Player that draws a spec over the video. Using the same code for
   both is what makes the rendered MP4 match the preview frame for frame. */

const $ = (s, r = document) => r.querySelector(s);
// off: placements you said No to. mute: placements whose sound you turned off. Both hold placement ids.
// ink / accent: text and highlight colours (null = white / the grade's accent). custom: animations you placed yourself.
// hookLines: your own hook title ([line 1, line 2]); null uses the one planned in beats.json.
const emptyPicks = () => ({ grade: null, font: null, caption: null, ink: null, accent: null, hook: null, hookLines: null,
  moves: [], anims: {}, custom: [], sounds: [], off: [], mute: [] });
const players = new Set();
let clip, plan, beats, page;
// ?data=<folder> loads another clip's files: "data" or "../projects/<name>/studio". The Studio remembers the last one opened.
const DATA_DIR = new URLSearchParams(location.search).get("data") || (() => {
  try { return localStorage.getItem("studio.data"); } catch { return null; }
})() || "data";

async function loadData() {
  const get = u => fetch(u).then(r => r.json());
  [clip, plan, page] = await Promise.all([get(`${DATA_DIR}/clip.json`), get(`${DATA_DIR}/beats.json`), get("assets/wiki-private-equity.json")]);
  page.src = "assets/wiki-private-equity.png";
  beats = plan.beats;
  if (plan.keywords) { KEYWORDS.clear(); plan.keywords.forEach(k => KEYWORDS.add(norm(k))); }
  beats.forEach(b => (b.options || []).forEach(o => resolveAnchors(o, b)));
  const whole = { id: "clip", start: 0, end: clip.duration };
  plan.impactTimes = (plan.impact || []).map(a => anchor(a, whole));
  plan.bigTimes = (plan.big || []).map(a => anchor(a, whole));
}

function anchor(a, b) {
  if (a == null || typeof a === "number") return a;
  if (a === "start") return b.start;
  if (a === "end") return b.end;
  const word = norm(typeof a === "string" ? a : a.word), nth = a.nth || 1;
  const hits = clip.words.filter(w => w.start >= b.start - 0.05 && w.start < b.end && norm(w.word) === word);
  if (!hits[nth - 1]) console.warn("Anchor not found:", a, "in", b.id);
  return hits[nth - 1]?.start ?? b.start;
}

function resolveAnchors(o, b) {
  o.at = anchor(o.at, b);
  o.until = anchor(o.until, b);
  o.hl = anchor(o.hl, b);
  o.captionAt = anchor(o.captionAt, b);
  o.beatEnd = b.end;
  (o.items || []).forEach(it => { it.at = anchor(it.at, b); });
  (o.lines || []).forEach(l => { l.at = anchor(l.at, b); });
  if (o.at == null) o.at = (o.items || o.lines)?.[0]?.at;
}

// Styles saved before moves/animations were split out used {beats, whole}.
function migratePicks(p = {}) {
  const out = { ...emptyPicks(), ...structuredClone(p) };
  if (p.whole) {
    const map = { "w-progress": "progress", "w-zoomcut": "closeup", "w-flashcut": "flash", "w-push": "push" };
    out.moves = [...new Set([...out.moves, ...p.whole.map(w => map[w]).filter(Boolean)])];
  }
  if (p.beats) {
    for (const [bid, ids] of Object.entries(p.beats)) {
      const b = beats.find(x => x.id === bid);
      const keep = ids.filter(id => id === "none" || b?.options?.some(o => o.id === id));
      if (keep.length) out.anims[bid] = keep;
    }
  }
  delete out.whole;
  delete out.beats;
  return out;
}

const wordAt = t => clip.words.find(w => w.start >= t - 0.05);
const wordsFrom = (t, n = 5) => clip.words.filter(w => w.start >= t - 0.05).slice(0, n).map(w => w.word).join(" ");
const nextCut = t => clip.cuts.find(c => c > t + 0.05) ?? clip.duration;

function movePlacements(id) {
  const starts = [0, ...clip.cuts];
  const said = t => bare(wordAt(t)?.word || "");
  switch (id) {
    case "punch":
      return plan.impactTimes.map((t, i) => ({ id: `punch#${i}`, label: `Punch-in on “${said(t)}”`, t,
        fx: { kind: "punch", at: t, until: nextCut(t), scale: 0.1 } }));
    case "closeup":
      return starts.map((s, i) => ({ s, i })).filter(x => x.i % 2 === 1).map(({ s, i }) => ({ id: `closeup#${i}`,
        label: `Close-up on shot ${i + 1}`, t: s, fx: { kind: "punch", at: s, until: starts[i + 1] ?? clip.duration, scale: 0.15, snap: true, silent: true } }));
    case "whip":
      return beats.filter(b => !b.hook).map(b => ({ id: `whip#${b.id}`, label: `Whip pan into ${b.label.toLowerCase()}`, t: b.start, fx: { kind: "whip", at: b.start } }));
    case "flash":
      return clip.cuts.map((c, i) => ({ id: `flash#${i}`, label: `Flash on cut ${i + 1}`, t: c, fx: { kind: "flash", at: c } }));
    case "shake":
      return plan.bigTimes.map((t, i) => ({ id: `shake#${i}`, label: `Shake on “${said(t)}”`, t, fx: { kind: "shake", at: t } }));
    case "push":
      return [{ id: "push", label: "Slow push-in across the clip", t: 0, fx: { kind: "push" } }];
    case "progress":
      return [{ id: "progress", label: "Progress bar across the clip", t: 0, fx: { kind: "progress" } }];
  }
  return [];
}

// The hook's two lines, plus the word the slam and highlighter titles single out.
function hookText(p) {
  const h = plan.hook || { lines: ["", ""] };
  if (!p.hookLines) return h;
  const lines = [p.hookLines[0] || "", p.hookLines[1] || ""];
  const ws = lines[0].split(/\s+/).filter(Boolean);
  const long = ws.reduce((m, w) => (bare(w).length > bare(m).length ? w : m), "");
  return { ...h, lines, mark: ws[ws.length - 1] || "", slam: bare(long).toUpperCase() };
}

// Every concrete thing the picks put on screen, in time order, each with its own Yes/No and sound switch.
function placements(p) {
  const out = [];
  const ctx = { page, duration: clip.duration, cuts: clip.cuts, split: () => 0 };
  const add = (group, pl) => {
    const fx = { ...pl.fx, pid: pl.id };
    out.push({ ...pl, group, fx, on: !p.off.includes(pl.id), sound: !p.mute.includes(pl.id),
      words: wordsFrom(pl.t), sounds: makeEffect(fx, ctx).sounds || [] });
  };
  if (p.hook && p.hook !== "none") {
    add("hook", { id: `hook:${p.hook}`, label: `Hook title: ${HOOKS.find(h => h.id === p.hook)?.label}`, t: 0,
      fx: { kind: "hook", id: p.hook, ...hookText(p), end: beats.find(b => b.hook).end } });
  }
  p.moves.forEach(id => movePlacements(id).forEach(pl => add("moves", pl)));
  beats.filter(b => !b.hook).forEach(b => (p.anims[b.id] || []).forEach(id => {
    const o = b.options.find(x => x.id === id);
    if (o) add("anims", { id: `anim:${id}`, label: o.label, t: o.at, fx: o, beat: b.id });
  }));
  p.custom.forEach(c => add("anims", { id: `custom:${c.id}`, label: c.label, t: c.at, fx: c, custom: true }));
  return out.sort((a, b) => a.t - b.t);
}

function compose(picks, o = {}) {
  const p = { ...picks, ...o };
  const fx = placements(p).filter(pl => pl.on).map(pl => pl.fx);
  // One thing at a time above the head: a keyword, count or step badge gives way when the next one arrives.
  const heads = fx.filter(f => ["keyword", "word", "count", "steps", "timeline", "graphic"].includes(f.kind)).sort((a, b) => a.at - b.at);
  // A keyword's items each give way on their own, so a later item isn't cut by something that arrived between them.
  const multi = f => f.kind === "keyword" || f.kind === "word";
  const starts = heads.flatMap(f => multi(f) ? f.items.map(it => ({ f, at: it.at })) : [{ f, at: f.at }]);
  const nextAfter = (f, at) => starts.filter(s => s.f !== f && s.at > at).reduce((m, s) => Math.min(m, s.at), Infinity);
  heads.forEach(f => {
    if (multi(f)) (f.items = f.items.map(it => ({ ...it }))).forEach(it => { const n = nextAfter(f, it.at); if (n < Infinity) it.cutAt = n; });
    else { const n = nextAfter(f, f.at); if (n < Infinity) f.cutAt = n; }
  });
  if (o.extra) fx.push(...o.extra);
  return {
    grade: GRADES.find(g => g.id === p.grade) || GRADES[0],
    font: FONTS.find(f => f.id === p.font) || FONTS[0],
    caption: CAPTIONS.find(c => c.id === p.caption) || null,
    ink: p.ink,
    accent: p.accent,
    fx,
    mute: p.mute,
  };
}

function fxCtx(spec) {
  const splits = spec.fx.filter(f => f.kind === "split");
  return { page, duration: clip.duration, cuts: clip.cuts, split: t => Math.max(0, ...splits.map(o => splitMix(o, t))) };
}
// Sound cues of a spec, minus the placements whose sound you turned off. Which kinds play is picks.sounds.
const soundEvents = spec => spec.fx
  .flatMap(f => (makeEffect(f, fxCtx(spec)).sounds || []).map(s => ({ ...s, pid: f.pid })))
  .filter(e => !(spec.mute || []).includes(e.pid));

class Player {
  constructor(host, { src, muted = true }) {
    host.innerHTML = `<div class="stage"><div class="cam"><video playsinline preload="auto" muted></video><div class="grade-ov"></div></div><div class="fx"></div></div>`;
    this.host = host;
    this.stage = $(".stage", host);
    this.cam = $(".cam", host);
    this.video = $("video", host);
    this.ov = $(".grade-ov", host);
    this.fx = $(".fx", host);
    this.video.muted = muted;
    this.video.src = src;
    this.effects = [];
    this.events = [];
    this.win = null;
    this.ro = new ResizeObserver(() => { this.stage.style.transform = `scale(${host.clientWidth / 1080})`; });
    this.ro.observe(host);
    this.video.addEventListener("ended", () => { this.video.currentTime = this.win ? this.win[0] : 0; this.video.play().catch(() => {}); });
    players.add(this);
  }

  setSpec(spec) {
    this.fx.innerHTML = "";
    this.effects = [];
    this.events = [];
    const v = this.video, s = this.stage.style;
    if (!spec) {
      v.style.filter = "";
      this.ov.style.background = "";
      return;
    }
    const { title: T, cap: C } = spec.font;
    s.setProperty("--accent", spec.accent || spec.grade.accent);
    s.setProperty("--ink", spec.ink || "#FFFFFF");
    s.setProperty("--tf", `"${T.f}"`);
    s.setProperty("--tw", T.w);
    s.setProperty("--ts", T.s || "normal");
    s.setProperty("--cf", `"${C.f}"`);
    s.setProperty("--cw", C.w);
    v.style.filter = spec.grade.filter;
    this.ov.style.background = spec.grade.overlay || "";
    this.ov.style.mixBlendMode = spec.grade.blend || "normal";
    const ctx = fxCtx(spec);
    this.effects = spec.fx.map(f => makeEffect(f, ctx));
    if (spec.caption) this.effects.push(makeCaptions(spec.caption, clip.words, clip.duration, ctx.split));
    this.effects.forEach(e => e.mount?.(this.fx));
    this.events = soundEvents(spec).sort((a, b) => a.t - b.t);
    this.tick();
  }

  setWindow(a, b) {
    this.win = a == null ? null : [a, b];
    const v = this.video;
    if (this.win && (v.currentTime < a || v.currentTime >= b)) v.currentTime = a;
  }

  // t overrides the video clock (the renderer draws exact frame times while the video shows the nearest frame).
  tick(t) {
    const v = this.video;
    if (t == null) {
      if (this.win && (v.currentTime >= this.win[1] || v.currentTime < this.win[0] - 0.3)) v.currentTime = this.win[0];
      t = v.currentTime;
    }
    const c = { s: 1, x: 0, y: 0, blur: 0, round: 0 };
    this.effects.forEach(e => e.cam?.(t, c));
    this.cam.style.transform = `translate(${c.x}px,${c.y}px) scale(${c.s})`;
    this.cam.style.filter = c.blur ? `blur(${c.blur}px)` : "";
    v.style.clipPath = c.round ? `inset(0 round ${c.round / c.s}px)` : "";
    this.effects.forEach(e => e.update?.(t));
  }

  destroy() {
    players.delete(this);
    this.ro.disconnect();
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
  }
}
