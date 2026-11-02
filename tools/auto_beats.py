"""Plan beats for a freshly imported clip, so the Studio has something to offer on every step.

Usage:
    python tools/auto_beats.py <studio data folder>      (reads clip.json, writes beats.json)

A beats.json written by hand (no "auto": true in it) is never replaced.

- Hook: the first sentence (up to ~6 s), its text as the title; you can retype it in the Hook step.
- Beats: 6 to 14 s each, split on cuts and sentence ends, labelled with their first words.
- Keywords (two-tone / serif caption accents) and impact words (punch-ins): the longest, least common
  words, about one every 4 seconds. No "big" moments: shakes aren't part of the quiet luxury look.
- Suggestions per beat, all in the quiet style: the beat's key word surfacing from a soft blur, and a
  glass note above the head with its first line. Everything stays off until you tick it.
"""

import json
import re
import sys
from pathlib import Path

STOP = set("""a about above after again all also am an and any are as at be because been before being below
between both but by can could did do does doing down during each even every few for from further get gets
going gonna got had has have having he her here hers him his how i if in into is it its itself just know
let like look make me more most much my need now of off on once one only or other our out over own really
right said same say says see she should so some something still such take than that thats the their them
then there these they thing things think this those through to too under until up us very want was way we
well were what when where which while who why will with would yeah yes you your youre youve im ive dont
cant theres heres lets kind actually basically literally pretty okay ok using people everyone anyone someone everything anything because""".split())


def clean(w):
    return re.sub(r"[^\w'’$%-]", "", w)


def key(w):
    return re.sub(r"[^a-z0-9]", "", w.lower())


def sentence_ends(words):
    return [i for i, w in enumerate(words) if re.search(r"[.?!]$", w["word"])]


def score(w, counts):
    k = key(w["word"])
    if not k or k in STOP or len(k) < 4 and not k.isdigit():
        return 0
    return len(k) + (4 if k.isdigit() or "$" in w["word"] or "%" in w["word"] else 0) - 2 * (counts[k] - 1)


def title(text, n=9):
    ws = text.split()
    return " ".join(ws[:n]) + ("…" if len(ws) > n else "")


def plan(clip):
    words, dur, cuts = clip["words"], clip["duration"], clip.get("cuts", [])
    ends = sentence_ends(words)
    counts = {}
    for w in words:
        counts[key(w["word"])] = counts.get(key(w["word"]), 0) + 1

    # Hook: the first sentence (at least 2 s), ending in the pause after it, never past 6.5 s.
    first = next((i for i in ends if words[i]["end"] >= 2.0), len(words) - 1)
    while first > 0 and words[first]["end"] > 6.5:
        first -= 1
    hook_end = words[first + 1]["start"] if first + 1 < len(words) else dur
    hook_end = round(min(max(hook_end, words[first]["end"] + 0.1), dur), 2)
    hook_ws = [w["word"] for w in words[: first + 1]]
    if len(hook_ws) > 9:
        # Too long for a title: end at its last comma inside the first 9 words, else the first 9 words.
        comma = max((i for i, w in enumerate(hook_ws[:9]) if w.endswith(",") and i >= 3), default=8)
        rest, hook_ws = hook_ws[comma + 1:], hook_ws[: comma + 1]
    else:
        rest = []
    line1 = " ".join(hook_ws).rstrip(",")
    second = rest[:]
    for w in ([] if rest else words[first + 1:]):
        w = w["word"]
        second.append(w)
        if re.search(r"[.?!]$", w):
            break
    line2 = " ".join(second) if 0 < len(second) <= 7 else ""
    l1_words = [clean(w) for w in line1.split()]
    slam = max(l1_words, key=lambda w: 0 if key(w) in STOP else len(w), default="").upper()

    # Beat boundaries: cuts and the starts of sentences.
    starts = sorted({round(c, 2) for c in cuts} | {round(words[i + 1]["start"], 2) for i in ends if i + 1 < len(words)})
    bounds, t = [], hook_end
    while dur - t > 9:
        cands = [c for c in starts if t + 6 <= c <= t + 14]
        c = min(cands, key=lambda c: abs(c - (t + 10))) if cands else t + 10
        bounds.append((t, c))
        t = c
    if dur - t >= 4 or not bounds:
        bounds.append((t, dur))
    else:
        bounds[-1] = (bounds[-1][0], dur)

    beats = [{"id": "b1", "label": "Hook", "start": 0, "end": hook_end, "hook": True}]
    keywords, impact = [], []
    for k, (a, b) in enumerate(bounds):
        bid = f"b{k + 2}"
        inside = [w for w in words if a - 0.05 <= w["start"] < b]
        label = title(" ".join(clean(w["word"]) for w in inside), 3) if inside else f"Part {k + 2}"
        beat = {"id": bid, "label": label, "start": round(a, 2), "end": round(b, 2), "options": []}
        ranked = sorted(inside, key=lambda w: -score(w, counts))
        best = [w for w in ranked if score(w, counts) > 0][: max(1, round((b - a) / 4))]
        keywords += [key(w["word"]) for w in best]
        if best:
            top = best[0]
            impact.append(round(top["start"], 2))
            beat["options"].append({
                "id": f"{bid}-auto-word", "kind": "word", "label": f"“{clean(top['word']).capitalize()}” surfaces, quietly",
                "items": [{"text": clean(top["word"]).capitalize(), "at": round(top["start"], 2), "hold": 2}],
            })
        if inside:
            line = []
            for w in inside:
                line.append(clean(w["word"]))
                if re.search(r"[.?!,]$", w["word"]) and len(line) >= 4 or len(line) >= 9:
                    break
            at = round(inside[0]["start"], 2)
            beat["options"].append({
                "id": f"{bid}-auto-glass", "kind": "chat", "style": "glass", "title": "Notes", "y": 210, "soundOnce": True,
                "label": f"Glass note: “{title(' '.join(line), 6)}”", "lines": [{"text": " ".join(line), "at": at}],
                "until": round(min(at + max(3.0, len(line) * 0.45), b), 2),
            })
        beats.append(beat)

    return {
        "auto": True,
        "hook": {"lines": [line1, line2], "slam": slam, "mark": l1_words[-1] if l1_words else ""},
        "keywords": sorted(set(keywords)),
        "impact": impact,
        "big": [],
        "beats": beats,
    }


def main():
    data = Path(sys.argv[1])
    out = data / "beats.json"
    if out.exists() and not json.loads(out.read_text(encoding="utf-8")).get("auto"):
        print(f"{out} was written by hand; leaving it alone.")
        return
    clip = json.loads((data / "clip.json").read_text(encoding="utf-8"))
    result = plan(clip)
    out.write_text(json.dumps(result, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"{len(result['beats'])} beats, {len(result['keywords'])} keywords -> {out}")


if __name__ == "__main__":
    main()
