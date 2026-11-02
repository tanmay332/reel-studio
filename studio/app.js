/* Reel Studio: steps, option cards, the "where it appears" approval lists, the big preview,
   sound, rendering and saving. Looks live in looks.js; engine.js turns picks into placements. */

const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const fmtT = s => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;

const STEPS = [
  { id: "colours", label: "Colours", help: "Pick a colour grade. Every card plays your clip with that grade on it.", done: p => !!p.grade },
  { id: "fonts", label: "Fonts", help: "Pick a font pair: titles and keywords use the first, captions the second.", done: p => !!p.font },
  { id: "captions", label: "Captions", help: "Pick a caption style. Each one is timed to your real words.", done: p => !!p.caption },
  { id: "hook", label: "Hook", help: "Pick the title for the first 3 seconds, or keep it to just you.", done: p => !!p.hook },
  { id: "moves", label: "Moves", help: "Pick camera moves. Each one lands in several places: approve every place below.", done: p => p.moves.length > 0 },
  { id: "sound", label: "Sound", help: "Pick which sounds play, then approve every place a sound lands. Click a time to hear it in the preview.", done: p => p.sounds.length > 0 },
  { id: "anims", label: "Animations", help: "Add animations beat by beat. Tick as many as you like, then approve each one below.", done: p => Object.keys(p.anims).length > 0 },
  { id: "watch", label: "Watch", help: "Check the full map of what appears where, render the reel and save this as your style.", done: () => state.saved },
];
const GROUP_LABEL = { hook: "Hook", moves: "Move", anims: "Animation" };
// What a sound card shows when nothing picked so far makes that sound.
const EXEMPLAR = {
  whoosh: { moves: ["whip"] }, pop: { anims: { b2: ["b2-keyword"] } }, ping: { anims: { b2: ["b2-count"] } },
  typing: { anims: { b3: ["b3-chat"] } }, click: { moves: ["flash"] },
};

const postJson = (url, body) => fetch(url, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
}).then(async r => ({ status: r.status, ...(await r.json().catch(() => ({}))) }));
const api = window.studioApi || {
  canRender: true,
  savedTo: name => `editing-studio/styles/${name}.json`,
  styles: () => fetch("/api/styles").then(r => r.json()).catch(() => []),
  save: body => postJson("/api/save", body),
  render: body => postJson("/api/render", body),
  renderStatus: () => fetch("/api/render/status").then(r => r.json()).catch(() => null),
  approve: file => postJson("/api/approve", { file }),
  reveal: file => postJson("/api/reveal", { file }),
  clips: () => fetch("/api/clips").then(r => r.json()).catch(() => []),
  importStart: body => postJson("/api/import", body),
  importStatus: project => fetch(`/api/import/status?project=${encodeURIComponent(project)}`).then(r => r.json()).catch(() => null),
  importCut: body => postJson("/api/import/cut", body),
};

// Picks are kept per clip in this browser, so a refresh or a clip switch never loses work.
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
const picksKey = () => `studio.picks.${clip.name}`;
let saveTimer;
function autosave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (state.demo) return; // the D demo plays with throwaway picks
    store.set(picksKey(), state.picks);
    $("#savedNote").textContent = "Saved in this browser";
  }, 400);
}

function switchClip(data) {
  try { localStorage.setItem("studio.data", data); } catch {}
  location.href = `${location.pathname}?data=${encodeURIComponent(data)}`;
}

// The house look (quiet luxury) that a new clip opens with: only the look, never another clip's animations.
const LOOK_KEYS = ["grade", "font", "caption", "ink", "accent", "hook", "moves", "sounds"];

const state = { step: 0, beat: "b2", picks: emptyPicks(), raw: false, sound: false, saved: false, demo: false };
let styles = [], big;

/* ---------- sound ---------- */
const audio = {
  ctx: null, buf: {}, bedSrc: null, loading: null,
  init() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.loading = Promise.all(SOUNDS.map(async s => {
        try { this.buf[s.id] = await this.ctx.decodeAudioData(await (await fetch(s.file)).arrayBuffer()); } catch (e) { console.warn(s.file, e); }
      }));
    }
    this.ctx.resume();
    return this.loading;
  },
  play(id, boost = 1) {
    if (!this.ctx || !this.buf[id]) return null;
    const s = SOUNDS.find(x => x.id === id);
    const src = this.ctx.createBufferSource(), g = this.ctx.createGain();
    src.buffer = this.buf[id];
    g.gain.value = s.gain * boost;
    src.connect(g).connect(this.ctx.destination);
    src.start();
    return src;
  },
  bed(on) {
    if (on && !this.bedSrc && this.buf.music) {
      this.bedSrc = this.play("music");
      this.bedSrc.loop = true;
    } else if (!on && this.bedSrc) {
      this.bedSrc.stop();
      this.bedSrc = null;
    }
  },
  preview(id) {
    this.init().then(() => {
      if (id !== "music") return this.play(id, 1.4);
      const src = this.play("music", 3.5);
      setTimeout(() => src?.stop(), 4000);
    });
  },
};

/* ---------- UI helpers ---------- */
let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("on"), 1900);
}

function h3(text) { const h = document.createElement("h3"); h.textContent = text; return h; }
function grid(cards) { const g = el("grid"); cards.forEach(c => g.appendChild(c)); return g; }
const toggle = (list, id) => (list.includes(id) ? list.filter(x => x !== id) : [...list, id]);

function card({ n, label, sub, spec, win, isPicked = () => false, clean = false, onPick }) {
  const b = document.createElement("button");
  b.className = "card" + (clean ? " clean" : "");
  b.innerHTML = `<div class="player"></div><span class="badge">${n}</span><span class="picked-tag">Picked</span>` +
    `<div class="label">${esc(label)}${sub ? `<span class="sub">${esc(sub)}</span>` : ""}</div>`;
  b.isPicked = isPicked;
  b.classList.toggle("picked", isPicked());
  const p = new Player($(".player", b), { src: clip.proxy });
  p.setSpec(spec);
  p.setWindow(win[0], win[1]);
  p.video.play().catch(() => {});
  b.addEventListener("click", () => { onPick(); changed(); });
  return b;
}

const around = (t, before = 0.7, after = 2.6) => [Math.max(0, t - before), Math.min(clip.duration, t + after)];

function optWindow(o, b) {
  const times = [o.at, o.hl, ...(o.items || []).map(i => i.at), ...(o.lines || []).map(l => l.at)].filter(x => x != null);
  const first = Math.min(...times), last = Math.max(...times);
  let a = Math.max(b.start, first - 0.7);
  let e = Math.min(b.end, Math.max(last + 2.0, a + 2.6));
  if (e - a > 5.5) e = a + 5.5;
  if (e - a < 2) a = Math.max(b.start, e - 2.4);
  return [a, e];
}

const beatById = id => beats.find(b => b.id === id);
function beatPicksText(b) {
  const ids = state.picks.anims[b.id] || [];
  if (ids[0] === "none") return "Just you";
  return ids.map(id => b.options.find(o => o.id === id)?.label).join(" + ");
}

function seekBig(t) {
  big.setWindow(null);
  big.video.currentTime = Math.max(0, t - 0.6);
  big.video.play().catch(() => {});
}

/* ---------- "where it appears": every placement with Yes / No and its sound ---------- */
const panels = new Set();

function wherePanel(groups, { title = "Where it appears", soundOnly = false, empty = "Pick something above to see where it lands." } = {}) {
  const wrap = el("where");
  const draw = () => {
    const p = state.picks;
    let list = placements(p).filter(pl => groups.includes(pl.group));
    if (soundOnly) list = list.filter(pl => pl.sounds.length);
    const on = list.filter(pl => (soundOnly ? pl.on && pl.sound : pl.on)).length;
    const markers = list.map(pl => {
      const live = soundOnly ? pl.on && pl.sound : pl.on;
      return `<i class="mk g-${pl.group} ${live ? "" : "no"}" style="left:${(pl.t / clip.duration) * 100}%" data-seek="${pl.t}" title="${esc(fmtT(pl.t))} ${esc(pl.label)}"></i>`;
    }).join("");
    const segs = beats.map(b => `<span style="flex:${b.end - b.start}">${esc(b.label)}</span>`).join("");
    const rows = list.map(pl => {
      const kinds = [...new Set(pl.sounds.map(s => s.kind))];
      const disabled = kinds.filter(k => !p.sounds.includes(k));
      const yes = soundOnly ? pl.sound : pl.on;
      const sound = !soundOnly && kinds.length
        ? `<button class="psnd ${pl.sound ? "on" : ""}" data-mute="${esc(pl.id)}" title="Sound for this placement">♪ ${esc(kinds.join(", "))}</button>` : "";
      const note = soundOnly && disabled.length ? `<small class="warn">${esc(disabled.join(", "))} is off in the cards above</small>` : "";
      return `<div class="prow ${yes && pl.on ? "" : "is-no"}">
        <button class="ptime" data-seek="${pl.t}" title="Play from here">${fmtT(pl.t)}</button>
        <span class="plabel"><b>${soundOnly ? `♪ ${esc(kinds.join(" + "))}` : ""}${soundOnly ? " · " : ""}${esc(pl.label)}</b>
          <small>${esc(GROUP_LABEL[pl.group])} · “${esc(pl.words)}…”</small>${note}</span>
        ${sound}
        ${pl.custom && !soundOnly ? `<button class="pdel" data-del="${esc(pl.id)}" title="Remove this animation">Remove</button>` : ""}
        <span class="yn" role="group">
          <button class="${yes ? "on" : ""}" data-yes="${esc(pl.id)}">Yes</button><button class="${yes ? "" : "on"}" data-no="${esc(pl.id)}">No</button>
        </span>
      </div>`;
    }).join("");
    wrap.innerHTML = `
      <h3>${esc(title)} <span class="where-count">${list.length ? `${on} of ${list.length} on` : ""}</span></h3>
      ${list.length ? `<div class="track"><div class="track-beats">${segs}</div>${markers}</div><div class="prows">${rows}</div>` : `<p class="note">${esc(empty)}</p>`}`;
  };
  wrap.addEventListener("click", e => {
    const t = e.target.closest("[data-seek]");
    if (t) return seekBig(+t.dataset.seek);
    const p = state.picks;
    const yes = e.target.closest("[data-yes]")?.dataset.yes, no = e.target.closest("[data-no]")?.dataset.no;
    const mute = e.target.closest("[data-mute]")?.dataset.mute;
    const del = e.target.closest("[data-del]")?.dataset.del;
    if (del) {
      p.custom = p.custom.filter(c => `custom:${c.id}` !== del);
      toast("Removed");
      return changed();
    }
    const field = soundOnly ? "mute" : "off";
    if (yes) p[field] = p[field].filter(x => x !== yes);
    else if (no && !p[field].includes(no)) p[field] = [...p[field], no];
    else if (mute) p.mute = toggle(p.mute, mute);
    else return;
    changed();
  });
  wrap.draw = draw;
  panels.add(wrap);
  draw();
  return wrap;
}

/* ---------- steps ---------- */
function stepColours(body) {
  const p = state.picks;
  if (styles.length) {
    body.appendChild(h3("Your styles"));
    body.appendChild(grid(styles.map((s, i) => card({
      n: i + 1, label: s.name, sub: "Saved style", spec: compose(migratePicks(s.picks)), win: [0, 6],
      onPick: () => applyStyle(s),
    }))));
    body.appendChild(h3("Colour grades"));
  }
  body.appendChild(grid(GRADES.map((g, i) => card({
    n: i + 1, label: g.label, spec: compose(p, { grade: g.id }), win: [3.45, 7.2],
    isPicked: () => state.picks.grade === g.id,
    onPick: () => { state.picks.grade = g.id; toast(`Colour: ${g.label}`); },
  }))));
}

function swatches(title, list, key, fallback) {
  const wrap = el("swatches");
  const cur = state.picks[key];
  const custom = cur && !list.some(x => x.id === cur);
  wrap.innerHTML = `<h3>${esc(title)}</h3><div class="sw-row">${list.map(x => `
    <button class="sw ${cur === x.id ? "on" : ""}" data-c="${x.id ?? ""}" title="${esc(x.label)}">
      <i style="background:${x.id || fallback()}"></i><span>${esc(x.label)}</span></button>`).join("")}
    <label class="sw ${custom ? "on" : ""}" title="Any colour"><input type="color" value="${custom ? cur : "#ffffff"}"><span>Custom</span></label></div>`;
  wrap.addEventListener("click", e => {
    const b = e.target.closest("button.sw");
    if (!b) return;
    state.picks[key] = b.dataset.c || null;
    toast(`${title}: ${b.title}`);
    render();
  });
  wrap.addEventListener("change", e => {
    if (e.target.type !== "color") return;
    state.picks[key] = e.target.value.toUpperCase();
    toast(`${title}: ${state.picks[key]}`);
    render();
  });
  return wrap;
}

function stepFonts(body) {
  const p = state.picks;
  const grade = () => (GRADES.find(g => g.id === state.picks.grade) || GRADES[0]).accent;
  body.appendChild(swatches("Text colour", INKS, "ink", () => "#FFFFFF"));
  body.appendChild(swatches("Highlight colour", ACCENTS, "accent", grade));
  body.appendChild(h3("Font pairs"));
  body.appendChild(grid(FONTS.map((f, i) => card({
    n: i + 1, label: f.label, sub: f.sub, spec: compose(p, { font: f.id, caption: p.caption || "chunk", hook: p.hook && p.hook !== "none" ? p.hook : "launch" }), win: [0, 3.4],
    isPicked: () => state.picks.font === f.id,
    onPick: () => { state.picks.font = f.id; toast(`Fonts: ${f.label}`); },
  }))));
}

function stepCaptions(body) {
  const p = state.picks;
  body.appendChild(grid(CAPTIONS.map((c, i) => card({
    n: i + 1, label: c.label, spec: compose(p, { caption: c.id }), win: [3.45, 7.6],
    isPicked: () => state.picks.caption === c.id,
    onPick: () => { state.picks.caption = c.id; toast(`Synced captions to ${clip.words.length} words`); },
  }))));
}

function hookEditor() {
  const wrap = el("own hook-edit");
  const cur = hookText(state.picks).lines;
  wrap.innerHTML = `<h3>Hook text</h3>
    <div class="own-form"><input id="hookL1" placeholder="Line 1 (the big title)" value="${esc(cur[0] || "")}">
    <input id="hookL2" placeholder="Line 2 (smaller, optional)" value="${esc(cur[1] || "")}">
    <button class="btn" id="hookReset" title="Back to the line planned for this clip">Reset</button></div>
    <p class="note">Type your own title; the cards and the render use it. Press Enter or click away to see it.</p>`;
  const apply = () => {
    state.picks.hookLines = [$("#hookL1").value.trim(), $("#hookL2").value.trim()];
    if (!state.picks.hook || state.picks.hook === "none") state.picks.hook = "editorial";
    render();
  };
  wrap.addEventListener("change", e => { if (e.target.matches("input")) apply(); });
  wrap.addEventListener("keydown", e => { if (e.key === "Enter") e.target.blur(); });
  wrap.addEventListener("click", e => {
    if (e.target.id !== "hookReset") return;
    state.picks.hookLines = null;
    render();
  });
  return wrap;
}

function stepHook(body) {
  body.appendChild(hookEditor());
  const p = state.picks, b = beats.find(x => x.hook);
  const cards = HOOKS.map((h, i) => card({
    n: i + 1, label: h.label, sub: h.sub, spec: compose(p, { hook: h.id }), win: [b.start, b.end],
    isPicked: () => state.picks.hook === h.id,
    onPick: () => { state.picks.hook = h.id; toast(`Hook: ${h.label}`); },
  }));
  cards.push(card({
    n: HOOKS.length + 1, label: "Just you", sub: "No title", clean: true, spec: compose(p, { hook: "none" }), win: [b.start, b.end],
    isPicked: () => state.picks.hook === "none",
    onPick: () => { state.picks.hook = "none"; toast("Hook: just you"); },
  }));
  body.append(grid(cards), wherePanel(["hook"], { empty: "Pick a title above, or Just you." }));
}

function stepMoves(body) {
  const p = state.picks;
  body.appendChild(grid(MOVES.map((m, i) => {
    const first = movePlacements(m.id)[0];
    const win = ["push", "progress"].includes(m.id) ? [3.45, 9.5] : around(first?.t ?? 0, 0.6, 2.4);
    return card({
      n: i + 1, label: m.label, sub: m.sub, spec: compose(p, { moves: [m.id] }), win,
      isPicked: () => state.picks.moves.includes(m.id),
      onPick: () => {
        const on = !state.picks.moves.includes(m.id);
        state.picks.moves = toggle(state.picks.moves, m.id);
        const n = movePlacements(m.id).length;
        toast(on ? `${m.label}: ${n} place${n === 1 ? "" : "s"} to approve below` : `${m.label} off`);
      },
    });
  })));
  body.appendChild(wherePanel(["moves"], { empty: "Pick a move above to see every place it lands." }));
}

function stepSound(body) {
  const p = state.picks;
  const current = soundEvents(compose(p));
  body.appendChild(grid(SOUNDS.map((s, i) => {
    let o = {}, times;
    if (s.id === "music") {
      times = Array.from({ length: 60 }, (_, k) => k * (60 / 84));
    } else {
      times = current.filter(e => e.kind === s.id).map(e => e.t);
      if (!times.length) {
        o = EXEMPLAR[s.id];
        times = soundEvents(compose(p, o)).filter(e => e.kind === s.id).map(e => e.t);
      }
    }
    const t0 = s.id === "music" ? 3.45 : times[0] ?? 0;
    const win = s.id === "music" ? [3.45, 9] : [Math.max(0, t0 - 0.9), Math.min(clip.duration, t0 + 1.7)];
    return card({
      n: i + 1, label: s.label, sub: `On ${s.on}`, spec: compose(p, { ...o, extra: [{ kind: "soundmark", times }] }), win,
      isPicked: () => state.picks.sounds.includes(s.id),
      onPick: () => {
        const on = !state.picks.sounds.includes(s.id);
        state.picks.sounds = toggle(state.picks.sounds, s.id);
        if (on) {
          audio.preview(s.id);
          setSound(true); // so the big preview plays your picks straight away
        }
        const n = soundEvents(compose(state.picks)).filter(e => e.kind === s.id).length;
        toast(!on ? `${s.label} off` : s.id === "music" ? "Music bed under your voice"
          : n ? `${s.label} on ${n} move${n === 1 ? "" : "s"}` : `${s.label} on: it plays when you add a move or animation that uses it`);
      },
    });
  })));
  body.appendChild(wherePanel(["hook", "moves", "anims"], {
    title: "Sound map", soundOnly: true,
    empty: "No moves with sounds yet. Pick a hook or moves first; animations add their sounds when you add them.",
  }));
}

const PHRASE_KINDS = ["word", "glass", "keyword", "notes", "chat"];

function ownPanel() {
  const wrap = el("own");
  const sel = state.sel || (state.sel = { a: null, b: null, kind: "keyword", text: "" });
  const range = () => [Math.min(sel.a, sel.b), Math.max(sel.a, sel.b)];
  const draw = () => {
    const words = clip.words;
    const [lo, hi] = sel.a == null ? [-1, -1] : range();
    const busy = new Set(placements(state.picks).filter(pl => pl.group === "anims").map(pl => wordAt(pl.t)));
    const kind = OWN.find(k => k.id === sel.kind);
    const picked = lo < 0 ? "" : words.slice(lo, hi + 1).map(w => bare(w.word)).join(" ");
    wrap.innerHTML = `
      <h3>Add an animation where you want it</h3>
      <p class="note">1. Click a word (shift-click to select a phrase). 2. Choose what appears and its text. 3. Add. A green dot means that word already has an animation.</p>
      <div class="words">${words.map((w, i) => `<button class="wd ${i >= lo && i <= hi ? "on" : ""} ${busy.has(w) ? "busy" : ""}" data-i="${i}" title="${fmtT(w.start)}">${esc(w.word)}</button>`).join(" ")}</div>
      <div class="own-form">
        <span class="own-at">${lo < 0 ? "Pick a word first" : `At ${fmtT(words[lo].start)} · “${esc(picked)}”`}</span>
        <select id="ownKind">${OWN.map(k => `<option value="${k.id}" ${k.id === sel.kind ? "selected" : ""}>${esc(k.label)}</option>`).join("")}</select>
        ${kind.field ? `<input id="ownText" placeholder="${esc(kind.placeholder || kind.field)}" value="${esc(sel.text)}">` : ""}
        <button class="btn primary" id="ownAdd" ${lo < 0 ? "disabled" : ""}>Add</button>
      </div>`;
  };
  wrap.addEventListener("click", e => {
    const w = e.target.closest(".wd");
    if (w) {
      const i = +w.dataset.i;
      if (e.shiftKey && sel.a != null) sel.b = i; else { sel.a = i; sel.b = i; }
      const [lo, hi] = range();
      if (PHRASE_KINDS.includes(sel.kind)) sel.text = clip.words.slice(lo, hi + 1).map(x => bare(x.word)).join(" ");
      draw();
      seekBig(clip.words[lo].start);
      return;
    }
    if (e.target.id !== "ownAdd") return;
    const [lo, hi] = range();
    const t = clip.words[lo].start, dur = Math.max(clip.words[hi].end - t, 0.6);
    const kind = OWN.find(k => k.id === sel.kind);
    const text = (sel.text || "").trim();
    if (kind.field && !text && !kind.placeholder && !kind.optional) return toast(`Type the ${kind.field.toLowerCase()} first`);
    const shown = text || (kind.optional ? "" : kind.placeholder || "");
    state.picks.custom = [...state.picks.custom,
      { id: Date.now().toString(36), own: kind.id, label: `${kind.label}${shown ? `: “${shown}”` : ""}`, ...kind.make(t, text, dur), at: t }];
    toast(`Added at ${fmtT(t)}: ${kind.label}`);
    changed();
    draw();
    seekBig(t);
  });
  wrap.addEventListener("change", e => {
    if (e.target.id !== "ownKind") return;
    sel.kind = e.target.value;
    if (PHRASE_KINDS.includes(sel.kind) && sel.a != null) {
      const [lo, hi] = range();
      sel.text = clip.words.slice(lo, hi + 1).map(x => bare(x.word)).join(" ");
    } else sel.text = "";
    draw();
  });
  wrap.addEventListener("input", e => { if (e.target.id === "ownText") sel.text = e.target.value; });
  wrap.draw = draw;
  panels.add(wrap);
  draw();
  return wrap;
}

function stepAnims(body) {
  const p = state.picks;
  body.appendChild(ownPanel());
  const story = beats.filter(b => !b.hook);
  if (!story.length) return body.appendChild(wherePanel(["anims"], { empty: "Add an animation on any word above." }));
  if (!beatById(state.beat) || beatById(state.beat).hook) state.beat = story[0].id;
  body.appendChild(h3("Suggested for each beat"));
  const tl = el("timeline");
  beats.filter(b => !b.hook).forEach(b => {
    const words = clip.words.filter(w => w.start >= b.start - 0.05 && w.start < b.end).map(w => w.word).join(" ");
    const s = document.createElement("button");
    s.className = `seg ${state.beat === b.id ? "on" : ""}`;
    s.dataset.beat = b.id;
    s.style.flex = b.end - b.start;
    s.title = words;
    s.innerHTML = `<b>${esc(b.label)}</b><span class="words">${esc(words)}</span><span class="picks"></span>`;
    s.addEventListener("click", () => { state.beat = b.id; render(); });
    tl.appendChild(s);
  });
  tl.appendChild(el("playhead"));
  body.appendChild(tl);

  const b = beatById(state.beat);
  const head = el("beat-head", `<b>${esc(b.label)}</b><span>${b.start.toFixed(1)}–${b.end.toFixed(1)} s · tick as many as you like</span>`);
  const cards = b.options.map((o, i) => card({
    n: i + 1, label: o.label, spec: compose(p, { anims: { ...p.anims, [b.id]: [o.id] } }), win: optWindow(o, b),
    isPicked: () => (state.picks.anims[b.id] || []).includes(o.id),
    onPick: () => {
      const cur = (state.picks.anims[b.id] || []).filter(x => x !== "none");
      const on = !cur.includes(o.id);
      const next = on ? [...cur, o.id] : cur.filter(x => x !== o.id);
      if (next.length) state.picks.anims[b.id] = next; else delete state.picks.anims[b.id];
      toast(`${b.label}: ${on ? "added" : "removed"} ${o.label}`);
    },
  }));
  cards.push(card({
    n: b.options.length + 1, label: "Just you", sub: "No animation on this beat", clean: true,
    spec: compose(p, { anims: { ...p.anims, [b.id]: [] } }), win: [b.start, Math.min(b.end, b.start + 4)],
    isPicked: () => (state.picks.anims[b.id] || [])[0] === "none",
    onPick: () => { state.picks.anims[b.id] = ["none"]; toast(`${b.label}: just you`); },
  }));
  body.append(head, grid(cards), wherePanel(["anims"], { empty: "Add an animation on any beat to see it here." }));
}

function summaryRows() {
  const p = state.picks;
  const label = (list, id) => list.find(x => x.id === id)?.label || "—";
  const all = placements(p);
  const count = g => { const l = all.filter(x => x.group === g); return l.length ? ` (${l.filter(x => x.on).length}/${l.length} places on)` : ""; };
  const evs = soundEvents(compose(p)).filter(e => p.sounds.includes(e.kind));
  return [
    ["Colour", label(GRADES, p.grade)],
    ["Fonts", label(FONTS, p.font)],
    ["Text colours", `${p.ink || "White"} text · ${p.accent || "highlight from the grade"}`],
    ["Captions", label(CAPTIONS, p.caption)],
    ["Hook", p.hook === "none" ? "Just you" : `${label(HOOKS, p.hook)}: “${hookText(p).lines.filter(Boolean).join(" / ")}”`],
    ["Moves", (p.moves.map(id => label(MOVES, id)).join(", ") || "—") + count("moves")],
    ["Sound", (p.sounds.map(id => (id === "music" ? "music bed" : id)).join(", ") || "—") + (evs.length ? ` (${evs.length} hits)` : "")],
    ["Animations", ([...beats.filter(b => !b.hook).map(b => beatPicksText(b) && `${b.label}: ${beatPicksText(b)}`),
      ...p.custom.map(c => `${fmtT(c.at)} ${c.label}`)].filter(Boolean).join(" · ") || "—") + count("anims")],
  ];
}

function stepWatch(body) {
  body.innerHTML = `
    <dl class="summary">${summaryRows().map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
    <div id="fullMap"></div>
    <div class="render-box">
      ${api.canRender ? `<div class="render-head">
        <button class="btn primary" id="render">Render</button>
        <span class="note">Renders only what you said Yes to, at 1080×1920, 30 fps, with the same engine as the preview, then masters to -14 LUFS. About 3 minutes.</span>
      </div>` : `<b>Render</b><p class="note">${api.renderNote}</p>`}
      <div class="bar"><i></i></div>
      <ol class="rsteps"></ol>
      <div id="result"></div>
    </div>
    <div class="save-box">
      <b>Save as my style</b>
      <form id="saveForm"><input id="styleName" placeholder="e.g. Split card" maxlength="40" autocomplete="off"><button class="btn primary" id="save">Save</button></form>
      <p class="note">${esc(api.saveNote || "Writes editing-studio/styles/<name>.json and adds it to the first screen. The name also names the render.")}</p>
    </div>`;
  $("#fullMap").replaceWith(wherePanel(["hook", "moves", "anims"], { title: "Everything that appears, and where", empty: "Nothing placed yet." }));
  $("#render")?.addEventListener("click", () => (state.demo ? fakeRender() : startRender()));
  $("#saveForm").addEventListener("submit", e => { e.preventDefault(); saveStyle($("#styleName").value); });
  if (!state.demo && api.canRender) pollRender();
}

/* ---------- real render: tools/render_studio.cjs via the local server ---------- */
// Same picks? Compares with keys and string lists sorted, so order doesn't matter.
function sameEdit(a, b) {
  const norm = v => Array.isArray(v) ? [...v].map(norm).sort() : v && typeof v === "object"
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, norm(v[k])])) : v;
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}
const RENDER_STEPS = ["Draw frames", "Mix sound", "Master to -14 LUFS"];
const STAGE_INDEX = { starting: 0, frames: 0, sound: 1, master: 2, done: 3 };
let renderTimer = null, watchingRender = false;

async function startRender() {
  const out = await api.render({ picks: state.picks, name: $("#styleName")?.value.trim() || "", data: DATA_DIR });
  if (out.status !== 200) return toast(out.error || "Couldn't start the render");
  toast("Rendering your reel");
  watchingRender = true;
  pollRender();
}

async function pollRender() {
  clearTimeout(renderTimer);
  const s = await api.renderStatus();
  if (!s) return;
  showRender(s);
  if (s.state === "running") {
    watchingRender = true;
    renderTimer = setTimeout(pollRender, 800);
  } else if (watchingRender) {
    watchingRender = false;
    toast(s.state === "done" ? "Your reel is ready to watch" : "The render failed");
  }
}

function showRender(s) {
  const list = $(".rsteps"), bar = $(".bar i"), btn = $("#render"), result = $("#result");
  if (!list || s.state === "idle" || !s.out?.startsWith("projects/")) return;
  // A draft of another clip: only block the button while it runs, don't show it as this clip's.
  const mine = s.out.startsWith(clip.source.split("/").slice(0, 2).join("/") + "/");
  if (!mine) {
    btn.disabled = s.state === "running";
    btn.textContent = s.state === "running" ? "Another clip is rendering…" : "Render";
    return;
  }
  const at = s.state === "error" ? -1 : STAGE_INDEX[s.stage] ?? 0;
  list.innerHTML = RENDER_STEPS.map((label, i) => {
    const cls = s.state === "done" || i < at ? "done" : i === at ? "doing" : "";
    const extra = i === 0 && s.frames ? ` (${s.frame}/${s.frames})` : i === 1 && s.sounds != null ? ` (${s.sounds} effects)` : "";
    return `<li class="${cls}">${label}${extra}</li>`;
  }).join("");
  const frac = s.state === "done" ? 1 : at === 0 ? 0.85 * ((s.frame || 0) / (s.frames || 1)) : at === 1 ? 0.9 : at === 2 ? 0.95 : 0;
  bar.style.width = `${frac * 100}%`;
  btn.disabled = s.state === "running";
  btn.textContent = s.state === "running" ? "Rendering…" : "Render";
  if (s.state === "running") {
    // Never leave an older draft on screen while a new one is being made.
    result.innerHTML = "";
    result.dataset.out = "";
  } else if (s.state === "error") {
    result.innerHTML = `<p class="error">${esc(s.error || "The render failed.")}</p>`;
  } else if (s.state === "done" && result.dataset.out !== s.out) {
    result.dataset.out = s.out;
    const current = s.picks && sameEdit(migratePicks(s.picks), state.picks);
    result.innerHTML = `
      <div class="result">
        <video controls playsinline preload="metadata" src="/${esc(s.out)}?v=${s.updatedAt}"></video>
        <div>
          <b>${current ? "Draft ready: matches your picks" : "Last draft: made with earlier picks"}</b>
          ${current ? "" : `<p class="note warn">Your picks have changed since this was rendered. Press Render to see them.</p>`}
          <p class="note">${esc(s.out)}<br>${s.lufs != null ? `${s.lufs} LUFS · ` : ""}rendered in ${s.seconds}s</p>
          <p class="note">This draft stays in the project folder. Nothing is saved as final until you approve it.</p>
          <button class="btn primary" id="approve">Approve and save final</button>
          <button class="btn" id="revealDraft">Show draft in folder</button>
          <p class="note" id="approveNote"></p>
        </div>
      </div>`;
    $("#approve").addEventListener("click", () => approveRender(s.out));
    $("#revealDraft").addEventListener("click", () => api.reveal(s.out));
  }
}

async function approveRender(file) {
  const out = await api.approve(file);
  if (out.status !== 200 && out.status !== 409) return toast(out.error || "Couldn't save");
  $("#approveNote").innerHTML = `${out.status === 409 ? "Already saved as final" : "Saved final"}: ${esc(out.file)} <button class="chip" id="revealFinal">Show in folder</button>`;
  $("#revealFinal").addEventListener("click", () => api.reveal(out.file));
  $("#approve").disabled = true;
  if (out.status === 409) return toast("This draft is already saved as final");
  toast("Saved the final video");
}

// The D demo uses this stand-in so filming doesn't start a 3-minute render.
function fakeRender() {
  const p = state.picks, evs = soundEvents(compose(p));
  const nfx = compose(p).fx.length;
  const steps = [
    `Cut ${clip.cuts.length + 1} takes into ${clip.duration.toFixed(1)} s`,
    `Colour grade: ${GRADES.find(g => g.id === p.grade)?.label || "Raw"}`,
    `Captions: ${clip.words.length} words`,
    `Moves and animations: ${nfx} placement${nfx === 1 ? "" : "s"}`,
    `Sound: ${evs.filter(e => p.sounds.includes(e.kind)).length} hits, master to -14 LUFS`,
    "Encode 1080×1920 · 30 fps",
  ];
  const list = $(".rsteps"), bar = $(".bar i");
  list.innerHTML = steps.map(s => `<li>${esc(s)}</li>`).join("");
  $("#render").disabled = true;
  let k = 0;
  const tickStep = () => {
    const items = [...list.children];
    items.forEach((li, i) => { li.className = i < k ? "done" : i === k ? "doing" : ""; });
    bar.style.width = `${(k / steps.length) * 100}%`;
    if (k++ < steps.length) setTimeout(tickStep, state.demo ? 650 : 900);
    else { $("#render").disabled = false; toast("Render preview done"); }
  };
  tickStep();
}

let replaceName = null;
async function saveStyle(name) {
  name = (name || "").trim();
  if (!name) return toast("Give your style a name");
  if (state.demo) { state.saved = true; updateChrome(); return toast(`Saved as my style: ${name}`); }
  const overwrite = replaceName === name;
  const out = await api.save({ name, picks: state.picks, clip: clip.name, overwrite });
  const btn = $("#save");
  if (out.status === 409) {
    replaceName = name;
    if (btn) btn.textContent = "Replace";
    return toast(`“${name}” already exists. Press Replace to save over it.`);
  }
  replaceName = null;
  if (btn) btn.textContent = "Save";
  if (out.status !== 200) return toast(out.error || "Couldn't save");
  state.saved = true;
  styles = await api.styles();
  updateChrome();
  toast(`Saved “${name}” to ${out.file}`);
}

function applyStyle(s) {
  state.picks = migratePicks(s.picks);
  toast(`Loaded your style: ${s.name}`);
  render();
}

/* ---------- render + chrome ---------- */
function updateChrome() {
  document.querySelectorAll(".tab").forEach((t, i) => t.classList.toggle("done", STEPS[i].done(state.picks)));
  document.querySelectorAll(".card").forEach(c => c.classList.toggle("picked", c.isPicked()));
  document.querySelectorAll(".seg[data-beat]").forEach(s => {
    const text = beatPicksText(beatById(s.dataset.beat));
    s.querySelector(".picks").textContent = text;
    s.classList.toggle("has", !!text);
  });
  panels.forEach(p => (p.isConnected ? p.draw() : panels.delete(p)));
}

function changed() { updateChrome(); refreshBig(); autosave(); }

function setSound(on) {
  state.sound = on;
  big.video.muted = !on;
  if (on) audio.init();
  $("#soundToggle").textContent = on ? "Sound on" : "Sound off";
  $("#soundToggle").classList.toggle("on", on);
}

function refreshBig() {
  big.setSpec(state.raw ? null : compose(state.picks));
  const id = STEPS[state.step].id;
  const b = id === "anims" ? beatById(state.beat) : id === "hook" ? beats.find(x => x.hook) : null;
  big.setWindow(b ? b.start : null, b ? b.end : null);
}

function render() {
  [...players].forEach(p => p !== big && p.destroy());
  panels.clear();
  const step = STEPS[state.step];
  $("#tabs").innerHTML = STEPS.map((s, i) =>
    `<button class="tab ${i === state.step ? "on" : ""}" data-step="${i}"><span class="n">${i + 1}</span>${s.label}</button>`).join("");
  $("#help").textContent = step.help;
  $("#back").disabled = state.step === 0;
  $("#next").style.visibility = state.step === STEPS.length - 1 ? "hidden" : "";
  const body = $("#body");
  body.innerHTML = "";
  body.scrollTop = 0;
  ({ colours: stepColours, fonts: stepFonts, captions: stepCaptions, hook: stepHook, moves: stepMoves,
     sound: stepSound, anims: stepAnims, watch: stepWatch })[step.id](body);
  updateChrome();
  refreshBig();
  autosave();
}

function goStep(i) { state.step = Math.max(0, Math.min(STEPS.length - 1, i)); render(); }

function resume() {
  const saved = store.get(picksKey());
  if (!saved) return;
  state.picks = migratePicks(saved);
  render();
}

function reset() {
  if (!state.demo) store.del(picksKey());
  state.picks = emptyPicks();
  state.beat = "b2";
  state.saved = false;
  goStep(0);
  big.video.currentTime = 0;
  toast("Reset");
}

/* ---------- the big preview's clock ---------- */
let lastT = 0, scrubbing = false;
function frame() {
  players.forEach(p => p.tick());
  const v = big.video, t = v.currentTime;
  if (!scrubbing) $("#scrub").value = (t / clip.duration) * 1000;
  $("#time").textContent = `${fmt(t)} / ${fmt(clip.duration)}`;
  $("#play").classList.toggle("playing", !v.paused);
  document.querySelectorAll(".playhead").forEach(ph => {
    const segs = beats.filter(b => !b.hook);
    if (!segs.length) return;
    const a = segs[0].start, z = segs[segs.length - 1].end;
    ph.style.left = `${clamp((t - a) / (z - a)) * 100}%`;
  });
  if (t < lastT) lastT = t - 0.001;
  const live = state.sound && !state.raw && !v.paused;
  if (live && t - lastT < 0.5) big.events.forEach(e => {
    if (e.t > lastT && e.t <= t && state.picks.sounds.includes(e.kind)) audio.play(e.kind);
  });
  lastT = t;
  audio.bed(live && state.picks.sounds.includes("music"));
  requestAnimationFrame(frame);
}

/* ---------- start ---------- */
async function start() {
  await loadData();
  styles = await api.styles();
  // Where to start, first match wins: your unsaved work on this clip; a "start" style made for this clip;
  // otherwise the house look (the "default" style, quiet luxury) without another clip's animations.
  const resumed = store.get(picksKey());
  const own = styles.find(s => s.start && s.clip === clip.name);
  const house = styles.find(s => s.default) || styles.find(s => s.start);
  let first = null;
  if (resumed) {
    state.picks = migratePicks(resumed);
  } else if (own) {
    first = own;
    const m = migratePicks(own.picks);
    state.picks = own.startWith ? { ...emptyPicks(), ...Object.fromEntries(own.startWith.map(k => [k, m[k]])) } : m;
  } else if (house) {
    first = house;
    const m = migratePicks(house.picks);
    state.picks = { ...emptyPicks(), ...Object.fromEntries(LOOK_KEYS.map(k => [k, m[k]])) };
  }
  document.title = `Reel Studio · ${clip.name}`;
  const clips = await api.clips();
  const pickEl = $("#clipPick");
  if (!clips.some(c => c.data === DATA_DIR)) clips.unshift({ data: DATA_DIR, name: clip.name, duration: clip.duration });
  pickEl.innerHTML = clips.map(c => `<option value="${esc(c.data)}" ${c.data === DATA_DIR ? "selected" : ""}>${esc(c.name)} · ${fmt(c.duration || 0)}</option>`).join("");
  pickEl.addEventListener("change", () => switchClip(pickEl.value));
  $("#addVideo").addEventListener("click", () => importer.open());
  $("#importClose").addEventListener("click", () => importer.close());
  $("#importModal").addEventListener("click", e => { if (e.target.id === "importModal") importer.close(); });

  big = new Player($("#big"), { src: clip.video });
  big.video.play().catch(() => {});

  $("#tabs").addEventListener("click", e => { const t = e.target.closest(".tab"); if (t) goStep(+t.dataset.step); });
  $("#back").addEventListener("click", () => goStep(state.step - 1));
  $("#next").addEventListener("click", () => goStep(state.step + 1));
  $("#export").addEventListener("click", () => { goStep(STEPS.length - 1); toast("Check the map, then render"); });
  $("#play").addEventListener("click", () => (big.video.paused ? big.video.play() : big.video.pause()));
  const scrub = $("#scrub");
  scrub.addEventListener("pointerdown", () => { scrubbing = true; });
  scrub.addEventListener("pointerup", () => { scrubbing = false; });
  scrub.addEventListener("input", () => { big.video.currentTime = (scrub.value / 1000) * clip.duration; });
  $("#soundToggle").addEventListener("click", () => setSound(!state.sound));
  document.querySelectorAll(".seg-switch button").forEach(b => b.addEventListener("click", () => {
    state.raw = b.dataset.view === "raw";
    document.querySelectorAll(".seg-switch button").forEach(x => x.classList.toggle("on", x === b));
    refreshBig();
  }));
  document.addEventListener("keydown", e => {
    if (e.target.matches("input, textarea") || e.key !== " ") return;
    e.preventDefault();
    big.video.paused ? big.video.play() : big.video.pause();
  });

  render();
  requestAnimationFrame(frame);
  if (resumed) toast("Picked up where you left off. Press R to start this clip over.");
  else if (first && first === own) toast(`Opened “${own.name}”.`);
  else if (first) toast(`Started with your house look from “${house.name}”. Animations are yours to add.`);
}

window.studio = { state, goStep, render, reset, resume, toast, audio, saveStyle, changed };
start();
