// Usage ledger, repair and budget stops through the whole pipeline (stand-in `claude`), and the
// admin server's usage API, live events and the UI's rendering of them. No network, no model.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { after, test } from "node:test";
import { DEFAULT_SETTINGS } from "../src/schema/settings.mjs";
import { aggregate, parseLedger } from "../src/schema/usage.mjs";
import { validateResearch } from "../src/schema/editorial.mjs";

const ROOT = process.cwd();
const FAKE = join(ROOT, "test/fixtures/fake-claude.mjs");
const TSX = join(ROOT, "node_modules/tsx/dist/cli.mjs");
const SLUG = "demo-topic";
const clone = (x) => JSON.parse(JSON.stringify(x));

function sandbox(budgets) {
  const data = mkdtempSync(join(tmpdir(), "me-upipe-"));
  mkdirSync(join(data, "topics"), { recursive: true });
  writeFileSync(join(data, "topics/backlog.json"), JSON.stringify({ version: 1, topics: [{ slug: SLUG, title: "Demo topic", category: "x", angle: "a hook", chorusIdea: "A to B to C", status: "queued", priority: 1 }] }));
  const settingsPath = join(data, "config/settings.json");
  const setBudgets = (b) => { mkdirSync(join(data, "config"), { recursive: true }); writeFileSync(settingsPath, JSON.stringify({ ...clone(DEFAULT_SETTINGS), budgets: b })); };
  if (budgets) setBudgets(budgets);
  const log = join(data, "calls.jsonl");
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const read = (f) => JSON.parse(readFileSync(join(data, f), "utf8"));
  const ledger = () => (existsSync(join(data, `out/${SLUG}/usage.jsonl`)) ? parseLedger(readFileSync(join(data, `out/${SLUG}/usage.jsonl`), "utf8")) : []);
  const run = (args, env = {}) => {
    const r = spawnSync(process.execPath, [TSX, "scripts/pipeline.ts", SLUG, ...args], { cwd: ROOT, encoding: "utf8", env: { ...process.env, DATA_ROOT: data, CLAUDE_BIN: FAKE, FAKE_LOG: log, AUDIO_VOICE: "none", CLAUDE_MODEL: "", CLAUDE_EFFORT: "", ...env }, timeout: 180000 });
    return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
  };
  return { data, run, calls, read, ledger, setBudgets, settingsPath };
}
const events = (out) => [...out.matchAll(/^@@ (\{.*"event":"usage".*\})$/gm)].map((m) => JSON.parse(m[1]));

test("every Claude call lands in the ledger with known usage; stage and run summaries print; cached stages add nothing", () => {
  const sb = sandbox();
  const r = sb.run(["--stage", "research"]);
  assert.equal(r.code, 0, r.out);
  const rows = sb.ledger();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stage, "research");
  assert.equal(rows[0].provider, "claude");
  assert.equal(rows[0].usage.status, "known");
  assert.equal(rows[0].status, "ok");
  assert.equal(rows[0].requestedModel, "sonnet");
  assert.match(r.out, /usage: 1 call, in 160 \(cache read 100\), out 20, est\. cost \$0\.0100/);
  assert.match(r.out, /\[usage\] this run: 1 call/);
  const ev = events(r.out);
  assert.deepEqual([...new Set(ev.map((e) => e.type))].sort(), ["call_completed", "call_started", "usage_updated"]);
  assert.equal(ev.filter((e) => e.type === "usage_updated").at(-1).totals.calls, 1);
  assert.equal(ev.at(-1).v, 1);
  // A cached re-run makes no call and records none (no fabricated usage).
  const again = sb.run(["--to", "research"]);
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /up to date/);
  assert.match(again.out, /\[usage\] this run: no AI calls/);
  assert.equal(sb.ledger().length, 1);
  assert.equal(sb.calls().length, 1);
});

test("a ChatGPT-selected run fails before model work when disconnected and never launches Claude", () => {
  const sb = sandbox();
  const settings = clone(DEFAULT_SETTINGS);
  settings.provider = "chatgpt";
  for (const model of Object.values(settings.providers.chatgpt.models)) model.model = "not-used-without-account";
  mkdirSync(join(sb.data, "config"), { recursive: true });
  writeFileSync(sb.settingsPath, JSON.stringify(settings));
  const r = sb.run(["--stage", "research"], { ANTHROPIC_API_KEY: "must-not-be-read", CLAUDE_MODEL: "haiku" });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /ChatGPT is disconnected|sign in with ChatGPT/i);
  assert.equal(sb.calls().length, 0, "the scripted Claude CLI was not invoked as a fallback");
  assert.equal(sb.ledger().length, 0, "preflight failure did not create a model-call record");
});

test("missing usage metadata is reported as unknown in the terminal, never as zero", () => {
  const sb = sandbox();
  const r = sb.run(["--stage", "research"], { FAKE_MODE: "no-usage" });
  assert.equal(r.code, 0, r.out);
  assert.equal(sb.ledger()[0].usage.status, "unknown");
  assert.match(r.out, /tokens in: unknown, out: unknown, est\. cost: unavailable/);
  assert.doesNotMatch(r.out, /out 0\b/);
});

test("research with one invalid field is repaired by a field patch: one research call, one small repair, evidence preserved", () => {
  const sb = sandbox();
  const r = sb.run(["--stage", "research"], { FAKE_MODE: "bad-claim" });
  assert.equal(r.code, 0, r.out);
  const c = sb.calls();
  assert.equal(c.filter((x) => x.kind === "research").length, 1, "the research prompt (and its web searches) ran once");
  const rep = c.find((x) => x.kind === "repair-fields");
  assert.ok(rep && !rep.hasOriginalPrompt && rep.chars < 3000);
  const dossier = sb.read(`specs/${SLUG}.research.json`);
  assert.deepEqual(validateResearch(dossier), []);
  assert.equal(dossier.claims[2].sources[0].url, "https://example.org/fixed");
  assert.equal(dossier.claims[2].sources[0].passage, "Finding 3");
  assert.equal(dossier.claims.length, 9);
  assert.equal(dossier.claims.filter((x) => x.status === "supported" && x.sources.length).length, 8);
  const rows = sb.ledger();
  assert.deepEqual(rows.map((x) => x.kind), ["generation", "repair-fields"]);
  assert.equal(rows[0].status, "failed");
  assert.equal(rows[1].status, "ok");
  assert.ok(events(r.out).some((e) => e.type === "repair_started"));
});

test("a repair the validator still rejects fails the stage (invalid output is never accepted); both calls are recorded", () => {
  const sb = sandbox();
  const r = sb.run(["--stage", "research"], { FAKE_MODE: "bad-claim,bad-claim-always" });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /invalid: The selected provider's output is still invalid after 1 repair/);
  assert.equal(sb.ledger().length, 2);
  assert.ok(!existsSync(join(sb.data, `specs/${SLUG}.research.json`)));
});

test("a budget stop is clean: no call is started, finished work is kept, the reason is persisted, and raising the limit resumes the same run", () => {
  const sb = sandbox({ run: { maxCalls: 2 } });
  const r = sb.run(["--to", "outline"]);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /\[pipeline\] budget: Usage budget reached; no AI call was started/);
  assert.match(r.out, /run\.maxCalls \(limit 2, used 2, stage outline\)/);
  const callsAtStop = sb.calls().length;
  assert.equal(callsAtStop, 2, "research + the first outline; the second outline was never launched");
  assert.ok(existsSync(join(sb.data, `specs/${SLUG}.research.json`)), "completed work is kept");
  const state = sb.read(`out/${SLUG}/state.json`);
  assert.equal(state.stages.research.status, "done");
  assert.equal(state.stages.outline.status, "failed");
  assert.equal(state.stages.outline.error.kind, "budget");
  assert.equal(state.usage.stop.blocks[0].budget, "run.maxCalls");
  assert.ok(events(r.out).some((e) => e.type === "budget_exceeded" && e.blocks[0].limit === 2));
  const runId = state.usage.runId;
  const blocked = sb.ledger().filter((x) => x.status === "blocked");
  assert.equal(blocked.length, 1);
  assert.equal(aggregate(sb.ledger()).calls, 2);
  // Raise the limit (empty = unrestricted) and continue: same run, totals restored, nothing redone.
  sb.setBudgets({ run: { maxCalls: null } });
  const r2 = sb.run(["--to", "outline"]);
  assert.equal(r2.code, 0, r2.out);
  assert.equal(sb.calls().filter((c) => c.kind === "research").length, 1, "research was not repeated");
  const after = sb.read(`out/${SLUG}/state.json`);
  assert.equal(after.usage.runId, runId, "a resumed run keeps its run id and totals");
  assert.equal(after.usage.stop, null);
  assert.ok(after.usage.completedAt);
  assert.equal(aggregate(sb.ledger().filter((x) => x.runId === runId)).calls, 3);
  // The next run starts with new counters.
  const r3 = sb.run(["--stage", "research"]);
  assert.equal(r3.code, 0, r3.out);
  assert.notEqual(sb.read(`out/${SLUG}/state.json`).usage.runId, runId);
});

test("a stage budget stops only that stage's calls and names it", () => {
  const sb = sandbox({ stage: { maxCalls: 0 } });
  const r = sb.run(["--stage", "research"]);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /stage\.maxCalls \(limit 0, used 0, stage research\)/);
  assert.equal(sb.calls().length, 0);
});

test("videos made before usage tracking have no ledger and run fine", () => {
  const sb = sandbox();
  assert.equal(sb.ledger().length, 0);
  const r = spawnSync(process.execPath, [TSX, "scripts/pipeline.ts", SLUG, "--status"], { cwd: ROOT, encoding: "utf8", env: { ...process.env, DATA_ROOT: sb.data } });
  assert.equal(r.status, 0, r.stderr);
});

// ---------- admin server ----------

const PORT = 4500 + Math.floor(Math.random() * 90);
const url = (p) => `http://127.0.0.1:${PORT}${p}`;
let proc;
const adminData = mkdtempSync(join(tmpdir(), "me-uadmin-"));
mkdirSync(join(adminData, "topics"), { recursive: true });
writeFileSync(join(adminData, "topics/backlog.json"), JSON.stringify({ version: 1, topics: [{ slug: SLUG, title: "Demo topic", category: "x", angle: "a", chorusIdea: "b", status: "queued", priority: 1 }, { slug: "old-video", title: "Old video", category: "x", angle: "a", chorusIdea: "b", status: "queued", priority: 2 }] }));
const adminLog = join(adminData, "calls.jsonl");

async function startAdmin() {
  if (proc) return;
  proc = spawn(process.execPath, ["admin/server.mjs"], { env: { ...process.env, ADMIN_PORT: String(PORT), DATA_ROOT: adminData, CLAUDE_BIN: FAKE, FAKE_LOG: adminLog, AUDIO_VOICE: "none" }, stdio: "pipe" });
  for (let i = 0; i < 60; i++) {
    try { await fetch(url("/api/meta")); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error("admin did not start");
}
after(() => proc?.kill());
const put = (p, body) => fetch(url(p), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("admin: usage budgets are validated and persisted; empty = unrestricted, 0 is kept, negatives are rejected", async () => {
  await startAdmin();
  const cur = await (await fetch(url("/api/settings"))).json();
  const s = clone(cur.settings);
  s.budgets.run.maxCalls = -3;
  const bad = await put("/api/settings", s);
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /maxCalls/);
  s.budgets.run = { maxCalls: "", maxInputTokens: 0, maxOutputTokens: 5000, maxEstimatedCost: null };
  s.budgets.warnings.usagePercent = 70;
  const ok = await put("/api/settings", s);
  assert.equal(ok.status, 200);
  const saved = JSON.parse(readFileSync(join(adminData, "config/settings.json"), "utf8"));
  assert.equal(saved.budgets.run.maxCalls, null);
  assert.equal(saved.budgets.run.maxInputTokens, 0);
  assert.equal(saved.budgets.run.maxOutputTokens, 5000);
  assert.equal(saved.budgets.warnings.usagePercent, 70);
  const back = await (await fetch(url("/api/settings"))).json();
  assert.equal(back.settings.budgets.run.maxInputTokens, 0);
  // restore to unrestricted for the following tests
  s.budgets = clone(DEFAULT_SETTINGS.budgets);
  assert.equal((await put("/api/settings", s)).status, 200);
});

test("admin: an old video without a ledger reports usage as unavailable, not zero", async () => {
  await startAdmin();
  const u = await (await fetch(url("/api/videos/old-video/usage"))).json();
  assert.equal(u.available, false);
  assert.ok(!("totals" in u));
  assert.match(u.note, /not recorded/);
});

test("admin: a job streams usage live (SSE) and the persisted ledger restores it after a reload", async () => {
  await startAdmin();
  const seen = [];
  const ac = new AbortController();
  const res = await fetch(url("/api/events"), { signal: ac.signal });
  const reader = res.body.getReader();
  let buf = "";
  (async () => {
    const dec = new TextDecoder();
    try { for (;;) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value); } } catch { /* aborted */ }
  })();
  const started = await fetch(url(`/api/videos/${SLUG}/run`), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "stage", stage: "research" }) });
  assert.equal(started.status < 300, true, await started.clone().text());
  let job;
  for (let i = 0; i < 150; i++) {
    job = (await (await fetch(url("/api/jobs"))).json())[0];
    if (job && (job.state === "done" || job.state === "failed")) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.equal(job.state, "done", JSON.stringify(job));
  await new Promise((r) => setTimeout(r, 200));
  ac.abort();
  for (const block of buf.split("\n\n")) if (block.startsWith("event: usage")) seen.push(JSON.parse(block.split("data: ")[1]));
  assert.ok(seen.some((e) => e.type === "call_started"));
  assert.ok(seen.some((e) => e.type === "usage_updated" && e.totals.calls === 1 && e.slug === SLUG));
  assert.ok(seen.some((e) => e.type === "call_completed" && e.call.usage.outputTokens === 20));
  assert.equal(job.usage.totals.calls, 1, "the job summary carries the live totals");
  // "Reload": the page fetches persisted state, which matches what streamed.
  const u = await (await fetch(url(`/api/videos/${SLUG}/usage`))).json();
  assert.equal(u.available, true);
  assert.equal(u.totals.calls, job.usage.totals.calls);
  assert.equal(u.totals.outputTokens, 20);
  assert.equal(u.calls.length, 1);
  assert.equal(u.calls[0].usage.cacheReadTokens, 100);
  assert.ok(!JSON.stringify(u).includes("You are the researcher"), "no prompt text is exposed");
  assert.match(u.cost, /not a bill/);
  // Run totals match the per-stage and per-call numbers.
  assert.equal(Object.values(u.stages).reduce((n, s) => n + s.calls, 0), u.totals.calls);
  assert.equal(u.calls.reduce((n, c) => n + c.usage.outputTokens, 0), u.totals.outputTokens);
});

test("admin: a budget stop is visible in the job, the usage API and the failure category", async () => {
  await startAdmin();
  const s = (await (await fetch(url("/api/settings"))).json()).settings;
  s.budgets.run.maxCalls = 1;
  assert.equal((await put("/api/settings", s)).status, 200);
  const started = await fetch(url(`/api/videos/${SLUG}/run`), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "stage", stage: "outline" }) });
  assert.equal(started.status < 300, true);
  let job;
  for (let i = 0; i < 150; i++) {
    job = (await (await fetch(url("/api/jobs"))).json())[0];
    if (job.state === "done" || job.state === "failed") break;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.equal(job.state, "failed");
  assert.equal(job.errorKind, "budget");
  assert.equal(job.failure, "usage budget");
  assert.equal(job.usage.stop.blocks[0].budget, "run.maxCalls");
  const u = await (await fetch(url(`/api/videos/${SLUG}/usage`))).json();
  assert.equal(u.stop.blocks[0].budget, "run.maxCalls");
  assert.ok(u.limits.some((l) => l.state === "exceeded" && l.scope === "run"));
  assert.equal(u.totals.blocked, 1);
});

// ---------- UI rendering (the real app.js in a stubbed DOM) ----------

function loadUi(fetchImpl) {
  const el = () => ({ innerHTML: "", hidden: false, dataset: {}, style: {}, classList: { add() {}, remove() {} }, append() {}, remove() {}, querySelector: () => el(), querySelectorAll: () => [], addEventListener() {} });
  const document = { querySelector: () => el(), querySelectorAll: () => [], createElement: () => el(), body: el() };
  const ctx = vm.createContext({ document, window: { addEventListener() {} }, fetch: fetchImpl, EventSource: class { addEventListener() {} }, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, console, location: { hash: "" }, history: {}, confirm: () => true });
  vm.runInContext(readFileSync(join(ROOT, "admin/public/app.js"), "utf8"), ctx);
  return ctx;
}
const usageSchema = await import("../src/schema/usage.mjs");

test("UI: usage tab shows live totals, unknown as 'unknown', stage ranking, warnings and the hard-stop banner", async () => {
  const mk = (stage, over = {}) => ({ callId: Math.random().toString(36), stage, operation: stage, kind: "generation", repair: false, attempt: 0, model: "sonnet", effort: "high", status: "ok", startedAt: "2026-01-01T00:00:00.000Z", durationMs: 1500, usage: { status: "known", inputTokens: 10, outputTokens: 400, cacheReadTokens: 100, cacheCreationTokens: 50, totalInputTokens: 160, cost: { usd: 0.01 } }, ...over });
  const unknownCall = mk("outline", { usage: { status: "unknown", inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null, totalInputTokens: null, cost: null } });
  const calls = [mk("research"), mk("research", { kind: "repair-fields", repair: true, reason: "1 failing field(s): claims[2]" }), unknownCall];
  const budgets = { ...clone(DEFAULT_SETTINGS.budgets), run: { ...DEFAULT_SETTINGS.budgets.run, maxOutputTokens: 1000 } };
  const sum = usageSchema.summarize(calls, budgets);
  const payload = { available: true, slug: SLUG, runId: "r", runs: ["r"], budgets, totals: sum.run, stages: sum.stages, limits: sum.limits, calls, stop: { stage: "outline", blocks: [{ budget: "run.maxOutputTokens", limit: 1000, used: 800, reason: "800 of 1000 output tokens already used" }] }, cost: "x" };
  const ctx = loadUi(async () => ({ ok: true, json: async () => payload }));
  vm.runInContext(`U = null; S.route = { name: "video", slug: "${SLUG}", tab: "usage" };`, ctx);
  ctx.U = usageSchema;
  vm.runInContext(`globalThis.__body = { innerHTML: "", querySelector: () => ({}), querySelectorAll: () => [] }; globalThis.__p = renderUsageTab(__body);`, ctx);
  await ctx.__p;
  const html = ctx.__body.innerHTML;
  assert.match(html, /Stopped by a usage budget/);
  assert.match(html, /run\.maxOutputTokens/);
  assert.match(html, /usage partial/, "completeness is shown");
  assert.ok(html.indexOf("<td><b>research</b>") > 0 && html.indexOf("<td><b>research</b>") < html.indexOf("<td><b>outline</b>"), "most expensive stage first");
  assert.match(html, /unknown/, "unknown is spelled out");
  assert.match(html, /warning/, "800/1000 crosses the 80% threshold");
  assert.match(html, /repair-fields/);
  assert.match(html, /1 failing field\(s\): claims\[2\]/);
  assert.match(html, /never stored|metadata only/);
  // Totals on screen equal the sum of the call rows.
  assert.equal(sum.run.outputTokens, 800);
  assert.match(html, /800/);
  // Old video: unavailable, not zero.
  const old = loadUi(async () => ({ ok: true, json: async () => ({ available: false, note: "Usage was not recorded for this video" }) }));
  vm.runInContext(`S.route = { name: "video", slug: "x", tab: "usage" }; globalThis.__body = { innerHTML: "", querySelector: () => ({}), querySelectorAll: () => [] }; globalThis.__p = renderUsageTab(__body);`, old);
  await old.__p;
  assert.match(old.__body.innerHTML, /not recorded/);
  assert.doesNotMatch(old.__body.innerHTML, /Output tokens/);
});

test("UI: the job strip shows unknown usage as unknown and flags limits; the settings form explains empty = no limit", () => {
  const ctx = loadUi(async () => ({}));
  ctx.U = usageSchema;
  const strip = (u) => { ctx.__u = u; return vm.runInContext("usageStripHtml(__u)", ctx); };
  const unknown = aggregateOf([{ stage: "a", status: "ok", usage: usageSchema.unknownUsage() }]);
  const html = strip({ totals: unknown, limits: [] });
  assert.match(html, /in unknown · out unknown/);
  assert.match(html, /est\. cost unavailable/);
  assert.doesNotMatch(html, /out 0/);
  const hot = strip({ totals: unknown, limits: [{ scope: "run", stage: null, label: "AI calls", pct: 100, state: "exceeded" }], stop: { stage: "script", blocks: [{ budget: "run.maxCalls" }] } });
  assert.match(hot, /limit|AI calls 100%/);
  assert.match(hot, /Stopped by usage budget/);
  assert.equal(strip(null), "");
  ctx.__b = DEFAULT_SETTINGS.budgets;
  const form = vm.runInContext("budgetsFormHtml(__b)", ctx);
  assert.match(form, /Leave a field empty for no limit/);
  assert.match(form, /placeholder="no limit"/);
  assert.match(form, /0<\/b> is a real zero/);
});
function aggregateOf(rows) { return usageSchema.aggregate(rows); }
