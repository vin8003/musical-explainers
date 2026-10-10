# Pipeline

Everything for one video lives under a slug, e.g. `how-does-the-internet-work`. The production pipeline is `scripts/pipeline.ts`: eight explicit stages, each with inputs, outputs, a status computed from files on disk, logs, retries and a clear error. Any stage can be re-run on its own; a plain run continues from wherever the video is.

```
topics/backlog.json
   │ 1. script     claude -p         -> specs/<slug>.json (storyboard v2, draft visuals)
   │ 2. factcheck  claude -p + web   -> specs/<slug>.sources.json (revises flagged text, max 2 rounds)
   │ 3. direct     claude -p         -> specs/<slug>.json (visual system, labels, camera, transitions per shot)
   │    factcheck again, only for new on-screen text (diagram labels)
   │ 4. assets     local             -> out/<slug>/assets.json (+ optional Blender clips in public/generated/<slug>/3d/)
   │ 5. audio      say + composer    -> out/<slug>/audio/ (timelines, manifest) + public/generated/<slug>/mix-*.wav
   │ 6. render     Remotion          -> out/<slug>/candidates/<id>/{main,short}.mp4 + props.json
   │ 7. qa         ffmpeg (+ claude) -> out/<slug>/candidates/<id>/qa/ (report, frames, contact sheets)
   │ 8. package    Remotion still    -> out/<slug>/candidates/<id>/package/ (thumbnail, metadata)
   ▼
[approval in the admin panel]        -> out/<slug>/state.json (approved candidate) + topics/backlog.json
```

## Commands

```bash
npm run pipeline -- how-does-the-internet-work            # continue: run every stage that is missing or out of date
npm run pipeline -- how-does-the-internet-work --status   # stage status as JSON
npm run pipeline -- "How do vaccines work?" --fresh       # new script (old storyboard archived), then continue
npm run pipeline -- <slug> --stage audio                  # one stage, even if it is up to date
npm run pipeline -- <slug> --from direct --to render      # a range
npm run pipeline -- <slug> --stage direct --shots a,b --notes "use a comparison"   # redirect selected shots
npm run pipeline -- <slug> --stage render --shots a,b     # half-res previews of just those shots
npm run pipeline -- <slug> --stage render --preview       # half-res candidate (can't be approved)
npm run pipeline -- <slug> --stage qa --visual-review     # QA plus Claude inspecting the contact sheets
npm run generate -- "Topic" [--render] [--skip-factcheck] # old command, now a wrapper around the pipeline
```

Other flags: `--formats main,short`, `--force`, `--allow-missing-assets`, `--fix-rounds N` (automatic QA fix rounds in continue mode, default 1, `0` disables).

## What "continue" does

`scripts/core/status.ts` computes each stage's status from the files, not from what the last job claimed:

| Stage | Up to date when |
|---|---|
| script | `specs/<slug>.json` is a v2 storyboard (v1 specs are migrated to a draft automatically) |
| factcheck | every spoken and on-screen text item has an `ok` verdict in `sources.json` |
| direct | `direction.status` is `directed` |
| assets | `assets.json` was made from the current visuals, asset manifest and Blender setting |
| audio | the audio manifest's input hash matches the storyboard text, timing, music and voice settings |
| render | the newest candidate was made from the current storyboard, audio and renderer code |
| qa | the newest candidate has a QA report that didn't fail |
| package | the newest candidate has a thumbnail and metadata |

Continue mode runs the first stage that isn't up to date, then rescans (a new diagram label makes the fact-check stale again). Each stage runs at most twice per invocation. If QA fails and `--fix-rounds` allows it, the shots QA blames are redirected with the findings as notes, then rendered and checked again; after that it stops and asks a human.

Editing the storyboard (in the admin panel or by hand) only invalidates what depends on the change: new narration makes the fact-check and audio stale; a changed visual makes the render stale; renderer code changes make the render stale too.

## Files and safety

- **Atomic writes.** JSON is written to a temp file and renamed, so a cancel or crash never leaves half a file.
- **Archive before overwrite.** The storyboard and sources are copied to `out/<slug>/archive/` before every rewrite (fresh script, fact-check revision, direction, admin edit).
- **Immutable candidates.** Every render is a new `out/<slug>/candidates/<timestamp>/`. The approved candidate, the newest six (`KEEP_CANDIDATES`) and recently reviewed ones are kept; renders are reproducible from `props.json`.
- **Locks.** `out/<slug>/.pipeline.lock` stops two jobs on one video (CLI and admin included); `out/.render.lock` keeps one Remotion render at a time. Locks held by dead processes are taken over.
- **Cancellation.** SIGTERM marks the running stage `cancelled` in `state.json`, stops child processes (claude, Remotion, Blender) and releases locks. Partial renders are written to `*.partial.mp4` and deleted.
- **Bounded retries.** `claude -p` calls retry once on transient errors and never on a usage-limit message; each call has a timeout (`CLAUDE_TIMEOUT_MS`, default 15 min). Claude's JSON is validated and sent back once with the problems.

## The storyboard (VideoSpec v2)

Defined and validated in `src/schema/storyboard.mjs` (types in `storyboard.d.mts`); the admin server, the pipeline and the renderer all use the same validator.

```jsonc
{
  "schemaVersion": 2, "slug": "...", "title": "...",
  "brief": { "audience": "...", "learningGoal": "...", "hook": "..." },   // editorial: used by QA review
  "world": "night",                                                      // art direction: night | cell | sky | paper
  "direction": { "status": "directed" },                                 // pipeline bookkeeping
  "music": { "bpm": 112, "key": "G", "mode": "major", "mood": "driving", "songSrc": null },
  "shots": [{
    "id": "routers-hop", "section": "verse",                             // section drives the music arrangement
    "purpose": "...",                                                    // editorial
    "narration": "...", "lyric": "...", "headline": "Routers Pass It Along",
    "visual": { "type": "network", "nodes": [...], "links": [...], "packets": [...] },
    "camera": { "move": "pan-right" }, "transition": "push",
    "mascot": { "mood": "pointing", "position": "right" },
    "accents": [{ "beat": 4, "sfx": "pop" }],                            // selective musical accents
    "minBars": 4, "short": true, "assets": [{ "id": "my-file", "required": true }]
  }]
}
```

Every field either changes the output or is listed as editorial (`brief`, `purpose`, `notes`, `direction`). Shot length is not set by hand: it is the narration's measured length (or the sung lyric's beats), rounded up to whole bars, with `minBars` as a floor. The vertical Short uses the shots marked `short`.

Visual systems (`src/shots/`): `title`, `kinetic`, `network`, `packetize`, `anatomy`, `journey`, `flow`, `population`, `comparison`, `timeline`, `steps`, `character`, and `scene3d` (a pre-rendered Blender clip with a required 2D `fallback`). `prompts/direct.md` tells the director what each one is for and the rules (vary treatments, mascot at most 3 shots, selective accents, short labels).

## Audio

`scripts/stages/audio.ts`, all local and free by default:

1. **Narration**: one clip per shot via macOS `say` (`VOICE_NAME`, default Samantha; `VOICE_RATE`). Clips are cached by text and voice. Lengths are measured with ffprobe.
2. **Timeline** (`src/schema/timeline.mjs`): narration lengths -> whole bars per shot at the storyboard's BPM. The renderer, the music, the chant and the SFX all use these numbers.
3. **Music**: `scripts/audio/compose.ts` arranges a deterministic backing track on that timeline: chord progression per section (major or minor), drums, bass, pads, arpeggio, a lead line doubling the chorus melody, a riser into each chorus and an impact on its downbeat. Same storyboard, same samples.
4. **Sung chorus**: each lyric word is spoken by `say`, pitch-shifted (ffmpeg rubberband, formant-preserving) to the hook melody and placed on its beat. It sounds like a robotic chant, not a singer.
5. **SFX**: synthesized whooshes on moving transitions and the storyboard's accents.
6. **Mix**: music ducked under narration, everything normalised to -14 LUFS / -1.5 dBTP (ffmpeg loudnorm), one mix per cut.

The manifest records providers, licences and a status per cut: `full` (music, plus narration if the script has any), `partial`, or `silent`. The render stage refuses to render without current audio (set `ALLOW_SILENT_RENDER=1` for a silent preview), and QA and the Review tab say exactly what is missing.

Optional providers: `AUDIO_VOICE=elevenlabs` with `ELEVENLABS_API_KEY` (and `ELEVENLABS_VOICE_ID`) uses ElevenLabs TTS (paid, not tested in this repo); `AUDIO_VOICE=none` renders music only; `music.songSrc` (a file under `public/`) or `AUDIO_MUSIC=none` replaces or drops the composer; `AUDIO_VOCALS=none` drops the chant.

## Assets

Built-in illustrations (`src/assets/icons.tsx`) are original code-drawn SVG, so they need no licence entry. External files go under `public/` with an entry in `assets/manifest.json` (`id`, `file`, `kind`, `license`, `source`, optional `attribution`) and are referenced as `file:<id>`. The assets stage fails if a required file is missing or has no licence and source (`--allow-missing-assets` overrides; the frame then shows a loud red MISSING placeholder that QA fails on).

## Optional Blender backend

`scripts/blender/` renders procedural 3D clips headless with Eevee (`fiber_packets.py`: light pulses through the glass fibres of a cut-away undersea cable). A shot opts in with `{"type": "scene3d", "scene": "fiber-packets", "fallback": {...}}`. The assets stage renders and caches the clip per cut (`public/generated/<slug>/3d/`), reports progress, and on any failure (or when Blender is missing, or `BLENDER=off`) records a fallback so the 2D visual is used. Settings: `BLENDER_BIN`, `BLENDER_QUALITY=final|draft`.

## QA

`scripts/stages/qa.ts` checks the rendered files:

- container: dimensions, 30 fps, h264, duration against the timeline, an audio stream when audio was produced
- audio: integrated loudness and true peak (ebur128), long silences, partial/silent audio
- frames at 15%, 50% and 90% of every shot: nearly empty frames, frozen shots, near-identical compositions (dHash) between different shots, content touching the frame edge, visible MISSING-asset placeholders
- text fit: headlines that can't fit at a readable size for the cut (same `fitText` the renderer uses)
- contact sheets per cut, and per-shot frames for the admin panel
- optional (`--visual-review`): one `claude -p` call that must Read every contact sheet, describe each one (so it is checked it looked), and return findings per shot

Each finding names the shot, the time, and who should fix it (script, storyboard, assets, audio, scene, renderer).

## Running Claude locally (no API key)

All Claude steps shell out to the Claude Code CLI in headless mode using the logged-in subscription (`scripts/claude.ts`). It removes `ANTHROPIC_API_KEY` from the child's environment so the CLI can't bill the API, and drops nested-session variables. `CLAUDE_BIN` points at a specific binary; `CLAUDE_MODEL` picks a model. Heavy batches count against subscription usage limits, so the admin panel runs one job at a time.

## Recovering from common failures

| Symptom | What to do |
|---|---|
| `Busy: pipeline <slug> ... holds .pipeline.lock` | Another job is running for that video (maybe in a terminal). Wait or cancel it; a lock from a dead process is taken over automatically. |
| Fact-check still flagged after 2 revisions | Edit the flagged text in the Storyboard tab (the Fact-check tab shows corrections and sources) and run the fact-check again: only edited text is re-checked. |
| `Claude subscription usage limit reached` | Nothing retries automatically; run the stage again after the limit resets. |
| `The audio is missing or out of date` on render | Run the audio stage (continue mode does it for you). |
| Required asset missing | Add the file under `public/` and an entry with licence and source in `assets/manifest.json`, or switch the shot to a built-in illustration. |
| Blender clip failed | The shot uses its 2D fallback and the Assets tab shows the error; fix and re-run the assets stage. |
| A stage shows "cancelled" or "interrupted" | Run continue: finished stages are cached, the interrupted one starts again. |
| esbuild "installed for another platform" | `node_modules` was installed under a different CPU architecture. Use the same Node that installed it (e.g. `/opt/homebrew/bin/npm`) or reinstall. |
