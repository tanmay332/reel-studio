/* Hands-free demo for filming: D sends a fake cursor through the whole flow in about 40 s
   (the real pointer hides), R stops it and resets. The demo's "Save" doesn't write a file. */
(() => {
  const cursor = document.getElementById("cursor");
  const S = () => window.studio;
  let running = false, stop = false;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const PACE = 0.65; // scales the pauses after each click; the full run lands around 40 s

  const lastGridCard = n => {
    const grids = document.querySelectorAll("#body .grid");
    return grids[grids.length - 1]?.children[n - 1];
  };

  async function moveTo(target) {
    if (stop) throw new Error("stopped");
    const el = typeof target === "string" ? document.querySelector(target) : target;
    if (!el) throw new Error(`Demo target missing: ${target}`);
    const before = el.getBoundingClientRect();
    if (before.top < 60 || before.bottom > innerHeight - 60) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      await sleep(350);
    }
    const r = el.getBoundingClientRect();
    cursor.style.left = `${r.left + r.width * 0.55}px`;
    cursor.style.top = `${r.top + Math.min(r.height * 0.5, 70)}px`;
    await sleep(430);
    return el;
  }

  async function click(target, after = 600) {
    const el = await moveTo(target);
    cursor.classList.remove("click");
    void cursor.offsetWidth;
    cursor.classList.add("click");
    el.click();
    await sleep(after * PACE);
  }

  async function type(target, text) {
    const el = await moveTo(target);
    el.focus();
    el.value = "";
    for (const ch of text) { el.value += ch; await sleep(70); }
  }

  const card = n => () => lastGridCard(n);
  const go = async (t, after) => click(typeof t === "function" ? t() : t, after);

  async function run() {
    running = true;
    stop = false;
    document.body.classList.add("demo");
    S().state.demo = true;
    S().audio.init();
    cursor.style.left = `${innerWidth * 0.7}px`;
    cursor.style.top = `${innerHeight * 0.6}px`;
    try {
      S().reset();
      await sleep(700);
      // 1. Colours
      await go(card(4), 500);
      await go(card(2), 800);
      await go("#next", 900);
      // 2. Fonts
      await go(card(2), 800);
      await go("#next", 900);
      // 3. Captions
      await go(card(6), 900);
      await go("#next", 1000);
      // 4. Hook
      await go(card(1), 1100);
      await go("#next", 900);
      // 5. Moves, then say No to one place it lands
      await go(card(1), 700);
      await go(card(2), 900);
      await go(".prows .prow:nth-child(2) [data-no]", 900);
      await go("#next", 900);
      // 6. Sound, then turn one sound off on the map
      for (const n of [1, 2, 3, 4]) await go(card(n), 450);
      await go(card(6), 700);
      await go(".prows .prow:nth-child(1) [data-no]", 900);
      await go("#next", 900);
      // 7. Animations, one per beat
      await go(card(2), 1100);
      await go('.seg[data-beat="b3"]', 700);
      await go(card(3), 900);
      await go('.seg[data-beat="b4"]', 700);
      await go(card(2), 900);
      await go('.seg[data-beat="b5"]', 700);
      await go(card(1), 1100);
      await go("#next", 900);
      // 8. Watch: render, then save as a style
      await go("#render", 5200);
      await type("#styleName", "Split card");
      await go("#save", 1600);
      cursor.style.left = `${innerWidth * 0.75}px`;
      cursor.style.top = `${innerHeight * 0.85}px`;
      await sleep(600);
    } catch (e) {
      if (!stop) console.error(e);
    }
    S().state.demo = false;
    document.body.classList.remove("demo");
    running = false;
    S().resume(); // the demo never touches your saved picks; put them back
  }

  document.addEventListener("keydown", e => {
    if (e.target.matches("input, textarea, select") || e.ctrlKey || e.metaKey || e.altKey || !$("#importModal").hidden) return;
    const k = e.key.toLowerCase();
    if (k === "d" && !running) run();
    if (k === "r") {
      if (running) {
        stop = true;
        document.body.classList.remove("demo");
        return;
      }
      if (confirm("Start this clip over? Everything you picked on it is cleared.")) S().reset();
    }
  });
})();
