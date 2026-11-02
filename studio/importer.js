/* "Add video": bring a new clip into the Studio without asking Claude.
   1. Choose a file (or paste a path on this laptop, or a Drive / YouTube / Instagram link).
   2. tools/import_clip.py copies it, transcribes it and splits it into phrases at the pauses.
   3. You tick the lines to keep (likely retakes start unticked) and fix any wrong words.
   4. It cuts them together on the pauses, makes the preview copies and plans the beats, then the Studio opens it. */

const importer = (() => {
  const LS = "studio.import";
  const remember = v => { try { v ? localStorage.setItem(LS, v) : localStorage.removeItem(LS); } catch {} };
  const recall = () => { try { return localStorage.getItem(LS); } catch { return null; } };
  let project = null, timer = null, info = null, player = null;

  const modal = () => $("#importModal"), body = () => $("#importBody");
  function open() {
    modal().hidden = false;
    project = recall();
    if (project) poll(); else showSource();
  }
  function close() {
    modal().hidden = true;
    clearTimeout(timer);
    player?.pause();
  }

  /* ---------- 1. where the video is ---------- */
  function showSource(error = "") {
    $("#importTitle").textContent = "Add a video";
    body().innerHTML = `
      <label class="drop" id="drop">
        <input type="file" id="pickFile" accept="video/*,.mov,.mp4,.m4v,.zip" hidden>
        <b>Drop a video here, or click to choose one</b>
        <span>.mov or .mp4 straight off the phone is fine, HDR included. A .zip from WeTransfer works too.</span>
      </label>
      <div class="or">or paste where it is</div>
      <input class="field" id="srcPath" placeholder="C:\\Users\\nittz\\Downloads\\IMG_3060.MOV   or a Google Drive / YouTube link" autocomplete="off">
      <label class="lbl" for="srcName">Name for this edit</label>
      <input class="field" id="srcName" placeholder="e.g. AI jobs take" maxlength="48" autocomplete="off">
      <p class="error" id="srcErr">${esc(error)}</p>
      <div class="sheet-foot"><span class="note">About a minute of waiting per minute of video. Nothing leaves this laptop except a link you paste.</span>
        <button class="btn primary" id="srcGo">Next</button></div>`;
    let file = null;
    const pick = f => {
      file = f;
      $("#drop b").textContent = f.name;
      $("#drop span").textContent = `${(f.size / 1e6).toFixed(0)} MB · ready`;
      $("#drop").classList.add("has");
      if (!$("#srcName").value) $("#srcName").value = f.name.replace(/\.[^.]+$/, "");
    };
    $("#pickFile").addEventListener("change", e => e.target.files[0] && pick(e.target.files[0]));
    const drop = $("#drop");
    drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("over"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", e => {
      e.preventDefault();
      drop.classList.remove("over");
      if (e.dataTransfer.files[0]) pick(e.dataTransfer.files[0]);
    });
    $("#srcGo").addEventListener("click", async () => {
      const path = $("#srcPath").value.trim(), name = $("#srcName").value.trim();
      if (!file && !path) return ($("#srcErr").textContent = "Choose a video, or paste its path or link.");
      $("#srcGo").disabled = true;
      let source = path;
      if (file) {
        try { source = await upload(file); } catch (e) { $("#srcGo").disabled = false; return ($("#srcErr").textContent = e.message); }
      }
      const out = await api.importStart({ source, name });
      if (out.status !== 200) { $("#srcGo").disabled = false; return ($("#srcErr").textContent = out.error || "Couldn't start"); }
      project = out.project;
      remember(project);
      poll();
    });
  }

  // XMLHttpRequest, not fetch, so a big .MOV shows how far the copy has got.
  function upload(file) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open("PUT", `/api/upload?name=${encodeURIComponent(file.name)}`);
      x.upload.onprogress = e => { if (e.lengthComputable) $("#drop span").textContent = `Copying into the Studio… ${Math.round((e.loaded / e.total) * 100)}%`; };
      x.onload = () => {
        let r = {};
        try { r = JSON.parse(x.responseText); } catch {}
        x.status === 200 ? resolve(r.path) : reject(new Error(r.error || "The copy failed"));
      };
      x.onerror = () => reject(new Error("The copy failed. Is the Studio server still running?"));
      x.send(file);
    });
  }

  /* ---------- 2 and 4. waiting ---------- */
  const STAGES = {
    fetch: [["copy", "Getting the video"], ["download", "Downloading"], ["listen", "Finding the pauses"], ["transcribe", "Transcribing"]],
    build: [["cut", "Cutting your lines together"], ["previews", "Making preview copies"], ["beats", "Planning beats"]],
  };
  async function poll() {
    clearTimeout(timer);
    const s = await api.importStatus(project);
    if (modal().hidden) return;
    if (!s || s.state === "idle") { remember(null); return showSource(); }
    if (s.state === "error") return showError(s);
    if (s.state === "ready") return showPick(s.import);
    if (s.state === "done") return showDone(s);
    showWaiting(s);
    timer = setTimeout(poll, 1000);
  }

  function showWaiting(s) {
    const list = ["cut", "previews", "beats"].includes(s.stage) ? STAGES.build : STAGES.fetch.filter(([id]) => id !== "download" || s.stage === "download");
    const at = list.findIndex(([id]) => id === s.stage);
    $("#importTitle").textContent = s.name ? `Preparing “${s.name}”` : "Preparing your video";
    body().innerHTML = `<ol class="rsteps">${list.map(([, label], i) => `<li class="${i < at ? "done" : i === at ? "doing" : ""}">${esc(label)}</li>`).join("")}</ol>
      <p class="note">${esc(s.msg || "")}</p>
      <p class="note">You can close this and keep working; open “+ Add video” again to come back to it.</p>`;
  }

  function showError(s) {
    $("#importTitle").textContent = "That didn't work";
    body().innerHTML = `<p class="error">${esc(s.msg || "Something went wrong.")}</p>
      <div class="sheet-foot"><span></span><button class="btn primary" id="again">Try another video</button></div>`;
    $("#again").addEventListener("click", () => { remember(null); showSource(); });
  }

  /* ---------- 3. pick the lines ---------- */
  const clipLen = () => info.phrases.filter(p => p.keep && p.text.trim()).reduce((s, p) => s + (p.end - p.start) + 0.3, 0);
  function showPick(data) {
    info = data;
    $("#importTitle").textContent = `Pick the lines for “${info.name}”`;
    const rows = info.phrases.map(p => `
      <div class="phrase ${p.keep ? "" : "off"}" data-id="${p.id}">
        <input type="checkbox" ${p.keep ? "checked" : ""} title="Keep this line">
        <button class="ptime" data-play="${p.id}" title="Listen">▶ ${fmt(p.start)}</button>
        <input class="ptext" value="${esc(p.text)}" placeholder="(no words)" title="Fix any wrong words here: captions use this text">
        ${p.note ? `<small class="warn">${esc(p.note)}</small>` : ""}
      </div>`).join("");
    body().innerHTML = `
      <p class="note">Untick false starts, retakes and anything off-topic. Lines join on the pauses, so cuts never land mid-word. Fix wrong words in place: the captions use this text.</p>
      <div class="pick-head"><b id="kept"></b><span class="spacer"></span>
        <button class="chip" id="allOn">Keep all</button><button class="chip" id="allOff">Untick all</button></div>
      <div class="phrases">${rows}</div>
      <p class="error" id="pickErr"></p>
      <div class="sheet-foot"><button class="btn" id="startOver">Start over</button>
        <button class="btn primary" id="makeCut">Make the cut</button></div>`;
    const kept = () => {
      const s = clipLen();
      $("#kept").innerHTML = `Keeping about ${s.toFixed(0)} s <span class="${s >= 38 && s <= 55 ? "ok" : "warn"}">· aim for 40–50 s</span>`;
    };
    kept();
    player = player || new Audio();
    player.src = `/${info.audio}`;
    const list = $(".phrases");
    list.addEventListener("change", e => {
      const row = e.target.closest(".phrase");
      if (!row || e.target.type !== "checkbox") return;
      const p = info.phrases[+row.dataset.id];
      p.keep = e.target.checked;
      row.classList.toggle("off", !p.keep);
      kept();
    });
    list.addEventListener("input", e => {
      if (!e.target.classList.contains("ptext")) return;
      info.phrases[+e.target.closest(".phrase").dataset.id].text = e.target.value;
      kept();
    });
    list.addEventListener("click", e => {
      const b = e.target.closest("[data-play]");
      if (!b) return;
      const p = info.phrases[+b.dataset.play];
      player.currentTime = p.start;
      player.play().catch(() => {});
      const stop = () => { if (player.currentTime >= p.end + 0.1) { player.pause(); player.removeEventListener("timeupdate", stop); } };
      player.addEventListener("timeupdate", stop);
    });
    const all = on => { info.phrases.forEach(p => { p.keep = on && !!p.text.trim(); }); showPick(info); };
    $("#allOn").addEventListener("click", () => all(true));
    $("#allOff").addEventListener("click", () => all(false));
    $("#startOver").addEventListener("click", () => { remember(null); showSource(); });
    $("#makeCut").addEventListener("click", async () => {
      if (!info.phrases.some(p => p.keep && p.text.trim())) return ($("#pickErr").textContent = "Keep at least one line.");
      player.pause();
      const out = await api.importCut({ project, phrases: info.phrases.map(({ id, keep, text }) => ({ id, keep, text })) });
      if (out.status !== 200) return ($("#pickErr").textContent = out.error || "Couldn't start the cut");
      poll();
    });
  }

  /* ---------- 5. open it ---------- */
  function showDone(s) {
    $("#importTitle").textContent = `“${s.name}” is ready`;
    body().innerHTML = `<p>${esc(s.msg || "")}. It opens with your house look; every step is yours to change.</p>
      <div class="sheet-foot"><button class="btn" id="recut">Change the lines</button><button class="btn primary" id="openIt">Open it in the Studio</button></div>`;
    $("#openIt").addEventListener("click", () => { remember(null); switchClip(s.data); });
    $("#recut").addEventListener("click", async () => {
      const r = await fetch(`/${project}/import.json`).then(r => r.json()).catch(() => null);
      if (r) showPick(r);
    });
  }

  return { open, close };
})();
