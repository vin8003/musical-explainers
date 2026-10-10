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

## Running Claude locally (no API key)

All Claude steps shell out to the Claude Code CLI in headless mode, using the logged-in subscription:

```bash
claude -p "$(cat prompts/script.md) Topic: ..." --output-format json --model sonnet
claude -p "$(cat prompts/factcheck.md)" --allowedTools WebSearch,WebFetch --output-format json
```

`scripts/claude.ts` wraps this (stdin prompt, JSON result, retry once on invalid output). The CLI must be installed and logged in once (`claude`, then `/login`). The Claude desktop app bundles a binary that is not on PATH; point `CLAUDE_BIN` at a real install instead. Do not set `ANTHROPIC_API_KEY`: if it is set, the CLI may bill the API instead of the subscription. Interactive alternative: run the same prompts as slash commands or skills inside a normal Claude Code session in this repo. Heavy batches count against subscription usage limits, so queue a few videos at a time rather than a large batch.

## 1. Topic selection

- **Input:** YouTube search suggestions, Google Trends, past analytics.
- **Output:** entries in `topics/backlog.json`.
- Each topic has `slug`, `title`, `category`, `angle` (the hook idea), `chorusIdea`, `status` and `priority`.
- Statuses: `queued` -> `scripting` -> `review` -> `approved` -> `scheduled` -> `published` (or `rejected`).
- Keep about 50 queued topics and mix categories so the channel doesn't feel repetitive.

## 2. Script + lyrics

- **Tool:** `claude -p` (Claude Code headless, local, subscription). Prompt in `prompts/script.md`; the spec JSON is parsed from stdout and validated against `VideoSpec`.
- **Output:** `specs/<slug>.json` (see `src/types.ts` for the `VideoSpec` shape).
- Structure: a hook in the first 5 seconds, 3–4 beats (one idea each), a chorus that states the key idea and repeats, and a recap.
- Two cuts from one spec: a 60s vertical Short and a 3–5 min main video.

## 3. Fact-check

- **Tool:** a second, independent `claude -p` run with `--allowedTools WebSearch,WebFetch`. Prompt in `prompts/factcheck.md`.
- **Output:** `specs/<slug>.sources.json`, one entry per claim with `claim`, `verdict` (`ok` / `fix` / `cut`) and `sources[]`.
- Any `fix` or `cut` sends the spec back to stage 2. Nothing moves on with unresolved claims.

## 4. Music

- **Tool:** optional and swappable (`scripts/providers/`). Default is a stub that produces no audio, so videos render silent on the spec's `bpm`. Costing for ElevenLabs is deferred. If enabled later: ElevenLabs Music API (official API). Suno/Udio only if used by hand under a plan that allows commercial use; don't use unofficial API wrappers.
- **Output:** `assets/<slug>/song.mp3`, plus `bpm` and `beatOffsetMs` in the spec.
- Record the tool, plan and license terms per track, in case of a Content ID dispute.

## 5. Narration

- **Tool:** optional and swappable provider, stub by default. If enabled later: ElevenLabs TTS with timestamps.
- **Output:** `assets/<slug>/voice.mp3` and per-word timings in the spec, so text pops land on the spoken word.

## 6. Animation

- **Tool:** Remotion. Manim for math/physics-heavy topics.
- Claude writes scenes only from the shared component library in `src/components` (Mascot, BeatFlash, TextPop, and more as they're added). New components go into the library, not into a one-off scene, so the style stays consistent.
- `src/theme.ts` holds the palette, fonts and easing. Don't hard-code colours in scenes.

## 7. Render

- `npx remotion render Explainer out/<slug>.mp4 --props=specs/<slug>.json`
- Remotion Lambda when local rendering becomes a bottleneck.

## 8. Self-review

- Run as a `claude -p` call that is given the still image paths to inspect.
- Render stills at fixed intervals plus every beat boundary (`npx remotion still`), and have Claude inspect them for overlapping or clipped text, off-screen elements, unreadable contrast, and audio/visual drift.
- Fix and re-render, with a cap on attempts before escalating to a human.

## 9. Human approval

- Done in the admin panel (`npm run admin`, Review tab): approve, or reject with notes. The decision is written to the topic in `topics/backlog.json`.
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
