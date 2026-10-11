// Repeatable, no-model quality checks and run-to-run efficiency snapshots.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateBenchmarkCase } from "../../src/schema/quality.mjs";
import { evidenceFromResearch } from "../../src/schema/evidence.mjs";
import type { Settings } from "../../src/schema/settings.mjs";
import { DATA, paths, readJson, ROOT, writeJson } from "./files";
import { aggregate, parseLedger } from "../../src/schema/usage.mjs";
import type { UsageRecord } from "./usage";
import { loadEvidence, loadOutlines, loadResearch, loadReviews, researchHash } from "../stages/editorial";
import { ownSpec } from "../stages/text";
import { loadState } from "./state";

type BenchmarkRun = {
  runId: string;
  at: string;
  quality: ReturnType<typeof evaluateBenchmarkCase> | { status: "unavailable"; reason: string; passed: null; failed: null; unavailable: null; checks: [] };
  efficiency: {
    calls: number; repairs: number; failures: number; inputTokens: number | null; outputTokens: number | null;
    estimatedCostUsd: number | null; callDurationMs: number; stageRuns: number; cacheHits: number; stageFailures: number;
  };
  durations: Partial<Record<"main" | "short", number | null>>;
  comparison?: Record<string, unknown>;
};

const suite = () => readJson<{ version: number; cases: any[] }>(join(ROOT, "benchmarks/suite.json"), { version: 1, cases: [] });

export function buildBenchmarkRun(slug: string, runId: string, settings: Settings, usageRows: UsageRecord[], execution: { stageRuns?: number; cacheHits?: number; stageFailures?: number } = {}): BenchmarkRun {
  const caseDef = suite().cases.find((item) => item.slug === slug);
  const research = loadResearch(slug);
  const rHash = researchHash(research);
  const savedEvidence = loadEvidence(slug);
  const evidence = savedEvidence?.researchHash === rHash ? savedEvidence : research ? evidenceFromResearch(research, { researchHash: rHash!, promptVersion: research.promptVersion, topic: research.topic.slug, at: research.at }) : null;
  const specs = Object.fromEntries((caseDef?.formats ?? ["main", "short"]).map((format: "main" | "short") => [format, ownSpec(slug, format)]));
  const outlines = loadOutlines(slug).formats;
  const reviews = loadReviews(slug).formats;
  const sources = readJson<any>(paths.sources(slug), null);
  const assets = readJson<any>(join(paths.work(slug), "assets.json"), null);
  const state = loadState(slug);
  const latest = state.candidates.at(-1);
  const qa = latest ? readJson<any>(join(paths.candidate(slug, latest.id), "qa/report.json"), null) : null;
  const quality = caseDef
    ? evaluateBenchmarkCase(caseDef, { slug, specs, outlines, research, evidence, reviews, sources, settings, assetReport: assets, qa })
    : { status: "unavailable" as const, reason: "this topic has no benchmark case in benchmarks/suite.json", passed: null, failed: null, unavailable: null, checks: [] as [] };
  const totals = aggregate(usageRows);
  const durations = Object.fromEntries(["main", "short"].map((format) => {
    const measured = qa?.media?.[format]?.seconds;
    const audio = readJson<any>(join(paths.work(slug), `audio/manifest.json`), null)?.durations?.[format]?.seconds;
    return [format, Number.isFinite(measured) ? measured : Number.isFinite(audio) ? audio : null];
  })) as BenchmarkRun["durations"];
  return {
    runId, at: new Date().toISOString(), quality,
    efficiency: {
      calls: totals.calls,
      repairs: totals.repairCalls,
      failures: totals.failed + totals.blocked,
      inputTokens: totals.totalInputTokens,
      outputTokens: totals.outputTokens,
      estimatedCostUsd: totals.costUsd,
      callDurationMs: totals.durationMs,
      stageRuns: execution.stageRuns ?? 0,
      cacheHits: execution.cacheHits ?? 0,
      stageFailures: execution.stageFailures ?? 0,
    },
    durations,
  };
}

const delta = (now: number | null | undefined, before: number | null | undefined) => typeof now === "number" && typeof before === "number" ? now - before : null;

function compareRuns(current: BenchmarkRun, previous: BenchmarkRun) {
  const now = current.quality as any, before = previous.quality as any;
  const failedChecks = (now.checks ?? []).filter((item: any) => item.status === "fail").map((item: any) => item.id);
  const previousFailed = new Set((before.checks ?? []).filter((item: any) => item.status === "fail").map((item: any) => item.id));
  const regressions = failedChecks.filter((id: string) => !previousFailed.has(id));
  const improvements = [...previousFailed].filter((id) => !failedChecks.includes(id));
  const qualityChanged = now.status !== before.status || (now.coverage ?? null) !== (before.coverage ?? null) || (now.essentialCoverage ?? null) !== (before.essentialCoverage ?? null);
  return {
    baselineRunId: previous.runId,
    quality: { status: now.status, previousStatus: before.status, newlyFailedChecks: regressions, resolvedChecks: improvements, coverageDelta: delta(now.coverage, before.coverage), essentialCoverageDelta: delta(now.essentialCoverage, before.essentialCoverage), passedChecksDelta: delta(now.passed, before.passed), changed: qualityChanged },
    efficiency: Object.fromEntries(["calls", "repairs", "failures", "inputTokens", "outputTokens", "estimatedCostUsd", "callDurationMs", "stageRuns", "cacheHits", "stageFailures"].map((key) => [key, delta((current.efficiency as any)[key], (previous.efficiency as any)[key])])),
    durations: Object.fromEntries(["main", "short"].map((format) => [format, delta(current.durations[format as "main" | "short"], previous.durations[format as "main" | "short"])])),
    qualityRegression: regressions.length > 0 || (before.status === "pass" && now.status !== "pass") || ((now.coverage ?? 0) < (before.coverage ?? 0)) || ((now.essentialCoverage ?? 0) < (before.essentialCoverage ?? 0)),
  };
}

/** Overwrite by runId so retries/resumes cannot duplicate benchmark snapshots. */
export function recordBenchmark(slug: string, runId: string, settings: Settings, usageRows?: UsageRecord[], execution: { stageRuns?: number; cacheHits?: number; stageFailures?: number } = {}) {
  const file = paths.benchmark(slug);
  const prior = readJson<{ version: number; runs: BenchmarkRun[] }>(file, { version: 1, runs: [] });
  const rows = usageRows ?? (existsSync(join(DATA, "out", slug, "usage.jsonl")) ? parseLedger(readFileSync(join(DATA, "out", slug, "usage.jsonl"), "utf8")).filter((row: any) => row.runId === runId) : []);
  const current = buildBenchmarkRun(slug, runId, settings, rows, execution);
  const previous = [...prior.runs].reverse().find((run) => run.runId !== runId);
  if (previous) current.comparison = compareRuns(current, previous);
  const runs = [...prior.runs.filter((run) => run.runId !== runId), current].slice(-20);
  writeJson(file, { version: 1, slug, suiteVersion: suite().version, runs });
  return current;
}

export function loadBenchmark(slug: string) {
  return readJson<{ version: number; slug: string; suiteVersion: number; runs: BenchmarkRun[] } | null>(paths.benchmark(slug), null);
}
