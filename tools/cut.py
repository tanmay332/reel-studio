"""Cut a clip down to a list of segments and join them.

Usage:
    python tools/cut.py <cuts.json>

cuts.json:
    {"source": "clips/3.mp4", "output": "projects/x/renders/x-cut-v1.mp4",
     "segments": [{"in": 0.40, "out": 3.85, "note": "hook"}, ...],
     "scale": 1920}   (optional: shrink so the long side is at most this, e.g. 4K iPhone -> 1080x1920)

Paths are relative to editing-studio. Each join gets a 15 ms audio fade so cuts don't click.
Video is re-encoded (H.264 CRF 16) at the source frame rate and size.
HDR sources (iPhone HLG, or PQ) stay HDR: 10-bit HEVC (x265 veryfast, CRF 15: 4K at medium takes ~20 min here) with the source's colour tags, so nothing is tone-mapped.
"""

import json
import subprocess
import sys
from pathlib import Path

STUDIO = Path(__file__).resolve().parent.parent
FADE = 0.015
HDR_TRANSFERS = {"arib-std-b67", "smpte2084"}


def video_args(source):
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=color_transfer,color_primaries,color_space", "-of", "json", str(source)],
        capture_output=True, text=True, check=True,
    )
    tags = json.loads(probe.stdout)["streams"][0]
    if tags.get("color_transfer") not in HDR_TRANSFERS:
        return ["-c:v", "libx264", "-crf", "16", "-preset", "medium", "-pix_fmt", "yuv420p"]
    trc, prim, mat = tags["color_transfer"], tags.get("color_primaries", "bt2020"), tags.get("color_space", "bt2020nc")
    return [
        "-c:v", "libx265", "-crf", "15", "-preset", "veryfast", "-pix_fmt", "yuv420p10le", "-tag:v", "hvc1",
        "-x265-params", f"colorprim={prim}:transfer={trc}:colormatrix={mat}:log-level=error",
        "-color_primaries", prim, "-color_trc", trc, "-colorspace", mat,
    ]


def main():
    spec_path = Path(sys.argv[1]).resolve()
    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    source = STUDIO / spec["source"]
    output = STUDIO / spec["output"]
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        sys.exit(f"{output} already exists. Bump the version instead of overwriting.")

    parts, labels = [], []
    for i, seg in enumerate(spec["segments"]):
        a, b = seg["in"], seg["out"]
        d = b - a
        parts.append(f"[0:v]trim={a}:{b},setpts=PTS-STARTPTS[v{i}]")
        parts.append(
            f"[0:a]atrim={a}:{b},asetpts=PTS-STARTPTS,"
            f"afade=t=in:d={FADE},afade=t=out:st={d - FADE:.3f}:d={FADE}[a{i}]"
        )
        labels.append(f"[v{i}][a{i}]")
    parts.append(f"{''.join(labels)}concat=n={len(labels)}:v=1:a=1[vc][a]")
    long_side = spec.get("scale")
    # Resizing keeps HDR as HDR (the colour tags are set on the encode); it only saves encode time.
    parts.append(f"[vc]scale='if(gt(iw,ih),min(iw,{long_side}),-2)':'if(gt(iw,ih),-2,min(ih,{long_side}))'[v]"
                 if long_side else "[vc]null[v]")

    subprocess.run([
        "ffmpeg", "-y", "-v", "error", "-i", str(source),
        "-filter_complex", ";".join(parts), "-map", "[v]", "-map", "[a]",
        *video_args(source),
        "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(output),
    ], check=True)

    total = sum(s["out"] - s["in"] for s in spec["segments"])
    print(f"{len(spec['segments'])} segments, {total:.2f}s -> {output}")


if __name__ == "__main__":
    main()
