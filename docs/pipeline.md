# Pipeline

Each stage reads the previous stage's output from disk, so any stage can be re-run on its own. Everything for one video lives under a slug, e.g. `how-does-the-internet-work`.

```
topics/backlog.json
   │  1. pick topic (status: queued -> scripting)
   ▼
specs/<slug>.json            VideoSpec: script, lyrics, beats, chorus, recap
   │  3. fact-check -> specs/<slug>.sources.json
   │  4. music      -> assets/<slug>/song.mp3   (+ bpm written into spec)
   │  5. narration  -> assets/<slug>/voice.mp3  (+ word timestamps into spec)
   ▼
src/ (Remotion)              6. Explainer composition renders the spec
   │  7. render     -> out/<slug>.mp4, out/<slug>-short.mp4
   │  8. self-review: sample frames -> fix spec/scenes -> re-render
   ▼
[approval]                   9. human watches at 2x, approves or leaves notes
   │ 10. thumbnail + metadata -> out/<slug>.thumb.png, out/<slug>.meta.json
   ▼
YouTube                      11. videos.insert with publishAt (status: scheduled)
```

## 1. Topic selection

- **Input:** YouTube search suggestions, Google Trends, past analytics.
- **Output:** entries in `topics/backlog.json`.
- Each topic has `slug`, `title`, `category`, `angle` (the hook idea), `chorusIdea`, `status` and `priority`.
- Statuses: `queued` -> `scripting` -> `review` -> `approved` -> `scheduled` -> `published` (or `rejected`).
- Keep about 50 queued topics and mix categories so the channel doesn't feel repetitive.

## 2. Script + lyrics

- **Tool:** Claude API.
- **Output:** `specs/<slug>.json` (see `src/types.ts` for the `VideoSpec` shape).
- Structure: a hook in the first 5 seconds, 3–4 beats (one idea each), a chorus that states the key idea and repeats, and a recap.
- Two cuts from one spec: a 60s vertical Short and a 3–5 min main video.

## 3. Fact-check

- **Tool:** a second, independent Claude pass with web search.
- **Output:** `specs/<slug>.sources.json`, one entry per claim with `claim`, `verdict` (`ok` / `fix` / `cut`) and `sources[]`.
- Any `fix` or `cut` sends the spec back to stage 2. Nothing moves on with unresolved claims.

## 4. Music

- **Tool:** ElevenLabs Music API (official API). Suno/Udio only if used by hand under a plan that allows commercial use; don't use unofficial API wrappers.
- **Output:** `assets/<slug>/song.mp3`, plus `bpm` and `beatOffsetMs` in the spec.
- Record the tool, plan and license terms per track, in case of a Content ID dispute.

## 5. Narration

- **Tool:** ElevenLabs TTS with timestamps.
- **Output:** `assets/<slug>/voice.mp3` and per-word timings in the spec, so text pops land on the spoken word.

## 6. Animation

- **Tool:** Remotion. Manim for math/physics-heavy topics.
- Claude writes scenes only from the shared component library in `src/components` (Mascot, BeatFlash, TextPop, and more as they're added). New components go into the library, not into a one-off scene, so the style stays consistent.
- `src/theme.ts` holds the palette, fonts and easing. Don't hard-code colours in scenes.

## 7. Render

- `npx remotion render Explainer out/<slug>.mp4 --props=specs/<slug>.json`
- Remotion Lambda when local rendering becomes a bottleneck.

## 8. Self-review

- Render stills at fixed intervals plus every beat boundary (`npx remotion still`), and have Claude inspect them for overlapping or clipped text, off-screen elements, unreadable contrast, and audio/visual drift.
- Fix and re-render, with a cap on attempts before escalating to a human.

## 9. Human approval

- One notification per video with the MP4, the sources file and the metadata.
- Approve, or reply with notes that go back into stage 2 or 6.

## 10. Thumbnail + metadata

- Thumbnail rendered as a Remotion still from the same components (mascot + one bold phrase).
- Claude writes the title, description (with sources), tags and chapters from the beat timings.
- Prepare 2–3 thumbnail variants for YouTube's Test & Compare.

## 11. Upload

- YouTube Data API v3 `videos.insert`, `status.privacyStatus = private` with `status.publishAt` for scheduling.
- Always set `status.selfDeclaredMadeForKids` deliberately, and the altered/synthetic content disclosure where it applies.
- Until the API project passes Google's audit, uploads stay private: upload by hand for the first weeks.

## 12. Scheduling

- A scheduled job (Claude Code scheduled task, cron, or GitHub Actions) produces e.g. 3 videos a week up to stage 9 and then waits for approval.
- A weekly job reads YouTube Analytics (retention, CTR) and writes recommendations back into the backlog priorities.
