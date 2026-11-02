# editing-studio

Claude's editing workspace for talking-head reels. Built from Artem Novitckii's "Build your own AI editing studio" guide (Oct 2026).

## Quick start (no Claude needed)

1. `python tools/serve.py`, then open http://localhost:8765/studio/ (VS Code: Ctrl+Shift+P → "Simple Browser: Show").
2. **+ Add video** (top bar): drop a .mov/.mp4 (HDR iPhone footage is fine, so is a WeTransfer .zip), or paste a path on this laptop or a Google Drive / YouTube / Instagram link (Drive files must be shared "Anyone with the link"; a Drive *folder* link won't work).
3. It transcribes and splits the talk at its pauses. Tick the lines to keep (likely retakes start unticked), fix wrong words in place, aim for 40–50 s, **Make the cut**. Joins always land in pauses, never mid-word.
4. It opens in the Studio with the house look (quiet luxury, from the style marked `"default": true`). Go through the steps, Render on Watch, and **Approve and save final** when you're happy.

Switch between clips with the dropdown next to the logo. Your picks on each clip are kept in the browser as you go, so a refresh never loses them (R starts a clip over, after asking).

Needs: Python 3.12, Node 24 (`npm install` once for `playwright-core`), FFmpeg 9 on PATH, Microsoft Edge (or Chrome), whisper.cpp + `ggml-small.en` at the paths in `tools/transcribe.py` (or a `GROQ_API_KEY` in `.env`), `yt-dlp` for links.

## Folders

| Folder | What goes in it |
|---|---|
| `clips/` | Raw videos to edit. Each clip gets a `<name>.words.json` transcript next to it. |
| `references/` | Reels from creators to learn from, one subfolder per creator (`references/<creator-name>/`), plus a `notes.txt` in your own words. |
| `styles/` | Editing styles saved from the Studio, as `<name>.json`. |
| `projects/` | One folder per video being edited (storyboard, build files, `renders/<name>-v1.mp4`, v2, ...). |
| `tools/` | Claude's scripts. |
| `studio/` | The Studio web app: pick colours, fonts, captions, beat effects and sound on your own clip, then save a style. |

## Tools

### `tools/transcribe.py`

Transcribes a video with a start and end time for every word.

```
python tools/transcribe.py clips/<file>.mp4                 # Groq if a key is set, else local
python tools/transcribe.py clips/<file>.mp4 --engine local  # force local whisper.cpp
```

Writes `clips/<file>.words.json`: `{source, engine, duration, text, words: [{word, start, end}]}` (times in seconds).

- **groq**: Groq's Whisper API, `whisper-large-v3`. Fast and accurate. Needs `GROQ_API_KEY=...` in `editing-studio/.env` (never commit or share that file).
- **local**: whisper.cpp (`C:\Users\nittz\VideoEditor\tools\whisper\Release\whisper-cli.exe`) with `ggml-small.en`. No key, slower, slightly rougher word edges.

Uses only the Python standard library plus `ffmpeg`/`ffprobe` on PATH.

### `tools/cut.py`

Cuts a clip down to a list of segments and joins them, with a 15 ms audio fade on each join.

```
python tools/cut.py projects/<name>/cuts-v1.json
```

The JSON gives `source`, `output` and `segments: [{in, out, note}]` (seconds). It refuses to overwrite an existing render, so bump the version (v2, v3) instead. Cut on pauses found with ffmpeg `silencedetect`, not on Whisper word times, which can drift by over a second.

### `tools/serve.py`

The one local server for everything here (this machine only, nothing is uploaded).

```
python tools/serve.py          # http://localhost:8765, supports range requests so video seeks
```

- Studio: `http://localhost:8765/studio/`
- Cut review: `http://localhost:8765/tools/review.html?p=projects/<name>` (plays the newest `cuts-vN.json` render with numbered cuts and a version picker)
- `GET /api/styles` lists saved styles; `POST /api/save` writes `styles/<name>.json` and refuses to overwrite unless asked.

Open pages beside the chat in VS Code with Ctrl+Shift+P → "Simple Browser: Show".

### `tools/import_clip.py` (behind "+ Add video")

```
python tools/import_clip.py fetch <file | folder | .zip | link> --name "<name>"   # -> projects/<name>/import.json
python tools/import_clip.py build projects/<name>                                 # cut + previews + beats
```

`fetch` copies or downloads the video into `clips/`, transcribes it, and splits it into phrases at the pauses ("quiet" is 40% of the way from the room's noise floor to the speaking level; phrases over 8 s split at their quietest moment). A line restarted within the next few phrases is marked as a false start and starts unticked. `build` turns the kept phrases into `cuts-vN.json` (padded into the pauses; neighbours less than 0.6 s apart stay joined), runs `cut.py` (HDR stays HDR, shrunk to 1080×1920 to save time), `prepare_studio.py --data projects/<name>/studio` and `auto_beats.py`. Progress: `projects/<name>/import-progress.json`.

### `tools/auto_beats.py`

Plans `beats.json` for an imported clip: the hook (first sentence, retypeable in the Hook step), 6–14 s beats split on cuts and sentences, caption keywords and impact words, and two quiet suggestions per beat (the key word surfacing, a glass note above the head). A hand-written `beats.json` (no `"auto": true`) is never replaced.

### `tools/prepare_studio.py`

Points the Studio at a cut: `python tools/prepare_studio.py projects/<name>/cuts-vN.json`. Makes `studio/data/preview.mp4` (720p), `proxy.mp4` (360p for the cards) and `render.mp4` (1080p frames for the renderer), all with a keyframe every 0.2 s so loops and seeks are quick, and `clip.json` with cut times and word timings. Each segment in the cuts file needs a `text` field with its exact words. The beats, the animations offered on each, and the impact words (for punch-ins) and big moments (for shakes) live in `studio/data/beats.json`, anchored to spoken words (`"at": "multimillionaire"`, or `{"word": "built", "nth": 2}`).

## The Studio (`studio/`)

Plain HTML/CSS/JS, no build. Eight steps: Colours, Fonts, Captions, Hook, Moves, Sound, Animations (last), Watch. Every option card plays the clip with that option drawn on it, looping only the part where it happens. The big preview stacks every pick (Raw/Edited switch to compare); on Hook and Animations it loops the beat you're on.

Every pick becomes **placements** (one per impact word, cut, beat or animation). Hook, Moves, Animations and Watch show "Where it appears": a track and one row per placement with its time, the words spoken there, Yes / No, and a sound on/off. Sound shows a sound map with Yes / No per place. Click a time to play the preview from there. No is stored in `picks.off`, a muted sound in `picks.mute`; the render uses only what's Yes. Animations (Wikipedia page, split, highlight, Notes / chat window, emoji, keywords, counters) are opt-in per beat, never on by default.

**Add an animation where you want it** (top of Animations): click a word in the transcript (shift-click for a phrase), choose keyword / emoji / Notes / chat / count-up / step badge / Wikipedia page / split, type its text, Add. These are stored in `picks.custom`, show in the Yes / No list with a Remove button, and render like everything else. Only one keyword, count or step badge sits above the head at a time; the earlier one gives way.

**Text colours** (top of Fonts): text colour (`picks.ink`) and highlight colour (`picks.accent`, default comes from the grade), presets or any custom colour.

**Anjan's style** (Fonts step): Nanum Myeongjo titles + Work Sans Regular captions from the MUSED x Anjan Luthra guidelines (23 Oct 2026), with MUSED Cream White, Muted Blue, Danish Blue and Light Auburn as colour swatches.

**Quiet luxury** (the user's own aesthetic): Cormorant Garamond / Work Sans font pair, a "Quiet luxury" grade (soft dark fades top and bottom so thin type reads without boxes), "Quiet serif accents" captions, and quiet animation kinds for beats.json: `word` (surfaces from a soft blur, no pop or sound), `count`/`steps` with `"quiet": true`, `chat` with `"style": "glass"` and `"y"` to keep it off the face, and `timeline` (hairline Day 1 → Day 3 with `marks`, `dur`, `caption`, `captionAt`). No slams, no emojis. Typing in every window finishes each line within 0.7 s. A beats.json `keywords` list sets the clip's two-tone/serif caption accents, and the Studio opens the `start` style whose `clip` matches the loaded clip.

**Artifact copy**: a private claude.ai version at https://claude.ai/artifact/MvpCegxDexvgqxCaN4dpM4 runs the same files with `artifact-api.js` (styles saved in the artifact's database, no rendering). `app.js` talks to the outside only through its `api` object, which the artifact replaces.

Where a clip starts: your unsaved picks on it (kept in the browser, `studio.picks.<clip>`); else a `"start": true` style saved for that clip (`"startWith": ["font", "caption"]` loads only those parts); else the house look, the style with `"default": true` (AI jobs edit, quiet luxury), with only its look (grade, fonts, captions, colours, hook kind, moves, sounds) and none of its animations.

**Hook text** (top of Hook): retype the title's two lines (`picks.hookLines`); cards and render use it. **Add an animation** lists the quiet kinds first: word fade, glass note, timeline (`Day 1, Day 2, Day 3 | caption`), line climbs / falls / road splits, quiet count and step number; the loud ones (keyword slam, emoji) are labelled "(loud)".

- `looks.js`: grades, font pairs, caption styles, hook titles, moves, sounds, and every effect's drawing code. Everything draws on a 1080×1920 stage as a function of clip time. Layout is measured from the clip: face x 320–640, y 490–900; titles above the head, captions at y ~1380, all inside Instagram's safe zone.
- `app.js`: steps, cards, preview, sound playback, saving. `demo.js`: press **D** for a ~40 s hands-free run with a fake cursor (its Save doesn't write a file), **R** to reset.
- `fonts/`: Google Fonts (OFL) served locally. `sfx/`: whoosh, pop, ping, typing, click (Pixabay licence) and a locally generated music bed, see `sfx/CREDITS.md`. `assets/`: a real screenshot of the Wikipedia "Private equity" page (mobile) with the lead sentence's position for the highlight effect.
- `engine.js`: shared by the Studio and the renderer (clip data, picks → placements → spec, the Player), so the MP4 matches the preview. `migratePicks` upgrades styles saved before the Moves/Animations split.
- **Render** (Watch step) runs `tools/render_studio.cjs`: headless Edge opens `studio/render.html`, draws every frame at 1080×1920, 30 fps with the same engine, pipes them to ffmpeg, then mixes the voice, each picked sound at the exact time of its move and the music bed, and masters to -14 LUFS (two-pass loudnorm, true peak -1.5 dB). About 3 minutes. Drafts go to `projects/<clip>/renders/<clip>-<style name>-vN.mp4` and are never overwritten.
- **Approve and save final** copies the draft to `C:\Users\nittz\VideoEditor\output`. Nothing goes there without that click.
- Needs `playwright-core` (installed in `editing-studio/node_modules`, uses the installed Edge, downloads no browsers). Run by hand: `node tools/render_studio.cjs job.json out.mp4` with the server running.

## Installed tools (shared with `C:\Users\nittz\VideoEditor`)

FFmpeg 9.0.2, Python 3.12, Node 24, whisper.cpp with `ggml-base` and `ggml-small.en`, HyperFrames 0.8.207.

## Clips

- `clips/drive-case-study.mp4`: copy of `VideoEditor/raw/drive-case-study/4.mp4` (1080x1920, 25 fps, 112 s).
- `clips/3.mp4`: "take advice from the right people" talk, from Google Drive (1080x1920, 25 fps, 119 s). Best-40 cut in `projects/3-best40/` (v2, 38.8 s) is what the Studio currently uses.
