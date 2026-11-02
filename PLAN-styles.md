# Plan: one system for styles (Studio + editorial-reel)

Written 2026-10-29 from a planning chat with the user. Edits happen in the Studio chat. This file is the brief.
Updated 2026-10-29 in the Studio chat with the user's decisions (below, "Decided").

## Decided (2026-10-29)

- **No `reel-studio` skill.** The Studio is the tool.
- **Step order:** Colours → Fonts → Captions → Hook → Moves → Sound → **Animations (last)** → Watch. Built.
- **Animations are opt-in, never constant.** Wikipedia page, split page, highlight, Notes / chat window, emoji
  stickers, keyword slams, count-up and step counter all live in the Animations step. Glass panel, over the shoulder
  and text behind the speaker are animations too (to build during the audit).
- **Approve every placement.** Every step that puts something in time shows "Where it appears": a track plus one row
  per place with time, the words spoken there, **Yes / No**, and a sound on/off. Sound has a sound map with Yes / No
  per place; Watch shows the full map. Renders use only what's Yes. Built (picks `off` / `mute`).
- **Place animations anywhere.** Animations step starts with "Add an animation where you want it": pick words, pick
  a type, type its text. Built. B-roll and motion graphics will be more types in this same picker (Phase 3).
- **Text colours** (text + highlight) on the Fonts step. Built. The Studio opens with only the Old edit's fonts and
  captions; everything else starts empty.
- **Next:** audit every style on every step one by one with the user, then add new ones step by step.

## The idea

The Studio is the editor: UI, engine and renderer. The `editorial-reel` skill (`~/.claude/skills/editorial-reel`) is
a separate HyperFrames pipeline the user built on 28 Oct. Its LOOK becomes the Studio's first style. Every step of
the Studio becomes a library that keeps growing with elements taken from the user's best-performing reference reels.

## Phase 1: the editorial look as style #1 (name it after the look, e.g. `dark-editorial`)

Source of truth: `editorial-reel/references/style.md` (the user's corrections), `references/graphics.md`,
`scripts/build.py`, worked example `examples/yes-men/edit.json`. Fonts in `editorial-reel/assets/fonts`, sounds in
`editorial-reel/assets/sfx`. Add each piece as an option card on its Studio step, then save the set as
`styles/<name>.json` so it shows on the first screen.

| Studio step | What to add |
|---|---|
| Colours | `contrast(1.1) saturate(.84) brightness(.86) hue-rotate(-4deg)` + teal soft-light tone, vignette, top and bottom gradients. Ink `#F5F3EE`. Dark editorial, face readable, no grain, no B&W. |
| Fonts | Instrument Serif (regular + italic) with Inter 700 caps. |
| Captions | "Editorial two-face": ONE caption spot, centred at chest height, inside the safe zone (y < 1470). **Serif mode:** small Instrument Serif words (62 px) build a line one by one; the impact phrase lands under them in Instrument Serif *italic* (sized to fit, max 175 px) with a letter-mask rise. **Sans mode:** one word at a time, Inter 700 caps, 50 px, quick pop; impact phrases switch to the big italic in the same spot. Alternate modes beat by beat. Italic ONLY on impact words (numbers, results, contrasts, the payoff). Serif lowercase (keep "I"), sans caps, no commas. |
| Hooks | Opening frame blurs into focus with one light sweep; the hook's impact word in the big italic. |
| Moves | Punch-in on impact words (1.06; big words 1.12, held to the end of the shot); zoom-blur cut into a close-up; whip-blur out of a scene; shots alternate wide 1.0 and close-up 1.25; slow push-in 1.0 -> 1.045 across every shot; a visual change every 2-4 s. |
| Animations (last step) | **Glass panel over the shoulder** (frosted card beside the head; kinds list / stat / bars / quote; only on wide shots); **paper infographic scenes** (full frame; lanes / stack / stat / list / versus). Wikipedia page, Notes popup and emoji stay as opt-in animations, not constants. |
| Sound | Accent sounds land at least 4 s apart (never a sound every 2-3 s); always one in the first 5 s; the riser builds into ONE big moment and lands with it (`riser-2s` peaks at 1.95 s, `riser` at 3.3 s; at most 1-2 per reel); big word = whoosh-short + impact-bass-2; payoff = boom; scene in = whoosh-cine-short, scene out = swish; clicks per item are the only exception to the gap. Show the moments as a pickable sound map; each sound lands on its move. Exact timings: `build.py` KINDS / LAND. |

Done when: the style loads from the first screen, every card plays on the current clip, and a Render matches the
preview.

## Phase 2: a library that grows with the best-performing reels

The user will keep feeding reels and pointing at the elements they want, step by step.

1. **Intake.** The user sends a reel (link or file) and names the element and step ("the captions", "the Notes
   popup at 0:04", "the grade"). Save it under `references/<reel-id>/` with a contact sheet (a frame every 0.5 s
   around the moment) and `notes.txt` (link, why it performs, what we took).
2. **Build.** Measure it on 1080x1920 and add it as an option card on that Studio step, playing on the current clip.
   Each catalog entry in `looks.js` carries `source: "<reel-id>"`, shown as a small badge on the card.
3. **Approve.** The user picks or rejects it in the Studio. Approved elements stay; notes become rules.
4. **Log.** `references/LIBRARY.md`: one row per element: step, name, source reel, date, status.
5. **Whole styles.** A whole style from one creator still goes through the guide's prompt 3 (style study) and comes
   out as `styles/<name>.json` + its rules. A style is just a set of picks from the library.

## Phase 3: animations and B-roll (the user is sending the full list)

- **Animations named so far** (all go in the Animations step): glass panel, over the shoulder, over the head (head
  breaks out of a panel), text behind the speaker.
- **Person matte.** Text behind the speaker and over the head need one, made once per clip in
  `tools/prepare_studio.py` (`npx hyperframes@0.8.207 remove-background`). The engine draws background frame ->
  text -> cut-out person.
- **B-roll as beat options, in this order:**
  1. The user's footage in `C:\Users\nittz\VideoEditor\broll\`
  2. Web footage from links (yt-dlp, only the seconds needed)
  3. Pexels stock (needs `PEXELS_API_KEY`; the user is setting it up)
  4. Real website and app screens (`npx hyperframes@0.8.207 capture`)

## Standing rules

- Local only: Studio and review pages on `localhost:8765`, not published.
- Drafts never overwrite. The final goes to `VideoEditor/output` only after the user OKs it.
- Ask before deleting or overwriting.
- Keep `README.md` current.
