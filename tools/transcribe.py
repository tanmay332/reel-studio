"""Transcribe a video to word-level timestamps.

Usage:
    python tools/transcribe.py <video> [--engine groq|local] [--model PATH]

Writes <video-name>.words.json next to the video:
    {"source": ..., "engine": ..., "duration": ..., "text": ...,
     "words": [{"word": "Hello", "start": 0.12, "end": 0.48}, ...]}

Engine:
    groq   Groq Whisper API (whisper-large-v3). Needs GROQ_API_KEY in editing-studio/.env.
    local  whisper.cpp (whisper-cli) with a local ggml model. Slower, no key needed.
    Default: groq if a key is set, otherwise local.
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
import uuid
from pathlib import Path

STUDIO = Path(__file__).resolve().parent.parent
LOCAL_MODEL = Path(r"C:\Users\nittz\VideoEditor\models\ggml-small.en.bin")
WHISPER_CLI = Path(r"C:\Users\nittz\VideoEditor\tools\whisper\Release\whisper-cli.exe")
GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions"


def load_env():
    env_file = STUDIO / ".env"
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def extract_audio(video, out, fmt):
    # 16 kHz mono: what whisper.cpp needs, and small enough for Groq's upload limit.
    args = ["ffmpeg", "-y", "-v", "error", "-i", str(video), "-vn", "-ac", "1", "-ar", "16000"]
    args += ["-c:a", "flac"] if fmt == "flac" else ["-c:a", "pcm_s16le"]
    subprocess.run(args + [str(out)], check=True)


def duration_of(video):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(video)],
        capture_output=True, text=True, check=True,
    )
    return round(float(out.stdout.strip()), 3)


def transcribe_groq(video, tmp):
    audio = Path(tmp) / "audio.flac"
    extract_audio(video, audio, "flac")

    boundary = uuid.uuid4().hex
    fields = [
        ("model", "whisper-large-v3"),
        ("response_format", "verbose_json"),
        ("timestamp_granularities[]", "word"),
        ("timestamp_granularities[]", "segment"),
        ("language", "en"),
    ]
    body = b""
    for name, value in fields:
        body += f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
    body += (
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.flac"\r\n'
        f"Content-Type: audio/flac\r\n\r\n"
    ).encode() + audio.read_bytes() + f"\r\n--{boundary}--\r\n".encode()

    req = urllib.request.Request(GROQ_URL, data=body, method="POST", headers={
        "Authorization": f"Bearer {os.environ['GROQ_API_KEY']}",
        "Content-Type": f"multipart/form-data; boundary={boundary}",
    })
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            data = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        sys.exit(f"Groq API error {e.code}: {e.read().decode(errors='replace')}")

    words = [
        {"word": w["word"].strip(), "start": round(w["start"], 3), "end": round(w["end"], 3)}
        for w in data.get("words", []) if w["word"].strip()
    ]
    return words, data.get("text", "").strip()


def transcribe_local(video, tmp, model):
    if not WHISPER_CLI.exists():
        sys.exit(f"whisper-cli not found at {WHISPER_CLI}")
    audio = Path(tmp) / "audio.wav"
    extract_audio(video, audio, "wav")
    out_base = Path(tmp) / "out"
    # -ml 1 -sow: one word per segment, split on word boundaries, so each segment's offsets are word times.
    subprocess.run(
        [str(WHISPER_CLI), "-m", str(model), "-f", str(audio), "-ml", "1", "-sow",
         "-oj", "-of", str(out_base), "-np", "-l", "en"],
        check=True,
    )
    data = json.loads((out_base.with_suffix(".json")).read_text(encoding="utf-8"))
    words = []
    for seg in data.get("transcription", []):
        text = seg["text"].strip()
        if not text or (text.startswith("[") and text.endswith("]")):
            continue
        start, end = seg["offsets"]["from"] / 1000, seg["offsets"]["to"] / 1000
        # whisper.cpp sometimes emits trailing punctuation as its own segment; glue it to the previous word.
        if words and not any(c.isalnum() for c in text):
            words[-1]["word"] += text
            words[-1]["end"] = round(end, 3)
            continue
        words.append({"word": text, "start": round(start, 3), "end": round(end, 3)})
    return words, " ".join(w["word"] for w in words)


def main():
    load_env()
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("video")
    parser.add_argument("--engine", choices=["groq", "local"])
    parser.add_argument("--model", default=str(LOCAL_MODEL), help="ggml model for --engine local")
    args = parser.parse_args()

    video = Path(args.video).resolve()
    if not video.exists():
        sys.exit(f"No such file: {video}")
    engine = args.engine or ("groq" if os.environ.get("GROQ_API_KEY") else "local")
    if engine == "groq" and not os.environ.get("GROQ_API_KEY"):
        sys.exit("GROQ_API_KEY is not set. Add it to editing-studio/.env or use --engine local.")

    print(f"Transcribing {video.name} with {engine}...", file=sys.stderr)
    with tempfile.TemporaryDirectory() as tmp:
        if engine == "groq":
            words, text = transcribe_groq(video, tmp)
        else:
            words, text = transcribe_local(video, tmp, args.model)

    out = video.with_suffix(".words.json")
    out.write_text(json.dumps({
        "source": video.name,
        "engine": "groq/whisper-large-v3" if engine == "groq" else f"whisper.cpp/{Path(args.model).stem}",
        "duration": duration_of(video),
        "text": text,
        "words": words,
    }, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"{len(words)} words -> {out}", file=sys.stderr)


if __name__ == "__main__":
    main()
