// The production pipeline: explicit stages with cached outputs, staleness
// tracking, bounded retries, a per-video lock and honest status.
//
//   npm run pipeline -- <slug|"Topic title">               continue: run every stage that is missing or stale
//   npm run pipeline -- <slug> --stage audio                run one stage (even if fresh, with --force)
//   npm run pipeline -- <slug> --from direct --to render    run a range
//   npm run pipeline -- <slug> --stage direct --shots a,b --notes "..."   redirect selected shots
//   npm run pipeline -- <slug> --stage render --shots a,b   quick half-res previews of selected shots
//   npm run pipeline -- <slug> --fresh                      new script (old spec archived), then continue
//   npm run pipeline -- <slug> --status                     print stage status as JSON
//
// Other flags: --preview (half-res render), --formats main,short, --force,
// --allow-missing-assets, --visual-review (Claude inspects contact sheets),
// --fix-rounds N (automatic QA fix rounds, default 1).
import { readFileSync } from "node:fs";
import { lock, paths, PipelineError, readJson } from "./core/files";
import { emit, setStage, Stage, STAGES } from "./core/state";
import { computeStatus } from "./core/status";
import { assetsStage } from "./stages/assets";
import { audioStage } from "./stages/audio";
import { renderStage } from "./stages/render";
import { directStage, factcheckStage, scriptStage } from "./stages/text";
import type { RunCtx, StageResult, Topic } from "./stages/types";

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const RUNNERS: Record<Stage, (ctx: RunCtx) => Promise<StageResult>> = {
  script: scriptStage,
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
      const valued = ["stage", "from", "to", "shots", "notes", "formats", "fix-rounds"].includes(k);
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
  console.log(`\n== ${stage} ==`);
  emit({ event: "stage", stage, status: "running" });
  setStage(ctx.slug, stage, { status: "running", startedAt: started, endedAt: undefined, error: null });
  try {
    const r = await RUNNERS[stage](ctx);
    setStage(ctx.slug, stage, { status: "done", endedAt: new Date().toISOString(), summary: r.summary, warnings: r.warnings ?? [], inputHash: r.inputHash, error: null });
    console.log(`  ${r.cached ? "cached" : "done"}: ${r.summary}`);
    for (const w of r.warnings ?? []) console.log(`  warning: ${w}`);
    emit({ event: "stage", stage, status: "done", summary: r.summary, cached: r.cached });
    return r;
  } catch (e) {
    const err = e as PipelineError;
    const cancelled = cancelling;
    setStage(ctx.slug, stage, { status: cancelled ? "cancelled" : "failed", endedAt: new Date().toISOString(), error: cancelled ? { message: "cancelled", kind: "cancelled" } : { message: err.message, kind: err.kind, hint: err.hint } });
    emit({ event: "stage", stage, status: cancelled ? "cancelled" : "failed", error: err.message, kind: err.kind, hint: err.hint });
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
  if (flags.status) {
    const s = computeStatus(slug);
    console.log(JSON.stringify({ slug, stages: s.stages, problems: s.problems, lint: s.lint }, null, 2));
    return;
  }
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
  };
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
  const single = typeof flags.stage === "string" ? (flags.stage as Stage) : null;
  if (single && !STAGES.includes(single)) throw new PipelineError(`Unknown stage "${single}" (${STAGES.join(", ")})`, "invalid");
  const from = typeof flags.from === "string" ? STAGES.indexOf(flags.from as Stage) : 0;
  const toName = typeof flags.to === "string" ? (flags.to as Stage) : legacyNoRender ? "audio" : "package";
  const to = STAGES.indexOf(toName);
  if (from < 0 || to < 0) throw new PipelineError(`--from/--to must be one of ${STAGES.join(", ")}`, "invalid");

  try {
    if (single) {
      currentStage = single;
      await runStage(single, { ...ctx, force: ctx.force || true });
      return;
    }
    // Continue mode: run what's missing or stale, in order; rescan after each
    // run because later stages can make earlier checks stale (new diagram
    // labels need fact-checking). Each stage runs at most twice.
    const runs: Partial<Record<Stage, number>> = {};
    let fixRoundsLeft = ctx.fixRounds;
    for (let guard = 0; guard < 30; guard++) {
      const status = computeStatus(slug).stages;
      const next = STAGES.slice(from, to + 1).find((s, i) => !skip.has(s) && (status[s].status !== "fresh" || (i === 0 && s === "script" && ctx.fresh && !runs.script)));
      if (!next) break;
      if ((runs[next] ?? 0) >= 2) {
        if (next === "qa" && status.qa.status === "failed") throw new PipelineError(`QA still failing: ${status.qa.reason}`, "quality", "Open the Quality tab, fix the flagged shots, and re-render.");
        throw new PipelineError(`${next} is still ${status[next].status} after two runs: ${status[next].reason}`, "failed");
      }
      currentStage = next;
      runs[next] = (runs[next] ?? 0) + 1;
      await runStage(next, { ...ctx, fresh: next === "script" ? ctx.fresh : false });
      if (next === "qa") {
        const after = computeStatus(slug).stages.qa;
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
  } finally {
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
