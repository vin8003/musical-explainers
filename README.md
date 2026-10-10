# musical-explainers

A YouTube channel of short, musical, flashy explainer videos, produced mostly by Claude with about 10 minutes of human time per video.

The core idea: **Claude writes code that renders the animation** instead of asking an AI video generator for clips. Generators like Veo, Runway and Kling look impressive, but characters drift from shot to shot, diagrams come out wrong, and every clip costs money. With code-driven animation ([Remotion](https://www.remotion.dev/) for most topics, [Manim](https://www.manim.community/) for math and physics), every video is consistent and accurate, renders cost almost nothing, and Claude can fix its own mistakes. That is what makes "minimal human intervention" realistic.

## Repository layout

```
README.md               This plan
docs/pipeline.md        Stage-by-stage detail: inputs, outputs, tools, file formats
topics/backlog.json     Topic queue (target ~50 topics)
specs/                  One VideoSpec JSON per video (script, lyrics, beats, timing)
src/                    Remotion project (React -> MP4)
  Root.tsx              Registers compositions (main video + Short)
  Explainer.tsx         Renders a VideoSpec
  theme.ts              Palette, fonts, easing: chosen once, reused everywhere
  components/           Reusable library: Mascot, BeatFlash, TextPop, ...
scripts/generate.ts     Script-to-video generator (topic -> spec -> render)
```

## Quick start

```bash
npm install
npm run studio                                      # preview in the browser
npm run generate -- "How does the internet work?"   # topic -> specs/<slug>.json (stubbed)
npm run generate -- "How does the internet work?" --render   # ...and render out/<slug>.mp4
```

## The pipeline

```
Topic queue -> Script + lyrics -> Fact-check -> Song -> Voiceover -> Animation code
  -> Render -> Self-review -> [YOU: approve] -> Thumbnail + metadata -> Upload/schedule
```

| # | Stage | What does it | Notes |
|---|-------|--------------|-------|
| 1 | Topic selection | Claude + YouTube search data / Google Trends | Keep a backlog of about 50 topics in `topics/backlog.json` (or a Notion database) |
| 2 | Script | Claude API | Hook in the first 5 seconds, 3–4 "beats", a catchy chorus that holds the key idea, and a recap. Two versions: a 60s Short and a 3–5 min main video |
| 3 | Fact-check | A second Claude pass with web search | Checks every claim and attaches sources. Don't skip this: wrong facts sink an educational channel |
| 4 | Music | ElevenLabs Music API, or Suno/Udio | ElevenLabs has an official API. Suno and Udio mostly don't, and third-party wrappers break their terms. Check the commercial-use license on every tool |
| 5 | Narration | ElevenLabs TTS | Gives word-level timestamps, so the animation can sync to the speech |
| 6 | Animation | Remotion (React -> MP4) | Claude writes scenes from a reusable library: mascot, transitions, text pops, particle bursts, beat-synced effects. Manim suits math and physics |
| 7 | Render | Remotion CLI locally, or Remotion Lambda | A few minutes per video |
| 8 | Self-review | Claude looks at sampled frames | Catches overlapping text, off-screen items and timing problems, then re-renders |
| 9 | Your approval | You | Watch at 2x and tap approve. This is the one step to keep (see pitfalls) |
| 10 | Thumbnail + SEO | Claude | Title, description, tags and chapters. Thumbnail rendered from the same Remotion components. Test 2–3 thumbnails with YouTube's "Test & Compare" |
| 11 | Upload | YouTube Data API v3 (`videos.insert`) | Set `publishAt` to schedule. Set the AI-content disclosure flag and the "made for kids" flag |
| 12 | Run on a schedule | Claude Code scheduled tasks, cron, or GitHub Actions | e.g. 3 videos a week, then a notification asking for approval |

See [docs/pipeline.md](docs/pipeline.md) for inputs, outputs and file formats per stage.

## Making it musical and flashy without feeling cheap

- **A recurring mascot plus a theme song.** Brand recognition is what makes viewers come back.
- **Sync everything to the beat.** Use the generated song's BPM to time cuts, zooms and colour flashes (`BeatFlash` in `src/components`).
- **Teach the concept in the chorus.** For example, "Mitochondria, power it up!" The repeated line is what sticks.
- **Use a consistent visual style.** Pick a palette, font and easing curve once (`src/theme.ts`) and reuse them in every video.

## Pitfalls that will bite if ignored

- **YouTube's "inauthentic content" monetization rules.** Channels that mass-produce near-identical AI videos get demonetized. Avoid this with real variety, a recognizable format and genuine educational value. That is also why the human approval step stays.
- **AI disclosure.** YouTube requires labelling realistic synthetic content. Animated explainers are usually fine, but set the flag correctly on every upload.
- **"Made for kids" (COPPA).** Marking videos as for kids turns off comments and personalized ads, so they earn less. You must label honestly, and the FTC can fine for mislabelling. Many channels aim at "curious people of all ages" so they aren't strictly kids' content. Choose deliberately.
- **Upload API audit.** Videos uploaded through a new, unverified API project are locked to private until Google audits the project. Apply early, or upload by hand for the first few weeks.
- **Music rights.** Use only generators whose license allows commercial YouTube use, or Content ID claims will take the revenue.

## Rough costs

| Item | Cost |
|------|------|
| Claude API (script, fact-check, code, review) | A few dollars or less per video |
| ElevenLabs voice + music | About $22–99/month, depending on volume |
| Rendering | Free locally, or cents on Lambda |
| **Total** | **About $30–100/month for 10–15 videos** |

These are estimates; check each provider's current pricing.

## Rollout

- **Week 1:** Build the Remotion template and mascot, then hand-produce 3 videos with Claude to lock in the style.
- **Week 2:** Automate script -> voice -> music -> render into one command, e.g. `npm run generate -- "black holes" --render`.
- **Week 3:** Add fact-checking, self-review, and scheduled upload. Start posting.
- **Ongoing:** Claude reads YouTube Analytics weekly (retention graphs, click-through rate) and adjusts hooks, length and topics. This feedback loop is what makes the channel grow.

The fastest way to find out whether this works is to make one real video. The first target is "How does the internet work?" (already in the backlog, with an example spec in `specs/`).
