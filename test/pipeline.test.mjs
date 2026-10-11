// End-to-end pipeline behaviour with a stand-in `claude` (test/fixtures/fake-claude.mjs):
// stage order, per-format prompts and durations, evidence gates, the editorial
// gate, bounded revision, cache invalidation, settings snapshots and resume.
// No network, no model, no rendering.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../src/schema/settings.mjs";

const ROOT = process.cwd();
const FAKE = join(ROOT, "test/fixtures/fake-claude.mjs");
const TSX = join(ROOT, "node_modules/tsx/dist/cli.mjs");
const SLUG = "demo-topic";

function sandbox(settings) {
  const data = mkdtempSync(join(tmpdir(), "me-pipe-"));
  mkdirSync(join(data, "topics"), { recursive: true });
  writeFileSync(join(data, "topics/backlog.json"), JSON.stringify({ version: 1, topics: [{ slug: SLUG, title: "Demo topic", category: "x", angle: "a hook", chorusIdea: "A to B to C", status: "queued", priority: 1 }] }));
  if (settings) { mkdirSync(join(data, "config"), { recursive: true }); writeFileSync(join(data, "config/settings.json"), JSON.stringify(settings)); }
  const log = join(data, "calls.jsonl");
  const read = (f) => JSON.parse(readFileSync(join(data, f), "utf8"));
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const run = (args, env = {}) => {
    const r = spawnSync(process.execPath, [TSX, "scripts/pipeline.ts", SLUG, ...args], { cwd: ROOT, encoding: "utf8", env: { ...process.env, DATA_ROOT: data, CLAUDE_BIN: FAKE, FAKE_LOG: log, AUDIO_VOICE: "none", ...env }, timeout: 180000 });
    return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
  };
  const status = (env = {}) => {
    const r = spawnSync(process.execPath, [TSX, "scripts/pipeline.ts", SLUG, "--status"], { cwd: ROOT, encoding: "utf8", env: { ...process.env, DATA_ROOT: data, ...env } });
    return JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
  };
  return { data, run, calls, read, status, log };
}
const kinds = (calls) => calls.map((c) => c.kind + (c.format ? `:${c.format}` : ""));
const through = ["--to", "factcheck"];

test("research and outline exist before any script call; each format has its own target and prompt", () => {
  const sb = sandbox();
  const r = sb.run(through);
  assert.equal(r.code, 0, r.out);
  const order = kinds(sb.calls());
  assert.equal(order[0], "research");
  const firstScript = order.findIndex((k) => k.startsWith("script"));
  assert.ok(order.indexOf("outline:main") < firstScript && order.indexOf("outline:short") < firstScript);
  const c = sb.calls();
  assert.equal(c.find((x) => x.kind === "outline" && x.format === "main").target, 420);
  assert.equal(c.find((x) => x.kind === "outline" && x.format === "short").target, 45);
  assert.equal(c.find((x) => x.kind === "script" && x.format === "main").target, 420);
  assert.equal(c.find((x) => x.kind === "script" && x.format === "short").target, 45);
  // Independent scripts, reviews and artifacts.
  const main = sb.read(`specs/${SLUG}.json`), short = sb.read(`specs/${SLUG}.short.json`);
  assert.equal(main.format, "main");
  assert.equal(short.format, "short");
  assert.ok(main.shots.length > short.shots.length);
  assert.ok(!main.shots.some((s) => short.shots.some((t) => t.id === s.id || (s.narration && s.narration === t.narration))));
  const research = sb.read(`specs/${SLUG}.research.json`), evidence = sb.read(`specs/${SLUG}.evidence.json`);
  assert.ok(evidence.claims.some((c) => c.id === research.thesis.claimIds[0]));
  assert.ok(evidence.sources.every((s) => s.id.startsWith("src-") && s.passage && s.provenance.stage === "research"));
  for (const [spec, format] of [[main, "main"], [short, "short"]]) {
    const beatIds = new Set(sb.read(`specs/${SLUG}.outline.json`).formats[format].beats.map((b) => b.id));
    assert.ok(spec.shots.every((shot) => beatIds.has(shot.beatId)), `${format} segments keep stable outline beat ids`);
  }
  const scriptCalls = sb.calls().filter((x) => x.kind === "script");
  assert.ok(scriptCalls.every((call) => call.evidenceIds.length > 0 && !call.evidenceIds.includes("weak")), "scripts receive only the referenced usable evidence subset");
  const reviews = sb.read(`specs/${SLUG}.review.json`).formats;
  assert.ok(reviews.main.verdict.pass && reviews.short.verdict.pass);
  assert.ok(order.includes("review:main") && order.includes("review:short"));
  assert.ok(existsSync(join(sb.data, `specs/${SLUG}.research.json`)) && existsSync(join(sb.data, `specs/${SLUG}.outline.json`)));
});

test("script estimates land inside the configured range for both formats", () => {
  const sb = sandbox();
  assert.equal(sb.run(through).code, 0);
  for (const [file, f] of [[`${SLUG}.json`, "main"], [`${SLUG}.short.json`, "short"]]) {
    const e = sb.read(`specs/${file}`).editorial.estimate;
    const d = DEFAULT_SETTINGS.formats[f];
    assert.ok(e.seconds >= d.minSeconds && e.seconds <= d.maxSeconds, `${f}: ${e.seconds}s`);
    assert.equal(e.wordsPerMinute, 156);
  }
});

test("configured durations drive the prompts and the script length", () => {
  const s = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  s.formats.main = { targetSeconds: 540, minSeconds: 420, maxSeconds: 660 };
  s.formats.short = { targetSeconds: 30, minSeconds: 20, maxSeconds: 40 };
  const sb = sandbox(s);
  assert.equal(sb.run(through).code, 0);
  const c = sb.calls();
  assert.equal(c.find((x) => x.kind === "script" && x.format === "main").target, 540);
  assert.equal(c.find((x) => x.kind === "script" && x.format === "short").target, 30);
  const inRange = (file, d) => { const e = sb.read(`specs/${file}`).editorial.estimate; return e.seconds >= d.minSeconds && e.seconds <= d.maxSeconds; };
  assert.ok(inRange(`${SLUG}.json`, s.formats.main), "landscape estimate follows its configured range");
  assert.ok(inRange(`${SLUG}.short.json`, s.formats.short), "Short estimate follows its configured range");
  assert.ok(sb.read(`specs/${SLUG}.json`).editorial.estimate.seconds > 420, "longer than the default target");
});

test("a second run is fully cached; a Short-only duration change replans only the Short", () => {
  const sb = sandbox();
  assert.equal(sb.run(through).code, 0);
  const n = sb.calls().length;
  assert.equal(sb.run(through).code, 0);
  assert.equal(sb.calls().length, n, "an unchanged run makes no model calls");
  const s = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  s.formats.short = { targetSeconds: 40, minSeconds: 30, maxSeconds: 60 };
  mkdirSync(join(sb.data, "config"), { recursive: true });
  writeFileSync(join(sb.data, "config/settings.json"), JSON.stringify(s));
  const st = sb.status();
  assert.equal(st.stages.research.status, "fresh");
  assert.match(st.stages.outline.reason, /short: duration settings changed/);
  assert.match(st.stages.outline.reason, /main: 11?|main: \d+ beats|main: 6 beats/);
  assert.equal(sb.run(through).code, 0);
  const after = kinds(sb.calls().slice(n));
  assert.ok(after.includes("outline:short") && after.includes("script:short"));
  assert.ok(!after.includes("research") && !after.includes("outline:main") && !after.includes("script:main"), after.join());
});

test("benchmark compares the new run with the prior baseline and keeps unavailable usage metrics null", () => {
  const sb = sandbox();
  assert.equal(sb.run(through).code, 0);
  const baseline = sb.read(`out/${SLUG}/benchmark.json`).runs[0];
  assert.equal(sb.run(through).code, 0);
  const runs = sb.read(`out/${SLUG}/benchmark.json`).runs;
  assert.equal(runs.length, 2);
  const current = runs[1];
  assert.equal(current.comparison.baselineRunId, baseline.runId);
  assert.equal(current.comparison.qualityRegression, false);
  assert.equal(current.comparison.efficiency.calls, -baseline.efficiency.calls);
  assert.equal(current.comparison.efficiency.inputTokens, null, "a cached no-call run has no fabricated token total");
  assert.equal(current.comparison.efficiency.estimatedCostUsd, null);
  assert.equal(current.comparison.durations.main, null);
  for (const key of ["calls", "repairs", "failures", "inputTokens", "outputTokens", "estimatedCostUsd", "callDurationMs", "stageRuns", "cacheHits", "stageFailures"]) assert.ok(Object.hasOwn(current.comparison.efficiency, key), `comparison includes ${key}`);
  assert.ok(Object.hasOwn(current.comparison.quality, "coverageDelta"));
});

test("changing reviewer settings invalidates reviews only", () => {
  const sb = sandbox();
  assert.equal(sb.run(["--to", "review"]).code, 0);
  const before = sb.calls().length;
  const settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  settings.providers.claude.models.review.model = "haiku";
  mkdirSync(join(sb.data, "config"), { recursive: true });
  writeFileSync(join(sb.data, "config/settings.json"), JSON.stringify(settings));
  assert.equal(sb.status().stages.review.status, "stale");
  const result = sb.run(["--to", "review"]);
  assert.equal(result.code, 0, result.out);
  const changed = sb.calls().slice(before);
  assert.deepEqual(changed.map((call) => call.kind), ["review", "review"]);
  assert.equal(sb.status().stages.script.status, "fresh");
  assert.equal(sb.status().stages.outline.status, "fresh");
  const specPath = join(sb.data, `specs/${SLUG}.json`);
  const spec = JSON.parse(readFileSync(specPath, "utf8"));
  spec.shots[0].purpose = "a revised teaching purpose";
  writeFileSync(specPath, JSON.stringify(spec));
  assert.equal(sb.status().stages.review.status, "stale", "review cache tracks fields shown to the reviewer, not just spoken words");
});

test("a research change invalidates outlines, scripts, reviews and fact-checks", () => {
  const sb = sandbox();
  assert.equal(sb.run(through).code, 0);
  const n = sb.calls().length;
  assert.equal(sb.run(["--stage", "research"], { FAKE_MODE: "research-v2" }).code, 0);
  const st = sb.status();
  assert.equal(st.stages.outline.status, "stale");
  assert.equal(sb.run(through, { FAKE_MODE: "research-v2" }).code, 0);
  const after = kinds(sb.calls().slice(n));
  for (const k of ["outline:main", "outline:short", "script:main", "script:short", "review:main", "review:short", "factcheck"]) assert.ok(after.includes(k), `${k} should re-run: ${after.join()}`);
});

test("an unsupported central thesis blocks the pipeline before any script is written", () => {
  const sb = sandbox();
  const r = sb.run(through, { FAKE_MODE: "unsupported-thesis" });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /central thesis rests on claim/);
  assert.match(r.out, /editorial/);
  assert.ok(!kinds(sb.calls()).some((k) => k.startsWith("script")));
});

test("the editorial review fails a valid script even with a high average, after one bounded revision", () => {
  const sb = sandbox();
  const r = sb.run(through, { FAKE_MODE: "weak-review-always" });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /failed the editorial review after 1 revision/);
  assert.match(r.out, /clarity scored 3/);
  const c = kinds(sb.calls());
  assert.equal(c.filter((k) => k === "review:main").length, 2, "one review, one revision, one re-review");
  assert.equal(c.filter((k) => k === "script:main").length, 1, "a local review finding does not regenerate the whole script");
  assert.ok(sb.calls().find((x) => x.kind === "scriptRepair"));
  assert.ok(!c.includes("factcheck"), "no fact-check on a script that failed review");
  // The failing review is preserved for a human.
  const rv = sb.read(`specs/${SLUG}.review.json`).formats.main;
  assert.equal(rv.verdict.pass, false);
  assert.ok(rv.history.length >= 2 && rv.findings.length);
  // The revised script is still schema-valid.
  const spec = sb.read(`specs/${SLUG}.json`);
  assert.equal(spec.schemaVersion, 2);
});

test("a script that misses its length twice is kept and flagged, not discarded; the review then judges it", () => {
  const sb = sandbox();
  const r = sb.run(["--to", "review"], { FAKE_MODE: "overlong-short" });
  const short = sb.read(`specs/${SLUG}.short.json`);
  assert.ok(["short", "long"].includes(short.editorial.estimate.verdict), short.editorial.estimate.verdict);
  assert.equal(sb.calls().filter((c) => c.kind === "script" && c.format === "short").length >= 2, true);
  assert.match(r.out, /keeping the first Short \(9:16\) script/);
  assert.equal(r.code, 0, r.out);
});

test("a weak first review recovers through one revision and the pipeline continues", () => {
  const sb = sandbox();
  const r = sb.run(through, { FAKE_MODE: "weak-review-once" });
  assert.equal(r.code, 0, r.out);
  const rv = sb.read(`specs/${SLUG}.review.json`).formats.main;
  assert.equal(rv.verdict.pass, true);
  assert.equal(rv.history.length, 2);
  assert.equal(rv.history[0].revised, true);
  const before = sb.read(`specs/${SLUG}.json`);
  assert.ok(before.shots.every((shot) => shot.beatId));
  const repairs = sb.calls().filter((call) => call.kind === "scriptRepair");
  assert.ok(repairs.length && repairs.every((repair) => repair.targets.length === 1), "each local repair names one segment field");
  const archiveDir = join(sb.data, `out/${SLUG}/archive`);
  const archiveNames = readdirSync(archiveDir);
  const changed = [];
  for (const format of ["main", "short"]) {
    const archivedName = archiveNames.find((name) => name.includes(`before-review-repair-${format}`));
    if (!archivedName) continue;
    const beforeShots = sb.read(`out/${SLUG}/archive/${archivedName}`).shots;
    const afterShots = sb.read(`specs/${SLUG}${format === "short" ? ".short" : ""}.json`).shots;
    const priorById = new Map(beforeShots.map((shot) => [shot.id, shot]));
    for (const shot of afterShots) {
      const beforeShot = priorById.get(shot.id);
      if (JSON.stringify(shot) !== JSON.stringify(beforeShot)) changed.push({ format, id: shot.id, beforeShot, afterShot: shot });
    }
  }
  assert.equal(changed.length, 1, "a local repair changes only one affected segment");
  const { format, id, beforeShot, afterShot } = changed[0];
  const repair = repairs.find((item) => item.format === format && item.targets.includes(`${id}.narration`));
  assert.ok(repair, `the changed narration is the requested target (${format} ${id})`);
  assert.deepEqual({ ...afterShot, narration: beforeShot.narration }, beforeShot, "fields outside the targeted narration stay unchanged");
});

test("an interrupted run resumes: finished stages stay cached", () => {
  const sb = sandbox();
  const r1 = sb.run(through, { FAKE_MODE: "fail-script-short" });
  assert.notEqual(r1.code, 0);
  const state1 = sb.read(`out/${SLUG}/state.json`);
  const firstBenchmark = sb.read(`out/${SLUG}/benchmark.json`);
  assert.equal(firstBenchmark.runs.length, 1);
  assert.equal(firstBenchmark.runs[0].runId, state1.usage.runId);
  const n = kinds(sb.calls());
  assert.ok(n.includes("script:main") && n.includes("outline:short"));
  const before = sb.calls().length;
  const r2 = sb.run(through);
  assert.equal(r2.code, 0, r2.out);
  const state2 = sb.read(`out/${SLUG}/state.json`);
  const resumedBenchmark = sb.read(`out/${SLUG}/benchmark.json`);
  assert.equal(state2.usage.runId, state1.usage.runId);
  assert.equal(resumedBenchmark.runs.length, 1, "resume overwrites the same benchmark run instead of duplicating it");
  assert.ok(resumedBenchmark.runs[0].efficiency.stageRuns > firstBenchmark.runs[0].efficiency.stageRuns, "stage execution metrics accumulate across a resume");
  const after = kinds(sb.calls().slice(before));
  assert.ok(!after.includes("research") && !after.includes("outline:main") && !after.includes("outline:short") && !after.includes("script:main"), after.join());
  assert.ok(after.includes("script:short"));
});

test("the job's settings snapshot is not changed by edits made mid-run", () => {
  const sb = sandbox();
  const mutated = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  mutated.formats.main = { targetSeconds: 600, minSeconds: 500, maxSeconds: 700 };
  const file = join(sb.data, "config/settings.json");
  mkdirSync(join(sb.data, "config"), { recursive: true });
  writeFileSync(file, JSON.stringify(DEFAULT_SETTINGS));
  const r = sb.run(through, { FAKE_MUTATE_SETTINGS: file, FAKE_MUTATE_JSON: JSON.stringify(mutated) });
  assert.equal(r.code, 0, r.out);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).formats.main.targetSeconds, 600, "the file really changed mid-run");
  assert.ok(sb.calls().filter((c) => ["outline", "script"].includes(c.kind) && c.format === "main").every((c) => c.target === 420));
  const state = sb.read(`out/${SLUG}/state.json`);
  assert.equal(state.run.settings.formats.main.targetSeconds, 420);
  // The next job sees the new settings, and the old artifacts are stale under them.
  assert.equal(sb.status().stages.script.status, "stale");
});

test("an admin-provided snapshot (PIPELINE_SETTINGS) beats the file, and an invalid one is a config error", () => {
  const sb = sandbox(DEFAULT_SETTINGS);
  const snap = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  snap.formats.short = { targetSeconds: 50, minSeconds: 30, maxSeconds: 60 };
  assert.equal(sb.run(["--stage", "research"], { PIPELINE_SETTINGS: JSON.stringify({ settings: snap, source: "job" }) }).code, 0);
  assert.equal(sb.read(`out/${SLUG}/state.json`).run.settings.formats.short.targetSeconds, 50);
  snap.formats.short.minSeconds = 90;
  const bad = sb.run(["--stage", "research"], { PIPELINE_SETTINGS: JSON.stringify({ settings: snap }) });
  assert.notEqual(bad.code, 0);
  assert.match(bad.out, /config/);
});

test("the director sees the outline and the research claims; the fact-check covers both scripts", () => {
  const sb = sandbox();
  assert.equal(sb.run(["--to", "direct"]).code, 0);
  const d = sb.calls().filter((c) => c.kind === "direct");
  assert.ok(d.length >= 2, "each cut is directed (long scripts in batches)");
  assert.ok(d.every((x) => x.hasOutline && x.hasClaims));
  assert.equal(sb.read(`specs/${SLUG}.json`).direction.status, "directed");
  assert.equal(sb.read(`specs/${SLUG}.short.json`).direction.status, "directed");
  const sources = sb.read(`specs/${SLUG}.sources.json`);
  assert.ok(sources.claims.every((c) => c.verdict === "ok") && sources.researchHash);
});

test("legacy single-storyboard videos stay readable: they serve both cuts, with no crash", () => {
  const sb = sandbox();
  mkdirSync(join(sb.data, "specs"), { recursive: true });
  writeFileSync(join(sb.data, `specs/${SLUG}.json`), readFileSync(join(ROOT, "test/fixtures/v1-spec.json"), "utf8").replace(/"slug": "[^"]+"/, `"slug": "${SLUG}"`));
  const st = sb.status();
  assert.equal(st.formats.main.ownScript, true);
  assert.equal(st.formats.short.ownScript, false);
  assert.match(st.stages.script.reason, /old single storyboard|written before/);
  assert.equal(st.stages.research.status, "missing");
});
