"""Point the Studio at a cut: make its preview copies and word timings.

Usage:
    python tools/prepare_studio.py projects/<name>/cuts-vN.json [--data projects/<name>/studio]

Writes into studio/data/ (or --data, which the Studio then opens with ?data=<that folder>):
    preview.mp4   720x1280, keyframe every 0.2 s (big preview)
    proxy.mp4     360x640,  keyframe every 0.2 s, no audio (option cards)
    render.mp4    1080x1920, keyframe every 0.2 s, no audio (frames for the real render)
    clip.json     {name, source, video, duration, fps, cuts: [join times], words: [{word, start, end}]}

Each segment in the cuts file needs a "text" field with its exact words (fix the transcript by hand).
Words are placed inside that segment's loud parts, weighted by syllables, so captions land within
about 0.1 s without relying on whisper.cpp timestamps, which drift by over a second on long takes.
Beats are planned separately in studio/data/beats.json.
"""

import array
import json
import math
import os
import re
import subprocess
import sys
from pathlib import Path

STUDIO = Path(__file__).resolve().parent.parent
DATA = STUDIO / "studio" / "data"
RATE = 16000
FRAME = 0.01  # loudness window, seconds


def run(args):
    subprocess.run([str(a) for a in args], check=True)


def loudness(video):
    """dBFS per 10 ms frame of the video's audio."""
    pcm = subprocess.run(["ffmpeg", "-v", "error", "-i", str(video), "-ac", "1", "-ar", str(RATE),
                          "-f", "s16le", "-"], capture_output=True, check=True).stdout
    samples = array.array("h", pcm)
    n = int(RATE * FRAME)
    out = []
    for i in range(0, len(samples) - n + 1, n):
        chunk = samples[i:i + n]
        rms = (sum(x * x for x in chunk) / n) ** 0.5
        out.append(-99.0 if rms < 1 else 20 * math.log10(rms / 32768))
    return out


def syllables(word):
    w = re.sub(r"[^a-z]", "", word.lower())
    groups = len(re.findall(r"[aeiouy]+", w)) - (1 if w.endswith("e") and len(w) > 3 else 0)
    return max(groups, 1) + 0.4


def place_words(text, db, a, b, threshold):
    """Spread the words of one segment over its voiced frames between a and b (seconds)."""
    frames = [i for i in range(int(a / FRAME), min(int(b / FRAME), len(db))) if db[i] > threshold]
    if not frames:
        frames = list(range(int(a / FRAME), int(b / FRAME)))
    tokens = text.split()
    weights = [syllables(t) for t in tokens]
    total = sum(weights)
    words, acc = [], 0.0
    for tok, w in zip(tokens, weights):
        i0 = frames[min(int(acc / total * len(frames)), len(frames) - 1)]
        acc += w
        i1 = frames[min(int(acc / total * len(frames)) - 1, len(frames) - 1)]
        words.append({"word": tok, "start": round(i0 * FRAME, 3), "end": round((i1 + 1) * FRAME, 3)})
    return words


def probe(video):
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                          "stream=r_frame_rate,color_transfer", "-of", "json", str(video)],
                         capture_output=True, text=True, check=True).stdout
    s = json.loads(out)["streams"][0]
    num, den = s["r_frame_rate"].split("/")
    return round(int(num) / int(den), 3), s.get("color_transfer") in ("arib-std-b67", "smpte2084")


def scaler(w, h, hdr):
    # HDR (iPhone HLG) cuts are tone-mapped to SDR with BT.2446a plus a small contrast/saturation lift, which
    # matches the iPhone's own SDR look; BT.2390 came out flat and grey. The browser can't show HDR.
    # A clip that isn't 9:16 is filled and centre-cropped, never stretched.
    fit = f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},setsar=1"
    if hdr:
        return ("libplacebo=colorspace=bt709:color_primaries=bt709:color_trc=bt709:tonemapping=bt.2446a:format=yuv420p,"
                f"eq=contrast=1.05:saturation=1.12,{fit}")
    return fit


def main():
    global DATA
    spec = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    if "--data" in sys.argv:
        DATA = Path(sys.argv[sys.argv.index("--data") + 1]).resolve()
    DATA.mkdir(parents=True, exist_ok=True)
    # clip.json's video paths are read by pages in studio/, so they're relative to that folder.
    web = Path(os.path.relpath(DATA, STUDIO / "studio")).as_posix()
    render = STUDIO / spec["output"]
    fps, hdr = probe(render)

    common = ["-c:v", "libx264", "-preset", "fast", "-pix_fmt", "yuv420p",
              "-g", "5", "-keyint_min", "5", "-sc_threshold", "0", "-bf", "0", "-movflags", "+faststart"]
    run(["ffmpeg", "-y", "-v", "error", "-i", render, "-vf", scaler(720, 1280, hdr), "-crf", "23", *common,
         "-c:a", "aac", "-b:a", "160k", DATA / "preview.mp4"])
    run(["ffmpeg", "-y", "-v", "error", "-i", render, "-vf", scaler(360, 640, hdr), "-crf", "27", *common,
         "-an", DATA / "proxy.mp4"])
    run(["ffmpeg", "-y", "-v", "error", "-i", render, "-vf", scaler(1080, 1920, hdr), "-crf", "14", *common,
         "-an", DATA / "render.mp4"])

    db = loudness(render)
    loud = sorted(db)[int(len(db) * 0.9)]  # roughly the speaking level
    threshold = loud - 22
    words, cuts, t = [], [], 0.0
    for seg in spec["segments"]:
        length = seg["out"] - seg["in"]
        words += place_words(seg["text"], db, t, t + length, threshold)
        t += length
        cuts.append(round(t, 3))
    cuts.pop()  # the last "join" is the end of the clip

    (DATA / "clip.json").write_text(json.dumps({
        "name": Path(spec["output"]).stem,
        "source": spec["output"],
        "video": f"{web}/preview.mp4",
        "proxy": f"{web}/proxy.mp4",
        "duration": round(t, 3),
        "fps": fps,
        "cuts": cuts,
        "words": words,
    }, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"{len(words)} words, {len(cuts)} cuts, {t:.2f}s -> {DATA}")


if __name__ == "__main__":
    main()
