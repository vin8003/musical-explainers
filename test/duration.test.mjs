// Duration enforcement on produced media: the audio stage's gate, Short cuts of
// per-format storyboards, and the status shown for a failed duration.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { buildTimeline, shotsFor } from "../src/schema/timeline.mjs";

const tsx = (code, env = {}) => {
  const r = spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "-e", code], { encoding: "utf8", env: { ...process.env, ...env } });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split("\n").pop());
};

const report = (seconds, verdict, extra = {}) => ({ narrationSeconds: seconds * 0.6, seconds, spokenWords: 100, measuredWpm: 150, narrationShare: 0.6, targetSeconds: 420, minSeconds: 300, maxSeconds: 600, verdict, message: `${seconds}s ${verdict}`, ...extra });
const gate = (durations, env) => tsx(`
  import { durationGate, DurationError } from "./scripts/stages/audio";
  const m = { durations: ${JSON.stringify(durations)} };
  try { durationGate(m as any, ["main", "short"]); console.log(JSON.stringify({ ok: true })); }
  catch (e) { console.log(JSON.stringify({ ok: false, duration: e instanceof DurationError, kind: (e as any).kind, message: (e as Error).message, failing: (e as any).failing?.map((f: any) => f.format) })); }
`, env);

test("measured audio within the target tolerance passes the gate; off-target blocks like short and long", () => {
  assert.equal(gate({ main: report(430, "ok"), short: report(44, "ok") }).ok, true);
  const r = gate({ main: report(310, "off-target"), short: report(44, "ok") });
  assert.equal(r.ok, false);
  assert.equal(r.duration, true);
  assert.deepEqual(r.failing, ["main"]);
  assert.equal(gate({ main: report(310, "off-target") }, { ALLOW_DURATION_MISMATCH: "1" }).ok, true);
});

test("the issue's example: 5:10 against a 7:00 target is inside min-max but is not accepted", () => {
  const r = tsx(`
    import { durationFindings } from "./scripts/stages/qa";
    import { DEFAULT_SETTINGS } from "./src/schema/settings.mjs";
    const s = { ...DEFAULT_SETTINGS, formats: { ...DEFAULT_SETTINGS.formats, main: { targetSeconds: 420, minSeconds: 300, maxSeconds: 600 } } };
    console.log(JSON.stringify({ off: durationFindings(310, s as any, "main"), ok: durationFindings(425, s as any, "main", 425.2), mismatch: durationFindings(425, s as any, "main", 400) }));
  `);
  assert.equal(r.off.verdict, "off-target");
  assert.deepEqual(r.off.findings.map((f) => [f.check, f.severity]), [["duration-target", "fail"]]);
  assert.deepEqual(r.ok.findings, []);
  assert.deepEqual(r.mismatch.findings.map((f) => f.check), ["duration-soundtrack"]);
});

test("a failed QA report blocks packaging and shows as a failed stage; the candidate records the probed MP4 length", () => {
  const r = spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "test/fixtures/qa-blocks-package.ts"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split("\n").pop());
  assert.equal(out.qaStage, "failed");
  assert.match(out.packageError, /Not packaging a candidate that failed QA/);
  assert.equal(out.noReportError, "The latest candidate has not passed QA yet");
  assert.ok(Math.abs(out.probed - 2.5) < 0.1, `probed ${out.probed}`);
  assert.equal(out.probeMissing, null);
});

test("measured audio too short or too long fails with a duration error naming the cut", () => {
  const r = gate({ main: report(200, "short"), short: report(44, "ok") });
  assert.equal(r.ok, false);
  assert.equal(r.duration, true);
  assert.equal(r.kind, "duration");
  assert.deepEqual(r.failing, ["main"]);
  assert.match(r.message, /Landscape.*measured 3:20/);
  const both = gate({ main: report(700, "long"), short: report(80, "long") });
  assert.deepEqual(both.failing, ["main", "short"]);
});

test("ALLOW_DURATION_MISMATCH=1 is the only way past a duration failure", () => {
  assert.equal(gate({ main: report(200, "short") }, { ALLOW_DURATION_MISMATCH: "1" }).ok, true);
});

test("a stored duration failure makes the audio stage failed in the status, not fresh", () => {
  const r = spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "test/fixtures/status-duration.ts"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split("\n").pop());
  assert.equal(out.status, "failed");
  assert.match(out.reason, /duration: main 0:20 is shorter than the minimum 5:00/);
});

test("a Short with its own storyboard uses every shot; legacy storyboards still cut the Short from marked shots", () => {
  const shots = [
    { id: "a", section: "intro", narration: "one two", visual: { type: "title", title: "A" } },
    { id: "b", section: "verse", narration: "three four", visual: { type: "kinetic" } },
    { id: "c", section: "outro", narration: "five six", short: true, visual: { type: "kinetic" } },
  ];
  const own = { schemaVersion: 2, slug: "t", title: "T", format: "short", music: { bpm: 120 }, shots };
  const legacy = { ...own, format: undefined };
  assert.deepEqual(shotsFor(own, "short").map((s) => s.id), ["a", "b", "c"]);
  assert.deepEqual(shotsFor(legacy, "short").map((s) => s.id), ["c"]);
  assert.equal(buildTimeline(own, "short").shots.length, 3);
});

test("timelines estimate narration at the configured delivery rate until audio is measured", () => {
  const words = Array.from({ length: 60 }, () => "w").join(" ");
  const spec = { schemaVersion: 2, slug: "t", title: "T", music: { bpm: 120 }, shots: [{ id: "a", section: "verse", narration: words, visual: { type: "kinetic" } }] };
  const slow = buildTimeline(spec, "main", {}, 30, { wordsPerMinute: 100 });
  const fast = buildTimeline(spec, "main", {}, 30, { wordsPerMinute: 200 });
  assert.ok(slow.totalFrames > fast.totalFrames);
  // Measured lengths override estimates.
  const measured = buildTimeline(spec, "main", { a: 1 }, 30, { wordsPerMinute: 100 });
  assert.ok(measured.totalFrames < slow.totalFrames);
});
