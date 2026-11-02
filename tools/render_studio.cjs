/* Render the Studio's picks to a real MP4 that matches the preview.

   Usage: node tools/render_studio.cjs <job.json> <out.mp4> [port]
     job.json: {"picks": {...}}   (what the Studio saves)
     The local server (tools/serve.py) must be running on <port> (default 8765).

   1. Opens studio/render.html in headless Edge at 1080x1920 and draws every frame at 30 fps with
      the same engine as the preview, piping each frame into ffmpeg.
   2. Mixes the voice, each picked sound effect at the exact time of its move, and the music bed.
   3. Masters to -14 LUFS (two-pass loudnorm, true peak -1.5 dB) and muxes.
   Progress goes to studio/data/render-progress.json for the Studio to show. */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { chromium } = require("playwright-core");

const STUDIO = path.resolve(__dirname, "..");
const EDGE = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe"].find(p => fs.existsSync(p));
const FPS = 30;
const PROGRESS = path.join(STUDIO, "studio", "data", "render-progress.json");

const [jobPath, outPath, port = "8765"] = process.argv.slice(2);
const rel = p => path.relative(STUDIO, p).replace(/\\/g, "/");
const started = Date.now();
let last = {};
function report(fields) {
  last = { ...last, ...fields, out: rel(outPath), startedAt: started, updatedAt: Date.now() };
  fs.writeFileSync(PROGRESS, JSON.stringify(last));
}

function ffmpeg(args) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-y", ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${(r.stderr || "").split("\n").slice(-6).join("\n")}`);
  return r.stderr;
}

async function drawFrames(info, page, videoOut) {
  const frames = Math.round(info.duration * FPS);
  const enc = spawn("ffmpeg", ["-hide_banner", "-y", "-v", "error", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "mjpeg",
    "-i", "-", "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p", "-r", String(FPS), videoOut]);
  let encErr = "";
  enc.stderr.on("data", d => { encErr += d; });
  const encDone = new Promise((res, rej) => enc.on("close", code => (code === 0 ? res() : rej(new Error(`ffmpeg encode failed: ${encErr}`)))));
  // On this laptop a frame now and then stalls (memory pressure, glass blur); retry it rather than
  // throwing away the whole render.
  const grab = async (t, tries = 3) => {
    for (let k = 1; ; k++) {
      try {
        await page.evaluate(x => window.renderer.frame(x), t);
        return await page.screenshot({ type: "jpeg", quality: 94, timeout: 60000 });
      } catch (e) {
        if (k >= tries) throw e;
        console.error(`frame at ${t.toFixed(2)} s stalled (${e.message.split("\n")[0]}), retrying`);
        await new Promise(r => setTimeout(r, 1500));
      }
    }
  };
  for (let i = 0; i < frames; i++) {
    const jpg = await grab(i / FPS);
    if (!enc.stdin.write(jpg)) await new Promise(r => enc.stdin.once("drain", r));
    if (i % 10 === 0) report({ stage: "frames", frame: i, frames });
  }
  enc.stdin.end();
  await encDone;
  report({ stage: "frames", frame: frames, frames });
}

function mixAudio(info, tmp) {
  const inputs = ["-i", path.join(STUDIO, info.voice)];
  const chains = ["[0:a]aformat=sample_rates=48000:channel_layouts=stereo[a0]"];
  const labels = ["[a0]"];
  const byId = Object.fromEntries(info.sounds.map(s => [s.id, s]));
  info.events.forEach((e, k) => {
    const s = byId[e.kind];
    inputs.push("-i", path.join(STUDIO, s.file));
    const ms = Math.max(0, Math.round(e.t * 1000));
    chains.push(`[${k + 1}:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=${s.gain},adelay=${ms}:all=1[s${k}]`);
    labels.push(`[s${k}]`);
  });
  if (info.music) {
    const n = info.events.length + 1, d = info.duration;
    inputs.push("-stream_loop", "-1", "-i", path.join(STUDIO, byId.music.file));
    chains.push(`[${n}:a]aformat=sample_rates=48000:channel_layouts=stereo,atrim=0:${d},volume=${byId.music.gain},` +
      `afade=t=in:d=0.8,afade=t=out:st=${(d - 1.5).toFixed(2)}:d=1.5[m]`);
    labels.push("[m]");
  }
  chains.push(`${labels.join("")}amix=inputs=${labels.length}:normalize=0:duration=first[mix]`);
  const mix = path.join(tmp, "mix.wav");
  ffmpeg([...inputs, "-filter_complex", chains.join(";"), "-map", "[mix]", "-t", String(info.duration), "-c:a", "pcm_s16le", mix]);
  return mix;
}

function master(videoOut, mix, mastered, I = -14) {
  const target = `I=${I}:TP=-1.5:LRA=11`;
  const pass1 = ffmpeg(["-i", mix, "-af", `loudnorm=${target}:print_format=json`, "-f", "null", "-"]);
  const m = JSON.parse(pass1.slice(pass1.lastIndexOf("{"), pass1.lastIndexOf("}") + 1));
  const ln = `loudnorm=${target}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}` +
    `:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;
  ffmpeg(["-i", videoOut, "-i", mix, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-af", ln, "-ar", "48000",
    "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", mastered]);
  const check = ffmpeg(["-i", mastered, "-map", "0:a", "-af", "ebur128=peak=true", "-f", "null", "-"]);
  const lufs = check.match(/I:\s+(-?[\d.]+) LUFS/g)?.pop()?.match(/-?[\d.]+/)?.[0];
  return lufs ? Number(lufs) : null;
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "studio-render-"));
  let browser;
  try {
    if (fs.existsSync(outPath)) throw new Error(`${rel(outPath)} already exists; renders are never overwritten.`);
    const job = JSON.parse(fs.readFileSync(jobPath, "utf8"));
    report({ state: "running", stage: "starting", frame: 0, frames: 0 });

    browser = await chromium.launch({ executablePath: EDGE });
    const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
    page.on("pageerror", e => console.error("page:", e.message));
    // job.data: a studio/ folder holding another clip's clip.json, beats.json and render.mp4 (default data).
    await page.goto(`http://localhost:${port}/studio/render.html${job.data ? `?data=${encodeURIComponent(job.data)}` : ""}`);
    const info = await page.evaluate(picks => window.renderer.init(picks), job.picks);

    const videoOut = path.join(tmp, "video.mp4");
    await drawFrames(info, page, videoOut);
    await browser.close();
    browser = null;

    report({ stage: "sound", sounds: info.events.length });
    const mix = mixAudio(info, tmp);
    report({ stage: "master" });
    const mastered = path.join(tmp, "mastered.mp4");
    let lufs = master(videoOut, mix, mastered);
    if (lufs != null && Math.abs(lufs + 14) > 0.3) {
      // loudnorm can land a little off on short clips; aim again by the miss.
      lufs = master(videoOut, mix, mastered, -14 + (-14 - lufs));
    }
    // Only a file that opens, with video and sound, ever reaches renders/.
    const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", mastered], { encoding: "utf8" });
    if (probe.status !== 0 || !/video/.test(probe.stdout) || !/audio/.test(probe.stdout))
      throw new Error(`The finished file did not open: ${(probe.stderr || "").trim()}`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.copyFileSync(mastered, outPath);
    report({ state: "done", stage: "done", lufs, seconds: Math.round((Date.now() - started) / 1000) });
  } catch (e) {
    console.error(e);
    report({ state: "error", stage: "error", error: String(e.message || e) });
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    // After a failed render ffmpeg may still hold a temp file for a moment; never crash over cleanup.
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 }); } catch {}
  }
})();
