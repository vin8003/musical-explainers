# Pipeline

Everything for one video lives under a slug, e.g. `how-does-the-internet-work`. The production pipeline is `scripts/pipeline.ts`: eleven explicit stages, each with inputs, outputs, a status computed from files on disk, logs, retries and a clear error. Any stage can be re-run on its own; a plain run continues from wherever the video is.

```
topics/backlog.json                config/settings.json (durations, admin: Settings)
   │ 1. research   claude -p + web   -> specs/<slug>.research.json   topic qualification, angle, sourced dossier, thesis
   │ 2. outline    claude -p         -> specs/<slug>.outline.json    per format: beats, claims each beat rests on, planned lengths
   │ 3. script     claude -p         -> specs/<slug>.json (landscape) + specs/<slug>.short.json (Short): independent scripts
   │ 4. review     claude -p         -> specs/<slug>.review.json     per format: rubric scores, findings, pass/fail (1 bounded revision)
   │ 5. factcheck  claude -p + web   -> specs/<slug>.sources.json    claim-level verdicts with sources (targeted revision, max 2 rounds)
   │ 6. direct     claude -p         -> both storyboards (sees the outline and the research claims)
   │ 7. assets     local             -> out/<slug>/assets.json (+ optional Blender clips)
   │ 8. audio      say + composer    -> out/<slug>/audio/ + public/generated/<slug>/mix-*.wav; measured lengths vs. the duration range
   │ 9. render     Remotion          -> out/<slug>/candidates/<id>/{main,short}.mp4 + props-main.json, props-short.json
   │10. qa          ffmpeg (+ claude) -> out/<slug>/candidates/<id>/qa/ (includes the final length vs. the range)
   │11. package    Remotion still    -> out/<slug>/candidates/<id>/package/ (thumbnail, metadata, sources)
   ▼
[approval in the admin panel]        -> out/<slug>/state.json (approved candidate) + topics/backlog.json
```

## Research-first editorial flow

Research informs writing; the script is never written first and researched afterwards.

1. **Research** (`prompts/research.md`). Qualifies the topic (curiosity, depth, evidence, misconceptions, demonstrations, musical potential, and how many non-padded minutes the angle supports), compares angles when the topic is broad, and builds the dossier: mechanism, thesis/mental model, prerequisites, atomic claims with sources (URL, title, passage, what it supports, kind, and whether the page was actually opened), misconceptions, examples/analogies, uncertainties and exclusions. A claim is `supported` only with a source that was opened; otherwise it is `qualified`, `insufficient` or `excluded`. A rejected topic, a thesis resting on an unsupported claim, or fewer than five usable claims stops the pipeline with an *editorial* error.
2. **Outline** (`prompts/outline.md`), once per format, from the dossier and that format's duration: opening question, how understanding changes, beats with roles, claim ids and planned seconds, the key example, the complication, conclusion, and what is long-form only. If the angle cannot fill the configured minimum without padding the stage fails instead of inventing filler.
3. **Script** (`prompts/script.md`), once per format. The landscape and the Short are written independently from the same dossier; the Short teaches one insight on its own. Output is checked for schema, per-shot word limits, claim ids that exist and are usable, and the estimated runtime against the configured range (one repair round with concrete word counts).
4. **Editorial review** (`prompts/review.md`), once per format, separate from the fact-check. A rubric scores ten criteria 0–5 (accuracy, clarity, progression, specificity, examples, engagement, memorability, format fit, music, redundancy). The pipeline decides pass/fail: every criterion ≥ 3, accuracy and clarity ≥ 4, progression ≥ 3, average ≥ 3.8, and no blocking problem. A failing script is rewritten once with the findings (`REVIEW_MAX_REVISIONS`, default 1), then fails. Reviews are kept in `specs/<slug>.review.json` with their history.
5. **Fact-check** verifies every spoken and on-screen item claim by claim with sources it opened; flagged text gets a targeted revision (only the changed shots come back, merged and validated). Verdicts are reused only while the research is unchanged.
6. **Direction** sees the approved outline and the research claims each shot states. It does not edit narration, lyrics or ids.

## Formats and durations

Settings live in `config/settings.json` (admin panel: **Settings**, per format target / minimum / maximum in minutes and seconds, reset to defaults, plus the narration rate used for estimates and the target tolerance). Defaults: landscape 7:00 (5:00–10:00), Short 0:45 (0:30–1:00), 156 words per minute, ±15 %. They are defaults, not limits. Saves are validated on the client and the server (positive, finite, min ≤ target ≤ max); invalid input is rejected with the reason and never clamped. A missing, partial or malformed file falls back to the defaults and says so.

**Models and effort.** Every Claude call is a named step (`research`, `outline`, `script`, `scriptFix`, `review`, `factcheck`, `revise`, `direct`, `visualReview`) with its own model and reasoning effort, set in **Settings > Models and effort** (`models` in `config/settings.json`) and snapshotted per job. Opus is refused everywhere; choose `sonnet` or `haiku`. Precedence per call: `CLAUDE_MODEL_<STEP>` / `CLAUDE_EFFORT_<STEP>` (e.g. `CLAUDE_MODEL_DIRECT=haiku`) > `CLAUDE_MODEL` / `CLAUDE_EFFORT` > the saved setting > the default. Defaults put effort where people judge the output (research, script, review: high; outline, fact check, visual review: medium) and save where code validates and retries (shot direction, fact revision: low; length fix: medium). Each call logs `[step: model, effort]`. Model choice does not invalidate cached stages.

A job resolves the settings once when it starts and records them in `out/<slug>/state.json` (`run`); the admin passes the snapshot in `PIPELINE_SETTINGS`, so changing settings mid-run only affects later jobs. The snapshot flows through: outline and script prompts and validation, the runtime estimate (`estimateRuntime` in `src/schema/timeline.mjs`: narration at the configured rate plus lead/tail, whole bars, sung chorus words and `minBars`), the editorial review, the audio stage (ffprobe of the final mix against the range; `measuredWpm` is recorded for calibrating the rate), render candidates (`durations`), and QA (ffprobe of the rendered file against the range). **Target semantics:** min/max are absolute bounds and the target tolerance (Settings) is the acceptance window around the target. A cut whose estimate, measured audio or rendered file is *short*, *long* or *off-target* (outside the window) fails: the script check retries once, the audio gate triggers the targeted revision below, and QA fails the candidate (so it can never be packaged). Corrections are sized from the measured speaking rate: `words = (target - measured seconds) x measuredWpm / 60`, because music, chorus, transitions and tails stay fixed and the whole difference must come from narration. Each candidate records the *probed MP4* length (`durations.<cut>.seconds`) next to the timeline and soundtrack lengths, and QA fails if the file and soundtrack disagree. Narration is never sped up, trimmed or padded to fit: when measured audio is outside the window the pipeline does one targeted script revision for that cut (`--duration-rounds`, default 1) and re-runs only what that changes, then fails with a *duration* error that shows measured vs. allowed. `ALLOW_DURATION_MISMATCH=1` overrides, for old short videos.

Cache keys: research depends on the topic and the research prompt only; an outline on the research and that format's duration key; a script on its outline, the duration key and the script prompt; a review on the script text and outline; audio and render on each cut's own storyboard and duration key. Changing the Short's duration therefore leaves research and the landscape untouched.

Videos made before the split keep their single storyboard (`specs/<slug>.json`), which serves both cuts (the Short uses shots marked `short`); they show as "stale" for script/outline/review until re-planned with a fresh script. Nothing is deleted: storyboards, sources, reviews and outlines are archived before every rewrite.

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

Other flags: `--formats main,short`, `--force`, `--allow-missing-assets`, `--fix-rounds N` (automatic QA fix rounds in continue mode, default 1, `0` disables), `--duration-rounds N` (script revisions after a duration failure, default 1). Env: `CLAUDE_MODEL`, `CLAUDE_EFFORT` (e.g. `low`) for the model calls; `DATA_ROOT` points specs/config/out at another directory (tests).

## What "continue" does

`scripts/core/status.ts` computes each stage's status from the files, not from what the last job claimed:

| Stage | Up to date when |
|---|---|
| research | `specs/<slug>.research.json` exists for this topic and prompt version and has no blocking problem |
| outline | each format's outline was made from the current research and duration settings |
| script | each format has its own script made from its current outline, duration settings and prompt (older single storyboards show as stale; v1 specs are migrated to a draft) |
| review | each format's script passed the editorial review for its current text |
| factcheck | every spoken and on-screen text item of both scripts has an `ok` verdict for the current research |
| direct | `direction.status` is `directed` |
| assets | `assets.json` was made from the current visuals, asset manifest and Blender setting |
| audio | the audio manifest matches both scripts, music, voice and duration settings, and the measured lengths are inside the range (otherwise "failed") |
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

All Claude steps shell out to the Claude Code CLI in headless mode using the logged-in subscription (`scripts/claude.ts`). It removes `ANTHROPIC_API_KEY` from the child's environment so the CLI can't bill the API, and drops nested-session variables. `CLAUDE_BIN` points at a specific binary; Calls pin `--model sonnet` by default; `CLAUDE_MODEL` overrides it. Heavy batches count against subscription usage limits, so the admin panel runs one job at a time.

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

## Usage, repair and budgets

Every Claude call is recorded in `out/<slug>/usage.jsonl`, invalid replies are repaired field-by-field where safe, and optional budgets stop the pipeline before a call is launched. See [usage-budgets.md](usage-budgets.md).
