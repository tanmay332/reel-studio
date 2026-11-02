/* Looks and effects for the Studio.
   Everything draws on a 1080x1920 stage and is a pure function of clip time t,
   so a looping card replays its animation on every pass and never sits blank.
   Layout is measured from the clip: face x 320-640, y 490-900. Titles and keywords
   sit above the head (y 240-480), captions under the chin (y ~1380), chest cards
   at y 930-1290, all inside Instagram's safe zone (top 220, bottom 420 clear). */

const STAGE = { w: 1080, h: 1920, headY: 360, captionTop: 1310, chestY: 930 };

const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (a, b, p) => a + (b - a) * p;
const prog = (t, a, d) => clamp((t - a) / d);
const E = {
  out: p => 1 - (1 - p) ** 3,
  back: p => { const c = 2.0; return 1 + (c + 1) * (p - 1) ** 3 + c * (p - 1) ** 2; },
};
// How far the split layout is in (0..1) at time t; items above the head move down out of its way.
const splitMix = (o, t) => (t >= o.at && t < o.until ? E.out(prog(t, o.at, 0.35)) * (1 - prog(t, o.until - 0.3, 0.3)) : 0);
const SPLIT_DROP = 600;
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const bare = w => w.replace(/[^\p{L}\p{N}'’$-]/gu, "");
const norm = w => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
function el(cls, html = "", css = "") {
  const d = document.createElement("div");
  d.className = cls;
  d.innerHTML = html;
  if (css) d.style.cssText = css;
  return d;
}

/* ---------- Step 1: colour grades ---------- */
const GRADES = [
  { id: "raw", label: "Raw", filter: "none", accent: "#FFD43B" },
  { id: "bright", label: "Bright natural", filter: "brightness(1.08) contrast(1.06) saturate(1.12)", accent: "#FFC531" },
  { id: "cool", label: "Clean and cool", filter: "brightness(1.05) contrast(1.08) saturate(0.9) hue-rotate(-6deg)",
    overlay: "linear-gradient(rgba(70,130,255,.16),rgba(70,130,255,.12))", blend: "soft-light", accent: "#4DA3FF" },
  { id: "warm", label: "Warm film", filter: "sepia(0.25) saturate(1.15) contrast(1.06) brightness(1.03)",
    overlay: "radial-gradient(ellipse at 50% 40%, transparent 50%, rgba(70,30,0,.45))", blend: "multiply", accent: "#FF8A3D" },
  { id: "teal", label: "Moody teal", filter: "contrast(1.18) saturate(0.85) brightness(0.9)",
    overlay: "linear-gradient(rgba(0,120,140,.38),rgba(0,60,80,.42))", blend: "soft-light", accent: "#2EE6D6" },
  { id: "punchy", label: "Punchy", filter: "contrast(1.25) saturate(1.4) brightness(1.02)", accent: "#FF3B5C" },
  { id: "matte", label: "Soft matte", filter: "contrast(0.86) brightness(1.07) saturate(0.82)",
    overlay: "linear-gradient(rgba(255,235,225,.14),rgba(255,235,225,.14))", blend: "lighten", accent: "#F4A9C8" },
  { id: "bw", label: "Black and white", filter: "grayscale(1) contrast(1.18) brightness(1.02)", accent: "#FFE14D" },
  // Soft fades at the top and bottom so thin type stays readable over bright backgrounds, without boxes.
  { id: "quiet", label: "Quiet luxury", filter: "none", accent: "#E8E3D1",
    overlay: "linear-gradient(180deg, rgba(0,0,0,.55) 0%, rgba(0,0,0,.32) 20%, rgba(0,0,0,0) 33%, rgba(0,0,0,0) 60%, rgba(0,0,0,.32) 100%)" },
];

/* ---------- Step 2: font pairs (title / caption) ---------- */
const FONTS = [
  { id: "clean", label: "Inter Black / Inter", title: { f: "Inter", w: 900 }, cap: { f: "Inter", w: 700 } },
  { id: "editorial", label: "Instrument Serif / Inter", title: { f: "Instrument Serif", w: 400, s: "italic" }, cap: { f: "Inter", w: 600 } },
  { id: "impact", label: "Anton / Inter", title: { f: "Anton", w: 400 }, cap: { f: "Inter", w: 800 } },
  { id: "poster", label: "Bebas Neue / Manrope", title: { f: "Bebas Neue", w: 400 }, cap: { f: "Manrope", w: 800 } },
  { id: "geo", label: "Montserrat Black / Montserrat", title: { f: "Montserrat", w: 900 }, cap: { f: "Montserrat", w: 700 } },
  { id: "classic", label: "Playfair / Poppins", title: { f: "Playfair Display", w: 800, s: "italic" }, cap: { f: "Poppins", w: 600 } },
  { id: "tech", label: "Space Grotesk / JetBrains Mono", title: { f: "Space Grotesk", w: 700 }, cap: { f: "JetBrains Mono", w: 600 } },
  { id: "friendly", label: "DM Serif / DM Sans", title: { f: "DM Serif Display", w: 400 }, cap: { f: "DM Sans", w: 700 } },
  // MUSED x Anjan Luthra brand guidelines (23 Oct 2026): Nanum Myeongjo headlines, Work Sans Regular text.
  { id: "anjan", label: "Anjan's style", sub: "Nanum Myeongjo / Work Sans", title: { f: "Nanum Myeongjo", w: 800 }, cap: { f: "Work Sans", w: 400 } },
  { id: "luxury", label: "Quiet luxury", sub: "Cormorant Garamond / Work Sans", title: { f: "Cormorant Garamond", w: 500 }, cap: { f: "Work Sans", w: 400 } },
];

/* ---------- Step 3: caption styles, timed to the real words ---------- */
// Default key words (the 3-best40 clip); a clip's beats.json "keywords" replaces them (engine.js).
const KEYWORDS = new Set(("broke behind private equity multimillionaire never held back changed life wrong achieved " +
  "built companies time freedom identify done before advice ahead quicker").split(" "));
const isKey = w => KEYWORDS.has(norm(w));
const spoken = (words, t) => words.reduce((i, w, k) => (w.start <= t + 0.02 ? k : i), -1);
const popIn = (t, a, from = 0.82) => `scale(${from + (1 - from) * E.back(prog(t, a, 0.16))})`;

const CAPTIONS = [
  { id: "chunk", label: "1 to 3 words", max: 3,
    render: (c, t) => ({ key: c.i, html: `<span class="cap-plain">${c.words.map(w => esc(bare(w.word))).join(" ")}</span>`, transform: popIn(t, c.start) }) },
  { id: "karaoke", label: "Karaoke", max: 5,
    render: (c, t) => { const a = spoken(c.words, t);
      return { key: `${c.i}:${a}`, html: `<span class="cap-karaoke">${c.words.map((w, k) => `<span class="${k <= a ? "on" : ""}">${esc(bare(w.word))}</span>`).join(" ")}</span>` }; } },
  { id: "big", label: "One big word", max: 1,
    render: (c, t) => ({ key: c.i, html: `<span class="cap-big">${esc(bare(c.words[0].word))}</span>`, transform: popIn(t, c.start, 0.55) }) },
  { id: "boxed", label: "Boxed words", max: 3,
    render: (c, t) => { const a = spoken(c.words, t);
      return { key: `${c.i}:${a}`, html: `<span class="cap-boxed">${c.words.map((w, k) => `<span class="${k === a ? "on" : ""}">${esc(bare(w.word))}</span>`).join("")}</span>` }; } },
  { id: "outline", label: "Bold outline", max: 3,
    render: (c, t) => { const a = spoken(c.words, t);
      return { key: `${c.i}:${a}`, html: `<span class="cap-outline">${c.words.map((w, k) => `<span class="${k === a ? "on" : ""}">${esc(bare(w.word).toUpperCase())}</span>`).join(" ")}</span>`, transform: popIn(t, c.start) }; } },
  { id: "twotone", label: "Two-tone key words", max: 4,
    render: (c, t) => ({ key: c.i, html: `<span class="cap-twotone">${c.words.map(w => isKey(w.word) ? `<em>${esc(bare(w.word))}</em>` : esc(bare(w.word))).join(" ")}</span>`, transform: popIn(t, c.start, 0.9) }) },
  { id: "quiet", label: "Quiet serif accents", max: 4,
    render: (c, t) => ({ key: c.i, html: `<span class="cap-quiet">${c.words.map(w => isKey(w.word) ? `<em>${esc(bare(w.word))}</em>` : esc(bare(w.word))).join(" ")}</span>`,
      transform: `translateY(${(1 - E.out(prog(t, c.start, 0.35))) * 10}px)` }) },
  { id: "minimal", label: "Minimal lowercase", max: 5,
    render: (c, t) => ({ key: c.i, html: `<span class="cap-minimal">${c.words.map(w => esc(bare(w.word).toLowerCase())).join(" ")}</span>`, transform: `translateY(${(1 - E.out(prog(t, c.start, 0.2))) * 14}px)` }) },
  { id: "typewriter", label: "Typewriter", max: 5,
    render: (c, t) => {
      let n = 0, text = "";
      c.words.forEach((w, k) => {
        const s = bare(w.word) + (k < c.words.length - 1 ? " " : "");
        const shown = t >= w.end ? s.length : t < w.start ? 0 : Math.ceil(s.length * prog(t, w.start, Math.max(w.end - w.start, 0.05)));
        if (shown) { text += s.slice(0, shown); n += shown; }
      });
      return { key: `${c.i}:${n}`, html: `<span class="cap-type">${esc(text)}<i class="caret"></i></span>` };
    } },
];

function chunkWords(words, max, clipEnd) {
  const chunks = [];
  let cur = [];
  words.forEach((w, i) => {
    cur.push(w);
    const next = words[i + 1];
    if (cur.length >= max || /[.,?!]$/.test(w.word) || !next || next.start - w.end > 0.5) {
      chunks.push({ words: cur, start: cur[0].start });
      cur = [];
    }
  });
  chunks.forEach((c, i) => {
    const last = c.words[c.words.length - 1].end;
    const next = chunks[i + 1]?.start ?? clipEnd;
    c.i = i;
    c.end = next - last < 0.8 ? next : last + 0.3;
  });
  return chunks;
}

function makeCaptions(style, words, clipEnd, split = () => 0) {
  const chunks = chunkWords(words, style.max, clipEnd);
  let node, key = null;
  return {
    sounds: [],
    mount(fx) { node = el(`cap-wrap cap-${style.id}`); fx.appendChild(node); },
    update(t) {
      const c = chunks.find(c => t >= c.start && t < c.end);
      if (!c) { if (key !== null) { node.innerHTML = ""; key = null; } return; }
      const r = style.render(c, t);
      if (r.key !== key) { node.innerHTML = r.html; key = r.key; }
      node.style.transform = r.transform || "";
      node.style.translate = `0 ${split(t) * 90}px`; // under the chin while the split layout is in
    },
  };
}

/* ---------- Step 4: hook titles (beat 1) ---------- */
const HOOKS = [
  { id: "launch", label: "Launch title", sound: [["whoosh", 0]] },
  { id: "box", label: "White boxes", sub: "Loud", sound: [["pop", 0], ["pop", 0.25]] },
  { id: "split", label: "Split reveal", sound: [["whoosh", 0], ["whoosh", 0.14]] },
  { id: "type", label: "Typewriter", sound: [["typing", 0]] },
  { id: "marker", label: "Highlighter", sound: [["click", 0.3]] },
  { id: "slam", label: "Word slam", sub: "Loud", sound: [["pop", 0]] },
  { id: "editorial", label: "Editorial serif", sub: "Quiet", sound: [["whoosh", 0]] },
  { id: "sticker", label: "Sticker", sub: "Loud", sound: [["pop", 0]] },
];

function makeHook(o) {
  const [L1, L2] = o.lines;
  const end = o.end;
  const spans = s => s.split(" ").map(w => `<span class="w">${esc(w)}</span>`).join(" ");
  let wrap, parts = [];
  const sounds = (HOOKS.find(h => h.id === o.id)?.sound || []).map(([kind, t]) => ({ kind, t }));
  const typed = (s, t, a, d) => esc(s.slice(0, Math.round(s.length * prog(t, a, d))));
  return {
    sounds,
    mount(fx) {
      wrap = el(`hook hook-${o.id}`);
      if (o.id === "launch") wrap.innerHTML = `<div class="h-l1 t-title">${spans(L1)}</div><div class="h-l2 t-title">${spans(L2)}</div>`;
      if (o.id === "box") wrap.innerHTML = `<div class="h-box"><span class="t-title">${esc(L1)}</span></div><div class="h-box h-small"><span class="t-cap">${esc(L2)}</span></div>`;
      if (o.id === "split") wrap.innerHTML = `<div class="h-l1 t-title">${esc(L1)}</div><div class="h-bar"></div><div class="h-l2 t-cap">${esc(L2)}</div>`;
      if (o.id === "type") wrap.innerHTML = `<div class="h-l1 t-title"></div><div class="h-l2 t-cap"></div>`;
      if (o.id === "marker") wrap.innerHTML = `<div class="h-l1 t-title">${esc(L1.replace(o.mark, "")).trim()} <span class="mark">${esc(o.mark)}</span></div><div class="h-l2 t-cap">${esc(L2)}</div>`;
      if (o.id === "slam") wrap.innerHTML = `<div class="h-slam t-title">${esc(o.slam)}</div><div class="h-l2 t-cap">${esc(L2)}</div>`;
      if (o.id === "editorial") wrap.innerHTML = `<div class="h-l1 h-serif">${esc(L1)}</div><div class="h-l2 h-caps t-cap">${esc(L2)}</div>`;
      if (o.id === "sticker") wrap.innerHTML = `<div class="h-sticker"><div class="t-title">${esc(L1)}</div><div class="t-cap">${esc(L2)}</div></div>`;
      parts = [...wrap.children];
      fx.appendChild(wrap);
    },
    update(t) {
      const on = t < end;
      wrap.style.display = on ? "" : "none";
      if (!on) return;
      wrap.style.opacity = 1 - prog(t, end - 0.25, 0.25);
      const [a, b, c] = parts;
      switch (o.id) {
        case "launch":
          wrap.querySelectorAll(".w").forEach((s, i) => {
            const at = i * 0.07 + (i >= L1.split(" ").length ? 0.15 : 0);
            s.style.transform = `translateY(${(1 - E.back(prog(t, at, 0.32))) * 90}px)`;
            s.style.opacity = prog(t, at, 0.12);
          });
          break;
        case "box":
          a.style.transform = `scale(${E.back(prog(t, 0, 0.3))})`;
          b.style.transform = `scale(${E.back(prog(t, 0.25, 0.3))})`;
          break;
        case "split":
          a.style.transform = `translateX(${(1 - E.out(prog(t, 0, 0.35))) * -1100}px)`;
          c.style.transform = `translateX(${(1 - E.out(prog(t, 0.14, 0.35))) * 1100}px)`;
          b.style.width = `${E.out(prog(t, 0.3, 0.4)) * 60}%`;
          break;
        case "type":
          a.innerHTML = typed(L1, t, 0, 0.8) + (t < 0.8 ? '<i class="caret"></i>' : "");
          b.innerHTML = typed(L2, t, 0.85, 1.1) + (t >= 0.8 ? '<i class="caret"></i>' : "");
          break;
        case "marker":
          a.style.opacity = prog(t, 0, 0.2);
          a.style.transform = `translateY(${(1 - E.out(prog(t, 0, 0.3))) * 30}px)`;
          a.querySelector(".mark").style.backgroundSize = `${E.out(prog(t, 0.3, 0.4)) * 100}% 42%`;
          b.style.opacity = prog(t, 0.55, 0.3);
          break;
        case "slam": {
          const p = E.out(prog(t, 0, 0.2));
          const shake = t > 0.2 && t < 0.45 ? Math.sin(t * 90) * 14 * (1 - prog(t, 0.2, 0.25)) : 0;
          a.style.transform = `translateX(${shake}px) scale(${lerp(2.6, 1, p)})`;
          a.style.opacity = prog(t, 0, 0.06);
          b.style.opacity = prog(t, 0.55, 0.3);
          break;
        }
        case "editorial":
          a.style.filter = `blur(${(1 - E.out(prog(t, 0, 0.6))) * 24}px)`;
          a.style.opacity = prog(t, 0, 0.45);
          b.style.opacity = prog(t, 0.45, 0.4);
          b.style.letterSpacing = `${lerp(0.5, 0.22, E.out(prog(t, 0.45, 0.8)))}em`;
          break;
        case "sticker":
          a.style.transform = `rotate(${-4 + Math.sin(t * 3) * 1.5}deg) scale(${E.back(prog(t, 0, 0.4))})`;
          break;
      }
    },
  };
}

/* ---------- Step 5: moves (camera and bars), placed across the whole clip ---------- */
// engine.js turns each pick into placements (one per impact word, cut or beat) that you approve one by one.
const MOVES = [
  { id: "punch", label: "Punch-in on impact words", sub: "Holds to the end of the shot" },
  { id: "closeup", label: "Close-up on every other cut", sub: "Wide, close, wide…" },
  { id: "whip", label: "Whip pan into each beat" },
  { id: "flash", label: "Flash on every cut" },
  { id: "shake", label: "Shake on big moments" },
  { id: "push", label: "Slow push-in", sub: "Across the whole clip" },
  { id: "progress", label: "Progress bar" },
];

/* ---------- Step 2b: text colours ---------- */
const INKS = [
  { id: "#FFFFFF", label: "White" }, { id: "#F5F3EE", label: "Cream" }, { id: "#FFE14D", label: "Yellow" }, { id: "#111111", label: "Black" },
  { id: "#E8E3D1", label: "MUSED Cream White" }, { id: "#ABBDC2", label: "MUSED Muted Blue" },
];
const ACCENTS = [
  { id: null, label: "From the grade" }, { id: "#FFD43B", label: "Yellow" }, { id: "#FF8A3D", label: "Orange" }, { id: "#FF3B5C", label: "Red" },
  { id: "#F4A9C8", label: "Pink" }, { id: "#4DA3FF", label: "Blue" }, { id: "#2EE6D6", label: "Teal" }, { id: "#3DDC84", label: "Green" },
  { id: "#FFFFFF", label: "White" },
  // MUSED palette; Anjan's pieces are blue-led.
  { id: "#87ABB5", label: "MUSED Danish Blue" }, { id: "#ABBDC2", label: "MUSED Muted Blue" },
  { id: "#A6472E", label: "MUSED Light Auburn" }, { id: "#E8E3D1", label: "MUSED Cream White" },
];

/* ---------- Line graphics for the "graphic" animation (600 x 240, hairline, quiet) ---------- */
const D = 'pathLength="1" class="d"';
const ART = {
  // demand falling away
  fall: `<path pathLength="1" class="d base" d="M40 225 H560"/><path ${D} d="M40 50 C180 48 270 70 340 120 S470 205 560 212"/><circle class="f dot" cx="560" cy="212" r="7"/>`,
  // one road splits; the quiet branch is the crowd, the bright one is his take
  fork: `<path ${D} d="M300 235 V140"/><path pathLength="1" class="d dim" d="M300 140 C300 95 230 70 150 30"/><path ${D} d="M300 140 C300 95 370 70 450 30"/><circle class="f dot" cx="450" cy="30" r="7"/>`,
  // ten sessions open at once
  grid: Array.from({ length: 10 }, (_, k) => {
    const x = 45 + (k % 5) * 106, y = 30 + Math.floor(k / 5) * 104;
    return `<g class="s"><rect x="${x}" y="${y}" width="88" height="80" rx="9"/><path d="M${x} ${y + 20} H${x + 88}"/><path d="M${x + 14} ${y + 40} H${x + 58} M${x + 14} ${y + 56} H${x + 44}" class="dim"/></g>`;
  }).join(""),
  // value climbing
  rise: `<path pathLength="1" class="d base" d="M40 225 H560"/><path ${D} d="M40 212 C180 210 270 190 340 140 S470 45 560 30"/><circle class="f dot" cx="560" cy="30" r="7"/>`,
  // a calendar stuck on 2024
  calendar: `<path ${D} d="M210 40 H390 Q402 40 402 52 V218 Q402 230 390 230 H210 Q198 230 198 218 V52 Q198 40 210 40 Z"/><path ${D} d="M198 86 H402"/><path ${D} d="M250 22 V56 M350 22 V56"/><text class="f yr" x="300" y="182" text-anchor="middle">2024</text>`,
  // a pulse that goes flat
  flat: `<path ${D} d="M20 130 H150 L180 60 L215 205 L245 95 L270 130 H580"/>`,
};

/* ---------- Step 7b: animations you place yourself, on any word ---------- */
// make(t, text, dur) returns the effect for a moment that starts at t and lasts dur (the words you selected).
// Quiet ones first (the house look); the loud ones are marked so they're never picked by accident.
const OWN = [
  { id: "word", label: "Word fades in (quiet)", field: "Text", make: (t, text, dur) =>
    ({ kind: "word", items: [{ text, at: t, hold: Math.max(dur, 1.8) }], beatEnd: t + Math.max(dur, 1.8) }) },
  { id: "glass", label: "Glass note types (quiet)", field: "Text to type", make: (t, text, dur) =>
    ({ kind: "chat", style: "glass", title: "Notes", y: 210, soundOnce: true, lines: [{ text, at: t }], until: t + Math.max(dur + 0.8, 3) }) },
  { id: "timeline", label: "Timeline (quiet)", field: "Marks | caption", placeholder: "Day 1, Day 2, Day 3 | One page website", optional: true, make: (t, text, dur) => {
    const [marks, caption = ""] = (text || "Day 1, Day 2, Day 3").split("|");
    const list = marks.split(",").map(s => s.trim()).filter(Boolean);
    return { kind: "timeline", at: t, marks: list.length > 1 ? list : ["Day 1", "Day 2", "Day 3"], caption: caption.trim(), until: t + Math.max(dur + 1.2, 3.2) };
  } },
  { id: "rise", label: "Line climbs (quiet)", field: "Caption", placeholder: "Caption (optional)", optional: true, make: (t, text, dur) =>
    ({ kind: "graphic", art: "rise", at: t, caption: text, dur: 1.4, until: t + Math.max(dur + 1, 3) }) },
  { id: "fall", label: "Line falls (quiet)", field: "Caption", placeholder: "Caption (optional)", optional: true, make: (t, text, dur) =>
    ({ kind: "graphic", art: "fall", at: t, caption: text, dur: 1.4, until: t + Math.max(dur + 1, 3) }) },
  { id: "fork", label: "Road splits (quiet)", field: "Caption", placeholder: "Caption (optional)", optional: true, make: (t, text, dur) =>
    ({ kind: "graphic", art: "fork", at: t, caption: text, dur: 1.0, until: t + Math.max(dur + 1, 2.6) }) },
  { id: "count", label: "Number counts up (quiet)", field: "Number, e.g. $1,000,000", make: (t, text, dur) => {
    const m = text.match(/^([^\d]*)([\d,.]+)(.*)$/) || ["", "", "100", ""];
    return { kind: "count", quiet: true, at: t, to: Number(m[2].replace(/,/g, "")) || 100, prefix: m[1].trim(), suffix: m[3].trim(), caption: "", until: t + Math.max(dur + 1, 2.4) };
  } },
  { id: "steps", label: "Step number (quiet)", field: "Text, e.g. 1 Know where", make: (t, text, dur) => {
    const m = text.match(/^\s*(\d+)[.)]?\s*(.*)$/);
    return { kind: "steps", quiet: true, items: [{ n: m ? m[1] : 1, text: m ? m[2] : text, at: t }], until: t + Math.max(dur + 0.8, 2.2) };
  } },
  { id: "notes", label: "Notes window types", field: "Text to type", make: (t, text, dur) =>
    ({ kind: "chat", style: "notes", title: "Notes", soundOnce: true, lines: [{ text, at: t }], until: t + Math.max(dur + 0.8, 2.5) }) },
  { id: "chat", label: "Chat window types", field: "Message", make: (t, text, dur) =>
    ({ kind: "chat", style: "chat", title: "New chat", soundOnce: true, lines: [{ text, at: t }], until: t + Math.max(dur + 0.8, 2.5) }) },
  { id: "page", label: "Wikipedia page slides in", make: (t, text, dur) => ({ kind: "page", at: t, until: t + Math.max(dur, 3) }) },
  { id: "split", label: "Split: page on top, you low", make: (t, text, dur) => ({ kind: "split", at: t, until: t + Math.max(dur, 3.5) }) },
  { id: "keyword", label: "Keyword slams in (loud)", field: "Text", make: (t, text, dur) =>
    ({ kind: "keyword", items: [{ text: text.toUpperCase(), at: t, hold: Math.max(dur, 1.2) }], beatEnd: t + Math.max(dur, 1.2) }) },
  { id: "emoji", label: "Emoji pops (loud)", field: "Emoji", placeholder: "🔥", make: (t, text) =>
    ({ kind: "emoji", items: [{ char: text || "🔥", at: t }] }) },
];

/* ---------- Step 6: sounds ---------- */
const SOUNDS = [
  { id: "whoosh", label: "Whoosh", file: "sfx/whoosh.mp3", gain: 0.5, on: "whips, punch-ins, pages sliding in" },
  { id: "pop", label: "Pop", file: "sfx/pop.mp3", gain: 0.55, on: "keywords, emoji, titles" },
  { id: "ping", label: "Ping", file: "sfx/ping.mp3", gain: 0.45, on: "numbers landing, steps" },
  { id: "typing", label: "Typing", file: "sfx/typing.mp3", gain: 0.45, on: "chat and notes windows" },
  { id: "click", label: "Click", file: "sfx/click.mp3", gain: 0.5, on: "flashes, shakes, highlights" },
  { id: "music", label: "Soft music bed", file: "sfx/music-bed.mp3", gain: 0.13, on: "under the whole clip" },
];

/* ---------- Effects: animations (step 7) and the moves above ---------- */
function makeEffect(o, ctx) {
  if (o.kind === "hook") return makeHook(o);
  let node, nodes = [];
  const fx = { sounds: [], mount(layer) { if (node) layer.appendChild(node); nodes.forEach(n => layer.appendChild(n)); }, update() {} };
  const visible = (t, a, b) => t >= a && t < b;

  switch (o.kind) {
    case "word":
    case "keyword": {
      // "word" is the quiet version: it surfaces out of a soft blur, tracking settling in, no pop, no sound.
      const quiet = o.kind === "word";
      // Hold 1.5 s, but end with the beat (never sooner than 0.6 s) so a keyword doesn't spill into the next one.
      const items = o.items.map((it, i) => ({ ...it, end: Math.min(o.items[i + 1]?.at ?? Infinity, it.cutAt ?? o.cutAt ?? Infinity,
        Math.max(Math.min(it.at + (it.hold ?? (quiet ? 2 : 1.5)), o.beatEnd ?? Infinity), it.at + 0.6)) }));
      nodes = items.map(it => {
        const size = quiet ? Math.min(92, 820 / (it.text.length * 0.68)) : Math.min(118, 980 / (it.text.length * 0.6));
        return el(quiet ? "kw kw-quiet t-title" : "kw t-title", esc(it.text), `font-size:${size}px`);
      });
      fx.sounds = quiet ? [] : items.map(it => ({ kind: "pop", t: it.at }));
      fx.update = t => items.forEach((it, i) => {
        const n = nodes[i], on = visible(t, it.at, it.end);
        n.style.display = on ? "" : "none";
        if (!on) return;
        if (quiet) {
          const p = E.out(prog(t, it.at, 0.8));
          n.style.transform = `translate(-50%,-50%) translateY(${(1 - p) * 18 + ctx.split(t) * SPLIT_DROP}px)`;
          n.style.filter = `blur(${(1 - p) * 12}px)`;
          n.style.letterSpacing = `${lerp(0.3, 0.08, p)}em`;
          n.style.opacity = Math.min(prog(t, it.at, 0.6), 1 - prog(t, it.end - 0.4, 0.4));
          return;
        }
        const p = E.out(prog(t, it.at, 0.18));
        const jitter = t - it.at < 0.38 ? Math.sin((t - it.at) * 90) * 9 * (1 - prog(t, it.at + 0.18, 0.2)) : 0;
        n.style.transform = `translate(-50%,-50%) translate(${jitter}px,${ctx.split(t) * SPLIT_DROP}px) scale(${lerp(2.3, 1, p)})`;
        n.style.opacity = Math.min(prog(t, it.at, 0.06), 1 - prog(t, it.end - 0.15, 0.15));
      });
      break;
    }
    case "count": {
      const dur = o.dur ?? (o.quiet ? 1.6 : 1.1);
      node = o.quiet
        ? el("count count-quiet", `<div class="count-num t-title"></div><div class="count-label t-cap">${esc(o.caption || "")}</div>`)
        : el("count", `<div class="count-label t-cap">${esc(o.caption || "")}</div><div class="count-num t-title"></div>`);
      const num = node.querySelector(".count-num");
      fx.sounds = o.quiet ? [] : [{ kind: "pop", t: o.at }, { kind: "ping", t: o.at + dur }];
      fx.update = t => {
        const end = Math.min(o.until, o.cutAt ?? Infinity), on = visible(t, o.at, end);
        node.style.display = on ? "" : "none";
        if (!on) return;
        const v = Math.round(lerp(o.from ?? 0, o.to, E.out(prog(t, o.at, dur))));
        num.textContent = (o.prefix || "") + v.toLocaleString("en-US") + (o.suffix || "");
        if (o.quiet) {
          const p = E.out(prog(t, o.at, 0.7));
          node.style.transform = `translate(-50%,-50%) translateY(${(1 - p) * 18 + ctx.split(t) * SPLIT_DROP}px)`;
          node.style.filter = `blur(${(1 - p) * 10}px)`;
          node.style.opacity = Math.min(prog(t, o.at, 0.5), 1 - prog(t, end - 0.4, 0.4));
          return;
        }
        const land = t > o.at + dur ? 1 + 0.12 * (1 - prog(t, o.at + dur, 0.25)) : 1;
        node.style.transform = `translate(-50%,-50%) translateY(${ctx.split(t) * SPLIT_DROP}px) scale(${E.back(prog(t, o.at, 0.3)) * land})`;
      };
      break;
    }
    case "steps": {
      node = el(o.quiet ? "steps steps-quiet" : "steps", `<div class="steps-n t-title"></div><div class="steps-t t-cap"></div>`);
      const [n, txt] = node.children;
      fx.sounds = o.quiet ? [] : o.items.slice(0, o.soundOnce ? 1 : undefined).map(it => ({ kind: "ping", t: it.at }));
      fx.update = t => {
        const cur = [...o.items].reverse().find(it => t >= it.at);
        const end = Math.min(o.until, o.cutAt ?? Infinity), on = cur && t < end;
        node.style.display = on ? "" : "none";
        if (!on) return;
        n.textContent = o.quiet ? String(cur.n).padStart(2, "0") : cur.n;
        txt.textContent = cur.text;
        if (o.quiet) {
          const p = E.out(prog(t, cur.at, 0.6));
          node.style.transform = `translate(-50%,-50%) translateY(${(1 - p) * 12 + ctx.split(t) * SPLIT_DROP}px)`;
          node.style.filter = `blur(${(1 - p) * 8}px)`;
          node.style.opacity = Math.min(prog(t, cur.at, 0.45), 1 - prog(t, end - 0.4, 0.4));
          return;
        }
        node.style.transform = `translate(-50%,-50%) translateY(${ctx.split(t) * SPLIT_DROP}px) scale(${E.back(prog(t, cur.at, 0.28))})`;
      };
      break;
    }
    case "emoji": {
      const spots = [[870, 600], [210, 600]]; // beside the head, clear of keywords above it
      nodes = o.items.map((it, i) => el("emoji", esc(it.char), `left:${spots[i % 2][0]}px;top:${spots[i % 2][1]}px`));
      fx.sounds = o.items.map(it => ({ kind: "pop", t: it.at }));
      fx.update = t => o.items.forEach((it, i) => {
        const n = nodes[i], on = visible(t, it.at, it.at + 1.5);
        n.style.display = on ? "" : "none";
        if (!on) return;
        const s = E.back(prog(t, it.at, 0.3)) * (1 - prog(t, it.at + 1.25, 0.25));
        n.style.transform = `translate(-50%,-50%) translateY(${-70 * prog(t, it.at, 1.5) + ctx.split(t) * SPLIT_DROP}px) rotate(${lerp(-25, 0, E.out(prog(t, it.at, 0.4)))}deg) scale(${s})`;
      });
      break;
    }
    case "graphic": {
      // Hairline drawings that draw themselves on (.d), appear one by one (.s) or fade in at the end (.f).
      const dur = o.dur ?? 1.1;
      node = el("gfx", `<svg viewBox="0 0 600 240" width="520" height="208">${ART[o.art] || ""}</svg>` +
        (o.caption ? `<div class="gfx-cap t-cap">${esc(o.caption)}</div>` : ""));
      const draws = [...node.querySelectorAll(".d")], steps = [...node.querySelectorAll(".s")], fades = [...node.querySelectorAll(".f")];
      const cap = node.querySelector(".gfx-cap");
      fx.update = t => {
        const end = Math.min(o.until ?? o.at + 2.4, o.cutAt ?? Infinity), on = visible(t, o.at, end);
        node.style.display = on ? "" : "none";
        if (!on) return;
        node.style.opacity = Math.min(prog(t, o.at, 0.35), 1 - prog(t, end - 0.4, 0.4));
        node.style.transform = `translate(-50%,-50%) translateY(${ctx.split(t) * SPLIT_DROP}px)`;
        draws.forEach((d, k) => { d.style.strokeDashoffset = 1 - E.out(prog(t, o.at + k * 0.18, dur)); });
        steps.forEach((s, k) => { s.style.opacity = E.out(prog(t, o.at + (k * dur) / steps.length, 0.3)); });
        fades.forEach(f => { f.style.opacity = E.out(prog(t, o.at + dur * 0.7, 0.5)); });
        if (cap) cap.style.opacity = E.out(prog(t, o.at + 0.3, 0.6));
      };
      break;
    }
    case "timeline": {
      // A hairline that draws across, a dot lighting at each mark (Day 1 → Day 3), then a serif caption.
      const marks = o.marks || ["Day 1", "Day 2", "Day 3"], dur = o.dur ?? 1.6, last = marks.length - 1;
      const dot = k => o.at + (dur * k) / last;
      const capAt = o.captionAt ?? o.at + dur + 0.2;
      node = el("tl", `<div class="tl-track"><i class="tl-line"></i>${marks.map((m, k) =>
        `<span class="tl-mark" style="left:${(k / last) * 100}%"><i class="tl-dot"></i><b class="tl-label t-cap">${esc(m)}</b></span>`).join("")}</div>` +
        `<div class="tl-cap t-title">${esc(o.caption || "")}</div>`);
      const line = node.querySelector(".tl-line"), ms = [...node.querySelectorAll(".tl-mark")], cap = node.querySelector(".tl-cap");
      fx.update = t => {
        const end = Math.min(o.until, o.cutAt ?? Infinity), on = visible(t, o.at - 0.3, end);
        node.style.display = on ? "" : "none";
        if (!on) return;
        node.style.opacity = Math.min(prog(t, o.at - 0.3, 0.4), 1 - prog(t, end - 0.4, 0.4));
        node.style.transform = `translate(-50%,-50%) translateY(${ctx.split(t) * SPLIT_DROP}px)`;
        line.style.transform = `scaleX(${prog(t, o.at, dur)})`;
        ms.forEach((m, k) => {
          const p = E.out(prog(t, dot(k), 0.4));
          m.style.opacity = 0.25 + 0.75 * p;
          m.firstChild.style.transform = `scale(${lerp(0.4, 1, p)})`;
        });
        const c = E.out(prog(t, capAt, 0.7));
        cap.style.opacity = c;
        cap.style.filter = `blur(${(1 - c) * 8}px)`;
        cap.style.transform = `translateY(${(1 - c) * 12}px)`;
      };
      break;
    }
    case "punch":
      fx.sounds = o.silent ? [] : [{ kind: "whoosh", t: o.at }];
      fx.cam = (t, c) => {
        if (visible(t, o.at, o.until)) c.s *= 1 + (o.scale ?? 0.15) * (o.snap ? 1 : E.out(prog(t, o.at, 0.12)));
      };
      break;
    case "whip":
      fx.sounds = [{ kind: "whoosh", t: Math.max(0, o.at - 0.04) }];
      fx.cam = (t, c) => {
        if (!visible(t, o.at, o.at + 0.32)) return;
        const p = E.out(prog(t, o.at, 0.32));
        c.x += (1 - p) * -1000;
        c.blur = Math.max(c.blur, (1 - p) * 30);
      };
      break;
    case "shake":
      fx.sounds = [{ kind: "click", t: o.at }];
      fx.cam = (t, c) => {
        if (!visible(t, o.at, o.at + 0.5)) return;
        const k = 1 - prog(t, o.at, 0.5);
        c.x += Math.sin(t * 95) * 24 * k;
        c.y += Math.cos(t * 123) * 18 * k;
      };
      break;
    case "flash":
      node = el("flash");
      fx.sounds = [{ kind: "click", t: o.at }];
      fx.update = t => { node.style.opacity = visible(t, o.at, o.at + 0.3) ? 0.85 * (1 - E.out(prog(t, o.at, 0.3))) : 0; };
      break;
    case "page":
    case "highlight": {
      const pg = ctx.page, w = 400, sc = w / pg.width;
      const bars = o.kind === "highlight" ? pg.highlight.map(r =>
        `<i class="hl" style="left:${r.x * sc}px;top:${r.y * sc}px;width:${r.w * sc}px;height:${r.h * sc}px"></i>`).join("") : "";
      node = el("page-card", `<img src="${pg.src}" alt="${esc(pg.url)}" style="width:${w}px">${bars}`);
      const his = [...node.querySelectorAll(".hl")];
      fx.sounds = [{ kind: "whoosh", t: o.at }, ...(o.hl != null ? [{ kind: "click", t: o.hl }] : [])];
      fx.update = t => {
        const on = visible(t, o.at, o.until);
        node.style.display = on ? "" : "none";
        if (!on) return;
        const x = (1 - E.back(prog(t, o.at, 0.45))) * 560 + E.out(prog(t, o.until - 0.3, 0.3)) * 560;
        node.style.transform = `translateX(${x}px) rotate(3deg)`;
        his.forEach((h, k) => { h.style.transform = `scaleX(${E.out(prog(t, o.hl + k * 0.35, 0.35))})`; });
      };
      break;
    }
    case "split": {
      const pg = ctx.page, w = 900, sc = w / pg.width;
      node = el("split-page", `<img src="${pg.src}" alt="${esc(pg.url)}" style="width:${w}px;margin-top:${-150 * sc}px">`);
      fx.sounds = [{ kind: "whoosh", t: o.at }];
      const mix = t => splitMix(o, t);
      fx.cam = (t, c) => { const m = mix(t); if (!m) return; c.s *= lerp(1, 0.58, m); c.y += 487 * m; c.round = Math.max(c.round, 60 * m); };
      fx.update = t => {
        const m = mix(t);
        node.style.display = m ? "" : "none";
        node.style.transform = `translateY(${(1 - m) * -760}px)`;
      };
      break;
    }
    case "chat": {
      const lines = o.lines.map(l => `<div class="chat-line"></div>`).join("");
      const head = o.style === "notes"
        ? `<div class="win-bar"><i></i><i></i><i></i><span>${esc(o.title)}</span></div>`
        : `<div class="win-bar ${o.style === "glass" ? "glass" : "chat"}"><span>${esc(o.title)}</span></div>`;
      node = el(`win win-${o.style} t-cap`, `${head}<div class="win-body">${lines}</div>${o.style === "chat" ? '<div class="send"></div>' : ""}`);
      if (o.y != null) node.style.top = `${o.y}px`; // keep it off the face: clips frame the head differently
      const rows = [...node.querySelectorAll(".chat-line")];
      const start = o.lines[0].at - 0.35;
      const glass = o.style === "glass";
      // Typing is always quick: every line is done in 0.7 s or less.
      const cps = l => Math.max(45, l.text.length / 0.7);
      // soundOnce: one cue on the first line instead of one per line.
      fx.sounds = o.lines.slice(0, o.soundOnce ? 1 : undefined).map(l => ({ kind: "typing", t: l.at }));
      fx.update = t => {
        const on = visible(t, start, o.until);
        node.style.display = on ? "" : "none";
        if (!on) return;
        node.style.transform = glass
          ? `translateY(${(1 - E.out(prog(t, start, 0.6))) * 20}px)`
          : `translateY(${(1 - E.back(prog(t, start, 0.35))) * 60}px) scale(${lerp(0.9, 1, E.out(prog(t, start, 0.3)))})`;
        node.style.opacity = glass ? prog(t, start, 0.45) * (1 - prog(t, o.until - 0.4, 0.4))
          : prog(t, start, 0.2) * (1 - prog(t, o.until - 0.2, 0.2));
        o.lines.forEach((l, k) => {
          const n = t < l.at ? 0 : Math.min(l.text.length, Math.floor((t - l.at) * cps(l)));
          const typing = n > 0 && n < l.text.length || (n === 0 && k === 0);
          rows[k].innerHTML = esc(l.text.slice(0, n)) + (typing || (k === o.lines.length - 1 && n === l.text.length) ? '<i class="caret"></i>' : "");
          rows[k].style.display = t >= l.at || k === 0 ? "" : "none";
        });
      };
      break;
    }
    case "progress":
      node = el("progress");
      fx.update = t => { node.style.width = `${(t / ctx.duration) * 100}%`; };
      break;
    case "push":
      fx.cam = (t, c) => { c.s *= 1 + 0.08 * (t / ctx.duration); };
      break;
    case "soundmark": {
      node = el("soundmark", `<span>♪</span>`);
      fx.update = t => {
        const hit = o.times.some(x => t >= x && t < x + 0.4);
        node.classList.toggle("hit", hit);
      };
      break;
    }
  }
  return fx;
}
