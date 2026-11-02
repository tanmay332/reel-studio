"""Bring a new video into the Studio without asking Claude: the "Add video" button runs this.

Usage:
    python tools/import_clip.py fetch <file | folder path | .zip | link> --name <name>
    python tools/import_clip.py build projects/<name>

fetch  copies the video into clips/ (or downloads a Google Drive / YouTube / Instagram link with yt-dlp,
       or pulls the biggest video out of a .zip), transcribes it, and splits it into phrases at the
       natural pauses. Writes projects/<name>/import.json: every phrase with its time, its words and
       keep: true/false (likely retakes of a later line start as false).
build  reads the phrases you kept (and any text you corrected) from import.json, cuts them together
       on the pauses (tools/cut.py, so joins never land mid-word), makes the Studio's preview files in
       projects/<name>/studio/ (tools/prepare_studio.py) and plans the beats (tools/auto_beats.py).

Progress goes to projects/<name>/import-progress.json for the Studio to show.
"""

import argparse
import json
import re
import shutil
import subprocess
import sys
import traceback
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from prepare_studio import FRAME, loudness  # noqa: E402

STUDIO = Path(__file__).resolve().parent.parent
CLIPS = STUDIO / "clips"
VIDEO_EXT = {".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi"}
MIN_PAUSE = 0.3   # a silence at least this long splits two phrases
JOIN_GAP = 0.6    # kept phrases closer than this in the source stay joined, pause and all
PAD_IN, PAD_OUT = 0.12, 0.18


def slugify(name):
    return re.sub(r"[^a-z0-9]+", "-", str(name or "").lower()).strip("-")[:48] or "clip"


class Progress:
    def __init__(self, project):
        self.file = project / "import-progress.json"
        self.data = {}

    def __call__(self, **fields):
        self.data.update(fields)
        # Write then swap, so a crash or a reader never sees half a file.
        tmp = self.file.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.data), encoding="utf-8")
        tmp.replace(self.file)


def run(args, **kw):
    r = subprocess.run([str(a) for a in args], capture_output=True, text=True, **kw)
    if r.returncode != 0:
        raise RuntimeError((r.stderr or r.stdout).strip().splitlines()[-1] if (r.stderr or r.stdout).strip() else "failed")
    return r.stdout


def probe(video):
    out = json.loads(run(["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type",
                          "-of", "json", video]))
    kinds = {s.get("codec_type") for s in out.get("streams", [])}
    if "video" not in kinds:
        raise RuntimeError(f"{video.name} has no video in it.")
    if "audio" not in kinds:
        raise RuntimeError(f"{video.name} has no sound, so there is nothing to transcribe.")
    return float(out["format"]["duration"])


def unique(path):
    n, out = 2, path
    while out.exists():
        out = path.with_name(f"{path.stem}-{n}{path.suffix}")
        n += 1
    return out


def biggest_video(paths):
    vids = [p for p in paths if p.suffix.lower() in VIDEO_EXT]
    if not vids:
        raise RuntimeError("No video file found there (looked for .mp4, .mov, .m4v, .mkv, .webm).")
    return max(vids, key=lambda p: p.stat().st_size)


def fetch_source(src, slug, say):
    """Return the video's path inside clips/."""
    CLIPS.mkdir(exist_ok=True)
    if re.match(r"https?://", src):
        if "drive.google.com/drive/folders" in src:
            raise RuntimeError("That's a Drive folder. Open the folder, right-click the video, Share > Copy link, and paste that.")
        say(stage="download", msg="Downloading the video")
        tmpl = str(CLIPS / f"{slug}.%(ext)s")
        r = subprocess.run(["yt-dlp", "--no-playlist", "-f", "bv*+ba/b", "--merge-output-format", "mp4",
                            "--no-part", "-o", tmpl, src], capture_output=True, text=True)
        got = sorted(CLIPS.glob(f"{slug}.*"), key=lambda p: p.stat().st_mtime)
        got = [p for p in got if p.suffix.lower() in VIDEO_EXT]
        if r.returncode != 0 or not got:
            tail = (r.stderr or "").strip().splitlines()[-1:] or ["no file"]
            raise RuntimeError("Couldn't download that link. If it's a Google Drive file, set sharing to "
                               f"'Anyone with the link'. ({tail[0][:200]})")
        return got[-1]

    path = Path(src.strip().strip('"').strip("'")).expanduser()
    if not path.is_absolute():
        path = STUDIO / path
    if not path.exists():
        raise RuntimeError(f"Can't find {path}")
    if path.is_dir():
        path = biggest_video([p for p in path.rglob("*") if p.is_file()])
    if path.suffix.lower() == ".zip":
        say(stage="copy", msg="Unzipping")
        with zipfile.ZipFile(path) as z:
            members = [m for m in z.infolist() if Path(m.filename).suffix.lower() in VIDEO_EXT and not m.filename.startswith("__MACOSX")]
            if not members:
                raise RuntimeError("No video inside that .zip.")
            m = max(members, key=lambda m: m.file_size)
            dest = unique(CLIPS / f"{slug}{Path(m.filename).suffix.lower()}")
            with z.open(m) as fin, open(dest, "wb") as fout:
                shutil.copyfileobj(fin, fout, 1024 * 1024)
            return dest
    if path.suffix.lower() not in VIDEO_EXT:
        raise RuntimeError(f"{path.name} isn't a video file.")
    if CLIPS in path.resolve().parents:
        return path.resolve()
    say(stage="copy", msg="Copying the video into clips/")
    dest = unique(CLIPS / f"{slug}{path.suffix.lower()}")
    shutil.copy2(path, dest)
    return dest


def split_long(db, runs, longest=8.0, dip=0.12):
    """Split any run over `longest` s at its quietest `dip`-long moment (always between words), until none is."""
    w = int(dip / FRAME)
    out, todo = [], list(runs)
    while todo:
        a, b = todo.pop(0)
        if b - a <= longest:
            out.append([a, b])
            continue
        i0, i1 = int((a + 1.5) / FRAME), int((b - 1.5) / FRAME) - w
        k = min(range(i0, i1), key=lambda i: sum(db[i:i + w]))
        todo[:0] = [[a, round(k * FRAME, 2)], [round((k + w) * FRAME, 2), b]]
    return out


def find_phrases(db, duration):
    """Speech runs between pauses of at least MIN_PAUSE, as [start, end] seconds.
    "Quiet" sits 40% of the way from the room's noise floor to the speaking level, so traffic or AC
    under the voice doesn't count as talking."""
    s = sorted(db)
    noise, loud = s[int(len(s) * 0.05)], s[int(len(s) * 0.9)]
    voiced = [x > noise + 0.4 * (loud - noise) for x in db]
    runs, i, n = [], 0, len(voiced)
    while i < n:
        if not voiced[i]:
            i += 1
            continue
        j = i
        quiet = 0
        while j < n and quiet < MIN_PAUSE / FRAME:
            quiet = 0 if voiced[j] else quiet + 1
            j += 1
        end = j - quiet
        if (end - i) * FRAME >= 0.15:
            runs.append([round(i * FRAME, 2), round(min(end * FRAME, duration), 2)])
        i = j
    return split_long(db, runs)


def norm(s):
    return re.sub(r"[^a-z0-9 ]", "", s.lower()).strip()


def mark_retakes(out):
    """A line that starts again with the same words within the next few phrases is a false start;
    keep the later, complete take."""
    toks = [(k, t) for k, p in enumerate(out) for t in norm(p["text"]).split()]
    for j, p in enumerate(out):
        head = norm(p["text"]).split()[:5]
        if len(head) < 4:
            continue
        before = [(k, t) for k, t in toks if j - 4 <= k < j]
        words_before = [t for _, t in before]
        for s in range(len(words_before) - len(head) + 1):
            if words_before[s:s + len(head)] == head:
                for k in range(before[s][0], j):
                    if out[k]["keep"]:
                        out[k]["keep"] = False
                        out[k]["note"] = "Looks like a false start: said again just after"
                break


def build_phrases(runs, words):
    phrases = [{"start": a, "end": b, "words": []} for a, b in runs]
    if not phrases:
        return []
    for w in words:
        mid = (w["start"] + w["end"]) / 2
        best = min(phrases, key=lambda p: 0 if p["start"] <= mid <= p["end"] else min(abs(mid - p["start"]), abs(mid - p["end"])))
        best["words"].append(w["word"])
    out = []
    for k, p in enumerate(phrases):
        text = " ".join(p["words"]).strip()
        out.append({"id": k, "start": p["start"], "end": p["end"], "text": text, "keep": bool(text), "note": "" if text else "No words heard"})
    mark_retakes(out)
    return out


def fetch(args):
    slug = slugify(args.name)
    project = STUDIO / "projects" / slug
    project.mkdir(parents=True, exist_ok=True)
    say = Progress(project)
    say(state="running", stage="copy", msg="Getting the video", project=f"projects/{slug}", name=args.name)
    try:
        video = fetch_source(args.source, slug, say)
        duration = probe(video)
        say(stage="listen", msg="Listening for pauses")
        audio = project / "source-audio.mp3"  # for playing each phrase in the cut screen
        run(["ffmpeg", "-y", "-v", "error", "-i", video, "-vn", "-ac", "1", "-b:a", "64k", audio])
        db = loudness(video)
        runs = find_phrases(db, duration)

        say(stage="transcribe", msg=f"Transcribing {duration:.0f} s of speech (about {max(1, round(duration / 40))} min on this laptop)")
        r = subprocess.run([sys.executable, str(STUDIO / "tools" / "transcribe.py"), str(video)], capture_output=True, text=True)
        if r.returncode != 0:
            raise RuntimeError("Transcribing failed: " + (r.stderr.strip().splitlines() or ["unknown"])[-1])
        words = json.loads(video.with_suffix(".words.json").read_text(encoding="utf-8"))["words"]
        phrases = build_phrases(runs, words)
        if not any(p["text"] for p in phrases):
            raise RuntimeError("No speech found in this video.")
        (project / "import.json").write_text(json.dumps({
            "name": args.name, "slug": slug, "source": video.relative_to(STUDIO).as_posix(),
            "audio": audio.relative_to(STUDIO).as_posix(), "duration": round(duration, 2), "phrases": phrases,
        }, indent=1, ensure_ascii=False), encoding="utf-8")
        say(state="ready", stage="pick", msg="Pick the lines to keep")
    except Exception as e:  # shown in the Studio
        traceback.print_exc()
        say(state="error", msg=str(e))
        sys.exit(1)


def segments_from(phrases, duration):
    """Kept phrases -> cut segments, padded into the pauses so no join lands on a word."""
    segs, prev = [], None
    for k, p in enumerate(phrases):
        if not p.get("keep"):
            continue
        before = phrases[k - 1]["end"] if k else 0.0
        after = phrases[k + 1]["start"] if k + 1 < len(phrases) else duration
        a = max(p["start"] - PAD_IN, (before + p["start"]) / 2 if k else 0.0)
        b = min(p["end"] + PAD_OUT, (p["end"] + after) / 2 if k + 1 < len(phrases) else duration)
        if prev is not None and prev["last"] == k - 1 and p["start"] - phrases[k - 1]["end"] <= JOIN_GAP:
            prev.update(out=round(b, 3), text=f'{prev["text"]} {p["text"]}'.strip(), last=k)
            continue
        prev = {"in": round(a, 3), "out": round(b, 3), "text": p["text"], "last": k}
        segs.append(prev)
    for s in segs:
        s["note"] = s["text"][:80]
        del s["last"]
    return [s for s in segs if s["text"]]


def build(args):
    project = (STUDIO / args.project).resolve()
    say = Progress(project)
    info = json.loads((project / "import.json").read_text(encoding="utf-8"))
    slug = info["slug"]
    say(state="running", stage="cut", msg="Cutting your lines together", project=f"projects/{slug}", name=info["name"])
    try:
        segs = segments_from(info["phrases"], info["duration"])
        if not segs:
            raise RuntimeError("Keep at least one line.")
        n = 1
        while (project / f"cuts-v{n}.json").exists():
            n += 1
        spec = {"source": info["source"], "output": f"projects/{slug}/renders/{slug}-cut-v{n}.mp4",
                "scale": 1920, "segments": segs}
        cuts = project / f"cuts-v{n}.json"
        cuts.write_text(json.dumps(spec, indent=2, ensure_ascii=False), encoding="utf-8")
        total = sum(s["out"] - s["in"] for s in segs)
        say(msg=f"Cutting {len(segs)} pieces into {total:.1f} s (HDR iPhone footage takes a few minutes)")
        run([sys.executable, STUDIO / "tools" / "cut.py", cuts])
        say(stage="previews", msg="Making the Studio's preview copies")
        data = project / "studio"
        run([sys.executable, STUDIO / "tools" / "prepare_studio.py", cuts, "--data", data])
        say(stage="beats", msg="Planning beats and suggestions")
        run([sys.executable, STUDIO / "tools" / "auto_beats.py", data])
        rel = Path("..") / data.relative_to(STUDIO)
        say(state="done", stage="done", msg=f"Ready: {total:.1f} s", data=rel.as_posix())
    except Exception as e:
        traceback.print_exc()
        say(state="error", msg=str(e))
        sys.exit(1)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("fetch")
    f.add_argument("source")
    f.add_argument("--name", required=True)
    b = sub.add_parser("build")
    b.add_argument("project")
    args = ap.parse_args()
    (fetch if args.cmd == "fetch" else build)(args)


if __name__ == "__main__":
    main()
