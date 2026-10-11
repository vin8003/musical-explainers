// The production pipeline: explicit stages with cached outputs, staleness
// tracking, bounded retries, a per-video lock and honest status. Research
// comes first: research -> outline -> script -> editorial review ->
// fact-check -> direction -> assets -> audio -> render -> qa -> package, with
// a separate outline, script, review and audio per cut (landscape and Short).
//
//   npm run pipeline -- <slug|"Topic title">               continue: run every stage that is missing or stale
//   npm run pipeline -- <slug> --stage audio                run one stage (even if fresh, with --force)
//   npm run pipeline -- <slug> --from direct --to render    run a range
//   npm run pipeline -- <slug> --stage direct --shots a,b --notes "..."   redirect selected shots
//   npm run pipeline -- <slug> --stage render --shots a,b   quick half-res previews of selected shots
//   npm run pipeline -- <slug> --fresh                      new outline + script (old spec archived; research kept), then continue
//   npm run pipeline -- <slug> --status                     print stage status as JSON
//
// Other flags: --preview (half-res render), --formats main,short, --force,
// --allow-missing-assets, --visual-review (Claude inspects contact sheets),
// --fix-rounds N (automatic QA fix rounds, default 1), --duration-rounds N
// (targeted script revisions when measured audio is outside the configured
// range, default 1).
//
// Duration settings come from config/settings.json (admin: Settings), resolved
// once at start; the admin passes its job snapshot in PIPELINE_SETTINGS.
import { readFileSync } from "node:fs";
import { lock, paths, PipelineError, readJson } from "./core/files";
import { fmt, FORMAT_LABEL, wordsToTarget } from "../src/schema/settings.mjs";
import { runSettings } from "./core/settings";
import { emit, loadState, setStage, Stage, STAGES, updateState } from "./core/state";
import { newRunId, runSummaryLine, setUsageContext, stageSummaryLine } from "./core/usage";
import { computeStatus } from "./core/status";
import { assetsStage } from "./stages/assets";
import { audioStage, DurationError } from "./stages/audio";
import { outlineStage, researchStage, reviewStage, scriptStage } from "./stages/editorial";
import { renderStage } from "./stages/render";
import { directStage, factcheckStage } from "./stages/text";
import type { RunCtx, StageResult, Topic } from "./stages/types";

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const RUNNERS: Record<Stage, (ctx: RunCtx) => Promise<StageResult>> = {
  research: researchStage,
  outline: outlineStage,
  script: scriptStage,
  review: reviewStage,
  factcheck: factcheckStage,
  direct: directStage,
  assets: assetsStage,
  audio: audioStage,
  render: renderStage,
  qa: async (ctx) => (await import("./stages/qa")).qaStage(ctx),
  package: async (ctx) => (await import("./stages/package")).packageStage(ctx),
};

function parseArgs(argv: string[]) {
  const flags: Record<string, string | boolean> = {};
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      const valued = ["stage", "from", "to", "shots", "notes", "formats", "fix-rounds", "duration-rounds"].includes(k);
      flags[k] = v ?? (valued ? argv[++i] ?? "" : true);
    } else pos.push(a);
  }
  return { flags, target: pos.join(" ").trim() };
}

function resolveTopic(target: string): { slug: string; title: string; topic?: Topic } {
  const backlog = readJson<{ topics: Topic[] }>(paths.backlog, { topics: [] });
  const topic = backlog.topics.find((t) => t.slug === target || t.slug === slugify(target) || t.title.toLowerCase() === target.toLowerCase());
  const slug = topic?.slug ?? slugify(target);
  const spec = readJson<{ title?: string } | null>(paths.spec(slug), null);
  return { slug, title: topic?.title ?? spec?.title ?? target, topic };
}

async function runStage(stage: Stage, ctx: RunCtx) {
  const started = new Date().toISOString();
  setUsageContext({ stage });
  console.log(`\n== ${stage} ==`);
  emit({ event: "stage", stage, status: "running" });
  setStage(ctx.slug, stage, { status: "running", startedAt: started, endedAt: undefined, error: null });
  try {
    const r = await RUNNERS[stage](ctx);
    setStage(ctx.slug, stage, { status: "done", endedAt: new Date().toISOString(), summary: r.summary, warnings: r.warnings ?? [], inputHash: r.inputHash, error: null });
    console.log(`  ${r.cached ? "cached" : "done"}: ${r.summary}`);
    console.log(`  usage: ${stageSummaryLine(stage, started)}`);
    for (const w of r.warnings ?? []) console.log(`  warning: ${w}`);
    emit({ event: "stage", stage, status: "done", summary: r.summary, cached: r.cached });
    return r;
  } catch (e) {
    const err = e as PipelineError;
    const cancelled = cancelling;
    setStage(ctx.slug, stage, { status: cancelled ? "cancelled" : "failed", endedAt: new Date().toISOString(), error: cancelled ? { message: "cancelled", kind: "cancelled" } : { message: err.message, kind: err.kind, hint: err.hint } });
    emit({ event: "stage", stage, status: cancelled ? "cancelled" : "failed", error: err.message, kind: err.kind, hint: err.hint, ...(err instanceof DurationError ? { durations: Object.fromEntries(err.failing.map((x) => [x.format, x.report])) } : {}) });
    throw e;
  }
}

let cancelling = false;
let currentStage: Stage | null = null;

async function main() {
  const { flags, target } = parseArgs(process.argv.slice(2));
  if (!target) {
    console.error(readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).join("\n"));
    process.exit(1);
  }
  const { slug, title, topic } = resolveTopic(target);
  // One settings snapshot for the whole run: a settings change mid-run only affects later jobs.
  const snap = runSettings();
  for (const w of snap.warnings) console.log(`[pipeline] settings warning: ${w}`);
  if (flags.status) {
    const s = computeStatus(slug, { settings: snap.settings, title, topic });
    console.log(JSON.stringify({ slug, stages: s.stages, problems: s.problems, lint: s.lint, formats: s.formats }, null, 2));
    return;
  }
  // Usage run: a budget stop or failure keeps the run (resume restores its totals from the ledger);
  // --fresh or a finished run starts a new one with new counters.
  const prior = loadState(slug).usage;
  const usageRun = !prior || prior.completedAt || flags.fresh ? { runId: newRunId(), startedAt: new Date().toISOString() } : prior;
  updateState(slug, (s) => { s.usage = { runId: usageRun.runId, startedAt: usageRun.startedAt, stop: null }; });
  setUsageContext({ slug, runId: usageRun.runId, budgets: snap.settings.budgets });
  const ctx: RunCtx = {
    slug,
    title,
    topic,
    fresh: Boolean(flags.fresh),
    force: Boolean(flags.force),
    shots: typeof flags.shots === "string" && flags.shots ? flags.shots.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
    notes: typeof flags.notes === "string" ? flags.notes : undefined,
    preview: Boolean(flags.preview),
    formats: (typeof flags.formats === "string" ? flags.formats.split(",") : ["main", "short"]).filter((f): f is "main" | "short" => f === "main" || f === "short"),
    allowMissingAssets: Boolean(flags["allow-missing-assets"]),
    visualReview: Boolean(flags["visual-review"]),
    fixRounds: Number(flags["fix-rounds"] ?? process.env.QA_FIX_ROUNDS ?? 1),
    settings: snap.settings,
  };
  const durationRounds = Number(flags["duration-rounds"] ?? process.env.DURATION_FIX_ROUNDS ?? 1);
  // Back-compat with the old generate.ts flags.
  const legacyNoRender = flags.legacy && !flags.render;
  const skip = new Set<Stage>(flags["skip-factcheck"] ? ["factcheck"] : []);

  const release = lock(`${paths.work(slug)}/.pipeline.lock`, `pipeline ${slug}`);
  const onSignal = () => {
    cancelling = true;
    console.log(`\n[pipeline] cancelling${currentStage ? ` during ${currentStage}` : ""}`);
    if (currentStage) setStage(slug, currentStage, { status: "cancelled", endedAt: new Date().toISOString(), error: { message: "cancelled", kind: "cancelled" } });
    release();
    setTimeout(() => process.exit(130), 300);
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  console.log(`Pipeline for "${title}" (${slug})`);
  for (const f of ctx.formats) {
    const d = ctx.settings.formats[f];
    console.log(`  ${FORMAT_LABEL[f]}: target ${fmt(d.targetSeconds)}, allowed ${fmt(d.minSeconds)}-${fmt(d.maxSeconds)} (settings: ${snap.source})`);
  }
  emit({ event: "settings", settings: ctx.settings, source: snap.source });
  updateState(slug, (s) => { s.run = { at: new Date().toISOString(), settings: ctx.settings, source: snap.source, formats: ctx.formats, pid: process.pid }; });
  const single = typeof flags.stage === "string" ? (flags.stage as Stage) : null;
  if (single && !STAGES.includes(single)) throw new PipelineError(`Unknown stage "${single}" (${STAGES.join(", ")})`, "invalid");
  const from = typeof flags.from === "string" ? STAGES.indexOf(flags.from as Stage) : 0;
  const toName = typeof flags.to === "string" ? (flags.to as Stage) : legacyNoRender ? "audio" : "package";
  const to = STAGES.indexOf(toName);
  if (from < 0 || to < 0) throw new PipelineError(`--from/--to must be one of ${STAGES.join(", ")}`, "invalid");

  let finished = false;
  try {
    if (single) {
      currentStage = single;
      await runStage(single, { ...ctx, force: ctx.force || true });
      if (single === "qa") {
        const after = computeStatus(slug, { settings: ctx.settings, formats: ctx.formats, title, topic }).stages.qa;
        if (after.status === "failed") throw new PipelineError(`QA failed: ${after.reason}`, "quality", "Open the Quality tab to see what failed.");
      }
      finished = true;
      return;
    }
    // Continue mode: run what's missing or stale, in order; rescan after each
    // run because later stages can make earlier checks stale (new diagram
    // labels need fact-checking). Each stage runs at most twice.
    const runs: Partial<Record<Stage, number>> = {};
    // Review and fact-check can legitimately run again after each other's revisions.
    const maxRuns = (st: Stage) => (st === "review" || st === "factcheck" ? 3 : 2);
    let fixRoundsLeft = ctx.fixRounds;
    let durationRoundsLeft = durationRounds;
    for (let guard = 0; guard < 40; guard++) {
      const status = computeStatus(slug, { settings: ctx.settings, formats: ctx.formats, title, topic }).stages;
      let next = STAGES.slice(from, to + 1).find((s) => !skip.has(s) && status[s].status !== "fresh");
      // --fresh: re-plan from the outline once research is in place.
      const oi = STAGES.indexOf("outline");
      if (ctx.fresh && !runs.outline && from <= oi && to >= oi && (!next || STAGES.indexOf(next) > oi)) next = "outline";
      if (!next) break;
      if ((runs[next] ?? 0) >= maxRuns(next)) {
        if (next === "qa" && status.qa.status === "failed") throw new PipelineError(`QA still failing: ${status.qa.reason}`, "quality", "Open the Quality tab, fix the flagged shots, and re-render.");
        if (next === "review" && status.review.status === "failed") throw new PipelineError(`Editorial review still failing: ${status.review.reason}`, "editorial");
        if (next === "factcheck" && status.factcheck.status === "failed") throw new PipelineError(`Fact-check still failing: ${status.factcheck.reason}`, "factcheck");
        if (next === "audio" && status.audio.status === "failed") throw new PipelineError(`Audio duration still outside the range: ${status.audio.reason}`, "duration");
        throw new PipelineError(`${next} is still ${status[next].status} after two runs: ${status[next].reason}`, "failed");
      }
      currentStage = next;
      runs[next] = (runs[next] ?? 0) + 1;
      try {
        await runStage(next, { ...ctx, fresh: (next === "outline" || next === "script") && runs[next] === 1 ? ctx.fresh : false });
      } catch (e) {
        // Measured audio outside the configured range: one targeted script
        // revision for the failing cut(s) with the measured numbers, then the
        // affected downstream stages re-run (unaffected cuts stay cached).
        if (!(e instanceof DurationError) || durationRoundsLeft <= 0) throw e;
        durationRoundsLeft--;
        const revise: RunCtx["revise"] = {};
        for (const { format, report } of e.failing) {
          const words = wordsToTarget(report, ctx.settings.narration.wordsPerMinute);
          revise[format] = `The produced audio measured ${fmt(report.seconds)} (narration ${fmt(report.narrationSeconds)}, ${report.spokenWords} spoken words at a measured ${report.measuredWpm ?? "?"} wpm); the ${FORMAT_LABEL[format]} must land near the ${fmt(report.targetSeconds)} target (within ${Math.round(ctx.settings.narration.targetTolerance * 100)}%, never outside ${fmt(report.minSeconds)}-${fmt(report.maxSeconds)}). ${words > 0 ? `Add roughly ${words} spoken words of real explanation from the outline and dossier (deepen the mechanism and the worked example); do not repeat or pad.` : `Cut roughly ${-words} spoken words (or chorus repeats) while keeping the mechanism and the example.`} Keep everything else that works.`;
        }
        console.log(`\n[pipeline] ${e.message}\n[pipeline] targeted script revision for ${Object.keys(revise).join(", ")} (duration round ${durationRounds - durationRoundsLeft}/${durationRounds})`);
        currentStage = "script";
        await runStage("script", { ...ctx, formats: Object.keys(revise) as RunCtx["formats"], revise, force: true });
        continue;
      }
      if (next === "qa") {
        const after = computeStatus(slug, { settings: ctx.settings, formats: ctx.formats, title, topic }).stages.qa;
        if (after.status === "failed") {
          const fixes = (await import("./stages/qa")).fixPlan(slug);
          if (fixRoundsLeft > 0 && fixes.shots.length) {
            fixRoundsLeft--;
            console.log(`\n[pipeline] QA flagged ${fixes.shots.length} shot(s); automatic fix round (${ctx.fixRounds - fixRoundsLeft}/${ctx.fixRounds})`);
            currentStage = "direct";
            await runStage("direct", { ...ctx, shots: fixes.shots, notes: fixes.notes, force: true });
            runs.render = 0;
            runs.qa = 0;
            continue;
          }
          throw new PipelineError(`QA failed: ${after.reason}`, "quality", "Open the Quality tab to see what failed; fix the storyboard or the scene and re-render.");
        }
      }
    }
    console.log(`\nAll requested stages are up to date.`);
    finished = true;
  } finally {
    console.log(`\n[usage] this run: ${runSummaryLine()}`);
    if (finished) updateState(slug, (s) => { if (s.usage) s.usage.completedAt = new Date().toISOString(); });
    currentStage = null;
    release();
  }
}

main().catch((err) => {
  const e = err as PipelineError;
  console.error(`\n[pipeline] ${e.kind ?? "error"}: ${e.message}`);
  if (e.hint) console.error(`[pipeline] hint: ${e.hint}`);
  if (!(err instanceof PipelineError)) console.error((err as Error).stack);
  process.exit(1);
});
