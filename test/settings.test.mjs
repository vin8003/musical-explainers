// Duration settings: defaults, validation (no silent clamping), legacy/malformed
// files, the duration verdicts, and the admin API that saves them.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { checkDuration, DEFAULT_SETTINGS, formatKey, normalizeSettings, resolveSettings, validateSettings } from "../src/schema/settings.mjs";
import { estimateRuntime } from "../src/schema/timeline.mjs";

const clone = (x) => JSON.parse(JSON.stringify(x));

test("defaults: landscape 7:00 (5:00-10:00), Short 0:45 (0:30-1:00), and they validate", () => {
  assert.deepEqual(DEFAULT_SETTINGS.formats.main, { targetSeconds: 420, minSeconds: 300, maxSeconds: 600 });
  assert.deepEqual(DEFAULT_SETTINGS.formats.short, { targetSeconds: 45, minSeconds: 30, maxSeconds: 60 });
  assert.deepEqual(validateSettings(DEFAULT_SETTINGS), []);
});

test("defaults are not hard limits: other valid ranges are accepted", () => {
  const s = clone(DEFAULT_SETTINGS);
  s.formats.main = { targetSeconds: 900, minSeconds: 600, maxSeconds: 1200 };
  s.formats.short = { targetSeconds: 20, minSeconds: 10, maxSeconds: 30 };
  assert.deepEqual(validateSettings(s), []);
});

test("invalid values are errors, never clamped", () => {
  const bad = (mut) => { const s = clone(DEFAULT_SETTINGS); mut(s); return validateSettings(s); };
  assert.ok(bad((s) => (s.formats.main.minSeconds = 700)).some((p) => /minimum .* longer than maximum/.test(p)));
  assert.ok(bad((s) => (s.formats.short.targetSeconds = 10)).some((p) => /target .* shorter than the minimum/.test(p)));
  assert.ok(bad((s) => (s.formats.short.targetSeconds = 100)).some((p) => /target .* longer than the maximum/.test(p)));
  assert.ok(bad((s) => (s.formats.main.targetSeconds = 0)).some((p) => /positive/.test(p)));
  assert.ok(bad((s) => (s.formats.main.targetSeconds = -5)).some((p) => /positive/.test(p)));
  assert.ok(bad((s) => (s.formats.main.maxSeconds = Infinity)).some((p) => /positive/.test(p)));
  assert.ok(bad((s) => (s.formats.main.maxSeconds = "600")).some((p) => /positive/.test(p)));
  assert.ok(bad((s) => (s.formats.main.maxSeconds = NaN)).some((p) => /positive/.test(p)));
  assert.ok(bad((s) => delete s.formats.short).some((p) => /missing/.test(p)));
  assert.ok(bad((s) => (s.narration.wordsPerMinute = 5)).some((p) => /words per minute/.test(p)));
  assert.ok(bad((s) => (s.narration.targetTolerance = 0)).some((p) => /tolerance/.test(p)));
  assert.ok(validateSettings(null).length && validateSettings([]).length);
});

test("resolveSettings: missing file -> defaults; partial -> defaults fill gaps; invalid or malformed -> defaults plus a warning", () => {
  assert.equal(resolveSettings(null).source, "defaults");
  const partial = resolveSettings({ formats: { short: { targetSeconds: 50 } } });
  assert.equal(partial.settings.formats.short.targetSeconds, 50);
  assert.equal(partial.settings.formats.short.maxSeconds, 60);
  assert.deepEqual(partial.settings.formats.main, DEFAULT_SETTINGS.formats.main);
  assert.equal(partial.source, "file+defaults");
  const reversed = resolveSettings({ formats: { main: { minSeconds: 900 } } });
  assert.deepEqual(reversed.settings, DEFAULT_SETTINGS);
  assert.ok(reversed.warnings[0].includes("invalid"));
  const junk = resolveSettings("nope");
  assert.deepEqual(junk.settings, DEFAULT_SETTINGS);
  assert.ok(junk.warnings.length);
  // Unknown keys are dropped.
  assert.equal("extra" in normalizeSettings({ ...DEFAULT_SETTINGS, extra: 1 }), false);
});

test("checkDuration: short, long, off-target and ok", () => {
  assert.equal(checkDuration(200, DEFAULT_SETTINGS, "main").verdict, "short");
  assert.equal(checkDuration(700, DEFAULT_SETTINGS, "main").verdict, "long");
  assert.equal(checkDuration(310, DEFAULT_SETTINGS, "main").verdict, "off-target");
  assert.equal(checkDuration(430, DEFAULT_SETTINGS, "main").verdict, "ok");
  assert.equal(checkDuration(25, DEFAULT_SETTINGS, "short").verdict, "short");
  assert.equal(checkDuration(46, DEFAULT_SETTINGS, "short").verdict, "ok");
  assert.equal(checkDuration(NaN, DEFAULT_SETTINGS, "short").verdict, "unknown");
});

test("both formats get their own range in the cache key, and a change in one leaves the other's key alone", () => {
  const a = formatKey(DEFAULT_SETTINGS, "main"), b = formatKey(DEFAULT_SETTINGS, "short");
  assert.notEqual(a, b);
  const s = clone(DEFAULT_SETTINGS);
  s.formats.main.targetSeconds = 480;
  assert.notEqual(formatKey(s, "main"), a);
  assert.equal(formatKey(s, "short"), b);
  s.narration.wordsPerMinute = 170;
  assert.notEqual(formatKey(s, "short"), b);
});

test("runtime estimates use the configured delivery rate and count chorus and bar time", () => {
  const words = (n) => Array.from({ length: n }, () => "word").join(" ");
  const spec = { schemaVersion: 2, slug: "t", title: "T", music: { bpm: 120 }, shots: [
    { id: "a", section: "verse", narration: words(30), visual: { type: "kinetic" } },
    { id: "c", section: "chorus", lyric: "one two three four five six", visual: { type: "kinetic" } },
  ] };
  const slow = estimateRuntime(spec, "main", 120), fast = estimateRuntime(spec, "main", 200);
  assert.ok(slow.seconds > fast.seconds);
  assert.equal(slow.spokenWords, 30);
  assert.equal(slow.sungWords, 6);
  // The chorus shot has no narration but still takes whole bars of time.
  assert.ok(slow.seconds > slow.narrationSeconds);
});

// ---- admin API ----

const PORT = 4500 + Math.floor(Math.random() * 40);
const url = (p) => `http://127.0.0.1:${PORT}${p}`;
const put = (body) => fetch(url("/api/settings"), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
let proc, data;

before(async () => {
  data = mkdtempSync(join(tmpdir(), "me-settings-"));
  proc = spawn(process.execPath, ["admin/server.mjs"], { env: { ...process.env, ADMIN_PORT: String(PORT), DATA_ROOT: data }, stdio: "pipe" });
  for (let i = 0; i < 60; i++) {
    try { await fetch(url("/api/meta")); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error("server did not start");
});
after(() => proc.kill());

test("admin API: GET returns defaults when nothing is saved", async () => {
  const r = await (await fetch(url("/api/settings"))).json();
  assert.equal(r.source, "defaults");
  assert.deepEqual(r.settings.formats, DEFAULT_SETTINGS.formats);
});

test("admin API: invalid input is rejected with a clear message and nothing is written", async () => {
  const bad = clone(DEFAULT_SETTINGS);
  bad.formats.main.minSeconds = 700;
  const res = await put(bad);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /minimum .* longer than maximum/);
  const again = await (await fetch(url("/api/settings"))).json();
  assert.equal(again.source, "defaults");
  const garbage = await fetch(url("/api/settings"), { method: "PUT", headers: { "content-type": "application/json" }, body: "{nope" });
  assert.equal(garbage.status, 400);
});

test("admin API: valid updates persist to config/settings.json and are read back", async () => {
  const s = clone(DEFAULT_SETTINGS);
  s.formats.main = { targetSeconds: 480, minSeconds: 360, maxSeconds: 660 };
  const res = await put(s);
  assert.equal(res.status, 200);
  const onDisk = JSON.parse(readFileSync(join(data, "config/settings.json"), "utf8"));
  assert.deepEqual(onDisk.formats.main, s.formats.main);
  const got = await (await fetch(url("/api/settings"))).json();
  assert.equal(got.source, "file");
  assert.equal(got.settings.formats.main.targetSeconds, 480);
  assert.deepEqual(got.settings.formats.short, DEFAULT_SETTINGS.formats.short);
});

test("admin API: a malformed or legacy settings file falls back to defaults with a warning, and can be re-saved", async () => {
  writeFileSync(join(data, "config/settings.json"), "{ broken");
  let got = await (await fetch(url("/api/settings"))).json();
  assert.equal(got.source, "defaults");
  assert.ok(got.warnings.some((w) => /can't be parsed/.test(w)));
  mkdirSync(join(data, "config"), { recursive: true });
  writeFileSync(join(data, "config/settings.json"), JSON.stringify({ formats: { main: { targetSeconds: 600 } } }));
  got = await (await fetch(url("/api/settings"))).json();
  assert.equal(got.settings.formats.main.targetSeconds, 600);
  assert.equal(got.settings.formats.main.maxSeconds, 600);
  assert.equal(got.source, "file+defaults");
  assert.equal((await put(DEFAULT_SETTINGS)).status, 200);
});

test("admin API: cross-origin settings writes are refused", async () => {
  const r = await fetch(url("/api/settings"), { method: "PUT", headers: { origin: "http://evil.example", "content-type": "application/json" }, body: JSON.stringify(DEFAULT_SETTINGS) });
  assert.equal(r.status, 403);
});
