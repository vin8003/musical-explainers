# musical-explainers

A YouTube channel of musical explainer videos, produced mostly by Claude with a few minutes of human review per video.

The core idea: **Claude writes and directs; code renders.** Instead of asking an AI video generator for clips (characters drift, diagrams come out wrong, every clip costs money), Claude writes a fact-checked script, then a structured storyboard, and a library of code-driven scene systems ([Remotion](https://www.remotion.dev/)) renders it. Optional Blender clips add real 3D where depth genuinely helps. Every render is reproducible, costs nothing extra, and can be checked and fixed automatically.

## What it does today

- **A real storyboard stage.** `specs/<slug>.json` is a validated, versioned storyboard (VideoSpec v2): per shot, the narration and lyric, a visual system with its own data (network diagram nodes and packet routes, anatomy callouts, journey stops...), camera move, transition, mascot, musical accents, and whether it belongs in the vertical Short. Old v1 specs are migrated automatically.
- **Twelve scene systems** (`src/shots/`): title cards, kinetic typography, network diagrams with packets hopping along routes, a file cut into packets and reassembled, anatomy close-ups with callouts, parallax journeys, flows, quantity comparisons, two-column comparisons, timelines, numbered steps and a mascot character shot, plus `scene3d` for Blender clips with a 2D fallback. They share one art direction (`src/theme.ts`: four colour "worlds", Avenir Next, one easing language), safe areas and text fitting for 16:9 and 9:16 (`src/layout.ts`), and a code-drawn illustration library (`src/assets/icons.tsx`).
- **Music and narration that drive the edit.** Narration (macOS `say`) is measured first; shots are cut to whole bars of the song; a built-in composer arranges music on that timeline by section; the chorus is sung (pitch-shifted speech) on the beat with the words landing on screen at the same frames; SFX mark transitions and selected accents; the mix is ducked and normalised to -14 LUFS. All local and free. ElevenLabs is an optional, off-by-default provider.
- **A staged, recoverable pipeline** (`npm run pipeline`): script, fact-check (with web search and bounded revision, re-run only for new text, including diagram labels), direction, assets, audio, render, QA, packaging. Status is computed from files; stale work re-runs, fresh work is cached; locks, cancellation, archives and immutable render candidates keep good output safe.
- **Automated QA on the actual files**: streams, durations, loudness, silence, sampled frames (blank, frozen, repeated, touching the edge, missing assets), text fit, contact sheets, and an optional Claude review of the frames.
- **An admin panel** (`npm run admin`) that runs all of it from the browser.

See [docs/pipeline.md](docs/pipeline.md) for every stage, file, flag and recovery step.

## Quick start

```bash
npm install
claude --version          # Claude Code CLI, logged in with your subscription (no API key)
npm run admin             # http://localhost:4321: the production cockpit
npm run pipeline -- how-does-the-internet-work            # continue production from wherever it is
npm run pipeline -- "Why is the sky blue?" --fresh        # new video from a backlog topic
npm run studio            # Remotion Studio, for working on scene systems
npm test && npm run typecheck
```

Requirements: Node 18+, ffmpeg on PATH, the `claude` CLI for script/fact-check/direction, macOS `say` for the default narration (without it, videos get music only and are marked "partial audio"). Optional: Blender 4.2+ for 3D clips (found at `/Applications/Blender.app` or via `BLENDER_BIN`).

Start the panel with the same Node that installed `node_modules` (native arm64 on Apple Silicon, e.g. `/opt/homebrew/bin/npm run admin`); the panel warns if they don't match. If you see an esbuild "installed for another platform" error, reinstall `node_modules` from a terminal where `node -p process.arch` prints `arm64`.

## Admin panel

`npm run admin` serves a local-only panel (127.0.0.1, same-origin writes only, no extra dependencies). It shells out to the pipeline, one job at a time, and never re-implements pipeline rules in the browser.

- **Videos** and **Backlog**: every topic with a status chip per stage (up to date, out of date, failed, not done) and its sound status; add, edit, reorder and re-status topics.
- **Overview**: the eight stages with their real status and reason, the last successful checkpoint, errors with hints, and a Run button per stage; "Continue production" runs whatever is missing or stale; "Fresh script" archives and restarts.
- **Storyboard**: the shot list with thumbnails from the latest render, timing in bars, visual type, section and Short membership; edit any shot (or the raw JSON), validate, save (the previous version is archived); select shots to redirect with notes or to preview at half resolution.
- **Fact-check**: every spoken and on-screen claim with verdict, correction and sources.
- **Assets & audio**: providers, per-cut audio status (full, partial, silent), loudness, licences, players for the mix and the music; illustration and licence report; Blender availability and 3D clip status with a preview.
- **Quality**: the QA report per candidate, contact sheets, frames per shot, and Claude's review when requested.
- **Review**: pick a candidate, compare it side by side with another (linked players), approve it or reject it with notes. Preview renders can't be approved; approved candidates are never deleted.
- **Logs** and **Jobs**: live logs, progress (including Blender frames), cancel.

## Costs

| Item | Cost |
|---|---|
| Script, fact-check, direction, optional frame review | Your Claude Code subscription via `claude -p` (usage limits apply; no API key) |
| Narration, music, sung chorus, SFX | Free and local (macOS `say`, built-in composer, ffmpeg) |
| Rendering | Free, local (Remotion; optional Blender) |
| ElevenLabs voice | Optional and off by default; paid per character if you enable it |

## Pitfalls that still apply

- **YouTube's "inauthentic content" rules.** Mass-produced, near-identical videos get demonetized. The director varies treatments per topic and the human approval step stays.
- **AI disclosure and "made for kids".** The package metadata leaves both flags unset on purpose: set them deliberately at upload.
- **Voice licensing.** The default narration uses a macOS system voice; check Apple's terms before commercial publication, or plug in a voice you have rights to.
- **Upload API audit.** Videos uploaded through an unverified API project stay private until Google audits it. Upload is not automated yet.

## Repository layout

```
admin/                  Local admin panel (server.mjs + public/)
docs/pipeline.md        Stages, files, flags, recovery
prompts/                script, factcheck, revise, direct
scripts/pipeline.ts     The pipeline CLI; stages in scripts/stages/
scripts/audio/          Composer, SFX and WAV helpers
scripts/providers/      Voice providers (say, elevenlabs, none)
scripts/blender/        Optional Blender scenes and runner
specs/                  Storyboards (<slug>.json) and fact-check sources
src/                    Remotion: schema, timeline, theme, layout, scene systems, components
assets/manifest.json    Licensed external assets (files live in public/)
test/                   node --test: schema, timeline, admin server
```
