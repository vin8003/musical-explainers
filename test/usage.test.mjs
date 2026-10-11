// Usage accounting, token-conscious repair and budget enforcement.
// Pure rules are tested directly; Provider calls run through the real scripts/ai.ts
// against a scripted stand-in CLI (test/fixtures/scripted-claude.mjs). No network, no model.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SETTINGS, normalizeSettings, resolveSettings, validateSettings } from "../src/schema/settings.mjs";
import { aggregate, aggregateByStage, decideCall, dedupeLedger, limitStatus, normalizeCliUsage, parseLedger, usageLine } from "../src/schema/usage.mjs";
import { validateResearch } from "../src/schema/editorial.mjs";
import { validDossier } from "./fixtures/dossier.mjs";

const ROOT = process.cwd();
const TSX = join(ROOT, "node_modules/tsx/dist/cli.mjs");
const clone = (x) => JSON.parse(JSON.stringify(x));

// ---------- harness ----------
function lab() {
  const dir = mkdtempSync(join(tmpdir(), "me-usage-"));
  const ledger = join(dir, "usage.jsonl");
  const log = join(dir, "calls.jsonl");
  const script = join(dir, "script.json");
  const rows = () => (existsSync(ledger) ? parseLedger(readFileSync(ledger, "utf8")) : []);
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const play = (steps, harness) => {
    writeFileSync(script, JSON.stringify(steps));
    const r = spawnSync(process.execPath, [TSX, "test/fixtures/claude-harness.ts"], {
      cwd: ROOT, encoding: "utf8", timeout: 60000,
      env: { ...process.env, DATA_ROOT: dir, CLAUDE_MODEL: "", CLAUDE_EFFORT: "", CLAUDE_MODEL_REPAIR: "", CLAUDE_EFFORT_REPAIR: "", CLAUDE_MODEL_SCRIPT: "", CLAUDE_EFFORT_SCRIPT: "", CLAUDE_BIN: join(ROOT, "test/fixtures/scripted-claude.mjs"), SCRIPT: script, FAKE_LOG: log, HARNESS: JSON.stringify({ ledger, ...harness }) },
    });
    const m = r.stdout.match(/@@RESULT (.*)/);
    assert.ok(m, `harness failed: ${r.stdout}\n${r.stderr}`);
    return { results: JSON.parse(m[1]), out: r.stdout };
  };
  return { dir, ledger, rows, calls, play, script };
}

// ---------- usage normalization ----------

const CLI = { result: "ok", total_cost_usd: 0.0158, usage: { input_tokens: 9, cache_creation_input_tokens: 7239, cache_read_input_tokens: 11195, output_tokens: 37, server_tool_use: { web_search_requests: 0 }, iterations: [{}, {}] }, modelUsage: { "claude-haiku-4-5": { inputTokens: 9 } } };

test("CLI usage is normalized: cache categories are separate, input is counted once, native fields are kept", () => {
  const u = normalizeCliUsage(CLI);
  assert.equal(u.status, "known");
  assert.equal(u.inputTokens, 9);
  assert.equal(u.cacheReadTokens, 11195);
  assert.equal(u.cacheCreationTokens, 7239);
  assert.equal(u.totalInputTokens, 9 + 11195 + 7239); // input_tokens excludes cache, so the sum is the real total
  assert.equal(u.outputTokens, 37);
  assert.equal(u.cost.usd, 0.0158);
  assert.match(u.cost.basis, /not a bill/);
  assert.equal(u.modelUsed, "claude-haiku-4-5");
  assert.equal(u.native.usage.server_tool_use.web_search_requests, 0);
  assert.equal(u.native.iterations, 2);
});

test("missing, partial and unexpected usage schemas are handled without inventing numbers", () => {
  const none = normalizeCliUsage({ result: "x" });
  assert.equal(none.status, "unknown");
  assert.equal(none.inputTokens, null);
  assert.equal(none.totalInputTokens, null);
  assert.equal(none.cost, null);
  const partial = normalizeCliUsage({ usage: { input_tokens: 5, output_tokens: 6 } });
  assert.equal(partial.status, "partial");
  assert.equal(partial.cacheReadTokens, null);
  assert.equal(partial.totalInputTokens, 5);
  for (const junk of [null, undefined, "x", 3, { usage: "lots" }, { usage: { input_tokens: "9", output_tokens: -1 } }]) assert.equal(normalizeCliUsage(junk).status, "unknown");
});

const row = (o) => ({ callId: Math.random().toString(36), stage: "research", status: "ok", repair: false, startedAt: "2026-01-01T00:00:00Z", durationMs: 1000, usage: normalizeCliUsage(CLI), ...o });

test("aggregation: unknown stays unknown (null), never zero; partial knowledge is a lower bound", () => {
  const unknownRow = row({ usage: normalizeCliUsage({}) });
  const only = aggregate([unknownRow]);
  assert.equal(only.outputTokens, null);
  assert.equal(only.totalInputTokens, null);
  assert.equal(only.costUsd, null);
  assert.equal(only.completeness, "unknown");
  assert.equal(aggregate([]).completeness, "none");
  const mixed = aggregate([row({}), unknownRow]);
  assert.equal(mixed.outputTokens, 37);
  assert.equal(mixed.completeness, "partial");
  assert.equal(mixed.lowerBound, true);
  assert.equal(mixed.costUnknownCalls, 1);
  assert.match(usageLine(only), /unknown/);
  assert.doesNotMatch(usageLine(only), /out 0/);
});

test("run and stage totals add up; failed, repair and blocked rows are counted correctly", () => {
  const rows = [row({}), row({ status: "failed" }), row({ stage: "outline", repair: true }), row({ stage: "outline", status: "blocked", usage: normalizeCliUsage({}) })];
  const run = aggregate(rows);
  assert.equal(run.calls, 3); // blocked was never launched
  assert.equal(run.blocked, 1);
  assert.equal(run.failed, 1);
  assert.equal(run.repairCalls, 1);
  const stages = aggregateByStage(rows);
  assert.equal(stages.research.calls + stages.outline.calls, run.calls);
  assert.equal(stages.research.outputTokens + stages.outline.outputTokens, run.outputTokens);
});

test("ledger rows are idempotent: the same callId never double counts, a later row updates the earlier", () => {
  const a = row({ callId: "c1", status: "running" });
  const dup = dedupeLedger([a, { ...a, status: "ok" }, { ...a, status: "failed", error: { category: "validation" } }, a === a ? { ...a, callId: "c2" } : a]);
  assert.equal(dup.length, 2);
  assert.equal(dup.find((r) => r.callId === "c1").status, "failed");
  const text = JSON.stringify(a) + "\n" + JSON.stringify(a) + "\n{torn";
  assert.equal(parseLedger(text).length, 1);
  assert.equal(aggregate(parseLedger(text)).calls, 1);
});

// ---------- budget settings ----------

test("budget settings: empty means unrestricted, zero is a real zero, invalid is rejected, old files still load", () => {
  const b = (mut) => { const s = clone(DEFAULT_SETTINGS); mut(s.budgets); return validateSettings(s); };
  assert.deepEqual(validateSettings(DEFAULT_SETTINGS), []);
  assert.equal(DEFAULT_SETTINGS.budgets.run.maxCalls, null);
  assert.equal(DEFAULT_SETTINGS.budgets.stage.maxOutputTokens, null);
  const norm = normalizeSettings({ ...clone(DEFAULT_SETTINGS), budgets: { run: { maxCalls: "", maxInputTokens: 0, maxOutputTokens: undefined } } });
  assert.equal(norm.budgets.run.maxCalls, null);
  assert.equal(norm.budgets.run.maxInputTokens, 0);
  assert.equal(norm.budgets.run.maxOutputTokens, null);
  assert.deepEqual(validateSettings(norm), []);
  assert.ok(b((x) => (x.run.maxCalls = -1)).some((p) => /maxCalls/.test(p)));
  assert.ok(b((x) => (x.run.maxCalls = 1.5)).some((p) => /whole number/.test(p)));
  assert.ok(b((x) => (x.stage.maxEstimatedCost = "abc")).some((p) => /maxEstimatedCost/.test(p)));
  assert.ok(b((x) => (x.run.maxInputTokens = NaN)).some((p) => /maxInputTokens/.test(p)));
  assert.ok(b((x) => (x.warnings.usagePercent = 0)).some((p) => /warning threshold/.test(p)));
  assert.ok(b((x) => (x.unknownUsage = "maybe")).some((p) => /unknownUsage/.test(p)));
  // A settings file from before budgets existed: valid, unrestricted, repair default 1.
  const legacy = clone(DEFAULT_SETTINGS);
  delete legacy.budgets;
  delete legacy.providers.claude.models.repair;
  const r = resolveSettings(legacy);
  assert.equal(r.source, "file");
  assert.equal(r.settings.budgets.run.maxCalls, null);
  assert.equal(r.settings.budgets.repair.maxAttemptsPerOperation, 1);
  assert.equal(r.settings.providers.claude.models.repair.effort, "low");
});

// ---------- budget decisions (pure) ----------

const T = (o = {}) => aggregate(o.rows ?? []);
const B = (o = {}) => normalizeSettings({ ...clone(DEFAULT_SETTINGS), budgets: o }).budgets;
const decide = (budgets, rows = [], extra = {}) => decideCall({ budgets: B(budgets), stage: "research", scope: { run: aggregate(rows), stage: aggregate(rows.filter((r) => r.stage === "research")) }, ...extra });

test("empty or null budgets never block; an unconfigured call after many calls is still allowed", () => {
  const rows = Array.from({ length: 50 }, () => row({}));
  assert.equal(decide({}, rows).allow, true);
  assert.equal(decide({ run: { maxCalls: null, maxInputTokens: null } }, rows).allow, true);
});

test("a zero budget blocks the call; run and stage limits are independent", () => {
  assert.equal(decide({ run: { maxCalls: 0 } }).allow, false);
  assert.equal(decide({ run: { maxOutputTokens: 0 } }).allow, false);
  assert.equal(decide({ stage: { maxCalls: 0 } }).blocks[0].budget, "stage.maxCalls");
  const rows = [row({ stage: "outline" }), row({ stage: "outline" })];
  assert.equal(decide({ stage: { maxCalls: 2 } }, rows).allow, true, "the outline's calls don't count against research");
  assert.equal(decide({ run: { maxCalls: 2 } }, rows).allow, false, "but they count against the run");
});

test("call count includes failed and repair calls; overruns block the next call; warnings use the threshold", () => {
  const rows = [row({ status: "failed" }), row({ repair: true })];
  assert.equal(decide({ run: { maxCalls: 2 } }, rows).allow, false);
  assert.equal(decide({ run: { maxCalls: 3 } }, rows).allow, true);
  const over = [row({})]; // 37 output tokens
  const d = decide({ run: { maxOutputTokens: 30 } }, over);
  assert.equal(d.allow, false);
  assert.deepEqual([d.blocks[0].limit, d.blocks[0].used, d.blocks[0].stage], [30, 37, "research"]);
  const lim = limitStatus(B({ run: { maxOutputTokens: 40 }, warnings: { usagePercent: 80 } }), aggregate(over), aggregateByStage(over));
  assert.equal(lim[0].state, "warning");
  assert.equal(limitStatus(B({ run: { maxOutputTokens: 400 } }), aggregate(over), {})[0].state, "ok");
});

test("repair limits: attempts per operation and repair calls per run", () => {
  assert.equal(decide({ repair: { maxAttemptsPerOperation: 1 } }, [], { repair: { isRepair: true, operationAttempts: 1 } }).allow, false);
  assert.equal(decide({ repair: { maxAttemptsPerOperation: 2 } }, [], { repair: { isRepair: true, operationAttempts: 1 } }).allow, true);
  assert.equal(decide({ repair: { maxCallsPerRun: 2 } }, [], { repair: { isRepair: true, operationAttempts: 0, runRepairCalls: 2 } }).allow, false);
  assert.equal(decide({ repair: { maxCallsPerRun: 0 } }, [], { repair: { isRepair: false, runRepairCalls: 0 } }).allow, true, "only repair calls are limited");
});

test("unknown usage follows the policy: warn continues with a warning, block refuses", () => {
  const rows = [row({ usage: normalizeCliUsage({}) })];
  const warn = decide({ run: { maxOutputTokens: 1000 }, unknownUsage: "warn" }, rows);
  assert.equal(warn.allow, true);
  assert.equal(warn.warnings[0].kind, "unknown-usage");
  const block = decide({ run: { maxOutputTokens: 1000 }, unknownUsage: "block" }, rows);
  assert.equal(block.allow, false);
  assert.match(block.blocks[0].reason, /unknown/);
  assert.equal(decide({ unknownUsage: "block" }, rows).allow, true, "no limit configured, so nothing to verify");
});

test("cost limits are only enforced on cost the CLI reported", () => {
  assert.equal(decide({ run: { maxEstimatedCost: 0.01 } }, [row({})]).allow, false); // 0.0158 reported
  const noCost = decide({ run: { maxEstimatedCost: 0.01 }, unknownUsage: "warn" }, [row({ usage: normalizeCliUsage({ usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }) })]);
  assert.equal(noCost.allow, true);
  assert.equal(noCost.warnings.length, 1, "cost unknown: warned, not assumed zero");
});

// ---------- repair through aiJson ----------

const R = (v) => ({ result: JSON.stringify(v) });
const REPAIR_ROW = (rows) => rows.filter((r) => r.repair);

test("invalid JSON with a recoverable formatting defect is fixed locally: one call, no repair call", () => {
  const l = lab();
  const { results } = l.play([{ result: '```json\n{"a": "x", "b": 2,\n}\n```' }], { scenario: "json", check: "simple" });
  assert.deepEqual(results[0].value, { a: "x", b: 2 });
  assert.equal(l.calls().length, 1);
  assert.equal(l.rows().length, 1);
});

test("unrecoverable JSON gets one bounded reformat call that does not resend the original prompt", () => {
  const l = lab();
  const { results } = l.play([{ result: '{"a": "x", "b": ' }, R({ a: "x", b: 2 })], { scenario: "json", check: "simple", prompt: "ORIGINAL ".repeat(500) });
  assert.equal(results[0].ok, true);
  const calls = l.calls();
  assert.equal(calls.length, 2);
  assert.ok(calls[1].chars < calls[0].chars / 3, "the reformat call is small");
  const rows = l.rows();
  assert.deepEqual(rows.map((r) => [r.kind, r.status]), [["generation", "failed"], ["repair-json", "ok"]]);
  assert.equal(rows[0].error.category, "json-parse");
});

test("repair is bounded: a reply that stays unparseable fails after the limit, with every attempt recorded", () => {
  const l = lab();
  const { results } = l.play([{ result: "not json" }], { scenario: "json", check: "simple" });
  assert.equal(results[0].ok, false);
  assert.equal(results[0].kind, "external");
  assert.equal(l.calls().length, 2);
  assert.equal(l.rows().length, 2);
  assert.ok(l.rows().every((r) => r.status === "failed"));
});

function brokenDossier(mutate) {
  const d = validDossier();
  mutate(d);
  return d;
}

test("research: one invalid field is repaired with a field patch; nothing else is regenerated or re-searched", () => {
  const l = lab();
  const bad = brokenDossier((d) => (d.claims[2].sources[0].url = "not-a-url"));
  assert.ok(validateResearch(bad).length === 1);
  const fixedClaim = { ...bad.claims[2], sources: [{ ...bad.claims[2].sources[0], url: "https://example.org/fixed" }] };
  const { results } = l.play([R(bad), R({ patch: { "claims[2]": fixedClaim } })], { scenario: "json", check: "research", fieldRepair: true, resend: false, tools: ["WebSearch"], prompt: "RESEARCH BRIEF ".repeat(2000) });
  assert.equal(results[0].ok, true, results[0].message);
  const out = results[0].value;
  assert.deepEqual(validateResearch(out), []);
  // Everything that was valid is byte-identical: claims, citations, sources, provenance.
  const orig = validDossier();
  for (const i of [0, 1, 3, 4, 5, 6, 7]) assert.deepEqual(out.claims[i], orig.claims[i]);
  assert.deepEqual({ ...out, claims: null }, { ...orig, claims: null });
  assert.equal(out.claims[2].sources[0].url, "https://example.org/fixed");
  assert.equal(out.claims[2].sources[0].passage, orig.claims[2].sources[0].passage);
  // Cost: the repair call is tiny, carries no original prompt and no web tools.
  const calls = l.calls();
  assert.equal(calls.length, 2);
  assert.ok(calls[1].chars < calls[0].chars / 4 || calls[1].chars < 4000, `repair prompt ${calls[1].chars} chars`);
  assert.ok(!calls[1].head.includes("RESEARCH BRIEF"));
  assert.ok(calls[0].args.includes("--allowedTools") && !calls[1].args.includes("--allowedTools"));
  const rows = l.rows();
  assert.deepEqual(rows.map((r) => [r.kind, r.repair, r.status]), [["generation", false, "failed"], ["repair-fields", true, "ok"]]);
  assert.equal(rows[0].error.category, "validation");
  assert.match(rows[1].reason, /claims\[2\]/);
  assert.equal(rows[1].step, "repair");
});

test("research: a patch that omits fields of the repaired element keeps the original ones", () => {
  const l = lab();
  const bad = brokenDossier((d) => (d.claims[1].sources[0].url = "nope"));
  const { results } = l.play([R(bad), R({ patch: { "claims[1]": { sources: [{ ...bad.claims[1].sources[0], url: "https://example.org/ok" }] } } })], { scenario: "json", check: "research", fieldRepair: true });
  assert.equal(results[0].ok, true, results[0].message);
  assert.equal(results[0].value.claims[1].text, validDossier().claims[1].text);
  assert.equal(results[0].value.claims[1].id, "c2");
});

test("research: several invalid fields are repaired in one patch", () => {
  const l = lab();
  const bad = brokenDossier((d) => { d.audience = ""; d.claims[0].sources[0].url = "x"; d.claims[4].status = "bogus"; });
  assert.equal(validateResearch(bad).length, 3);
  const orig = validDossier();
  const { results } = l.play([R(bad), R({ patch: { audience: "curious people", "claims[0]": orig.claims[0], "claims[4]": orig.claims[4] } })], { scenario: "json", check: "research", fieldRepair: true });
  assert.equal(results[0].ok, true, results[0].message);
  assert.deepEqual(results[0].value, orig);
  assert.equal(l.calls().length, 2);
  assert.match(l.rows()[1].reason, /3 failing field/);
});

test("a repair the full validator rejects is never accepted; attempts are exhausted and recorded", () => {
  const l = lab();
  const bad = brokenDossier((d) => (d.claims[2].sources[0].url = "not-a-url"));
  const { results } = l.play([R(bad), R({ patch: { "claims[2]": bad.claims[2] } })], { scenario: "json", check: "research", fieldRepair: true });
  assert.equal(results[0].ok, false);
  assert.equal(results[0].kind, "invalid");
  const rows = l.rows();
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.status === "failed"));
  assert.equal(rows[1].error.category, "validation");
});

test("a patch touching fields that were not requested, or changing an id, is rejected", () => {
  const bad = brokenDossier((d) => (d.claims[2].sources[0].url = "not-a-url"));
  for (const patch of [{ "claims[2]": validDossier().claims[2], audience: "hijacked" }, { "claims[2]": { ...validDossier().claims[2], id: "c99" } }]) {
    const l = lab();
    const { results } = l.play([R(bad), R({ patch })], { scenario: "json", check: "research", fieldRepair: true });
    assert.equal(results[0].ok, false);
    assert.equal(l.rows()[1].error.category, "repair-rejected");
  }
});

test("with a second attempt allowed, a rejected patch falls back to a bounded full-object repair, with the reason on record", () => {
  const l = lab();
  const bad = brokenDossier((d) => (d.claims[2].sources[0].url = "not-a-url"));
  const { results } = l.play([R(bad), R({ patch: { audience: "x" } }), R(validDossier())], { scenario: "json", check: "research", fieldRepair: true, resend: false, tools: ["WebSearch"], prompt: "RESEARCH BRIEF ".repeat(500), budgets: { repair: { maxAttemptsPerOperation: 2 } } });
  assert.equal(results[0].ok, true, results[0].message);
  const rows = l.rows();
  assert.deepEqual(rows.map((r) => r.kind), ["generation", "repair-fields", "repair-full"]);
  assert.match(rows[2].reason, /field repair already tried/);
  const calls = l.calls();
  assert.ok(!calls[2].head.includes("RESEARCH BRIEF"), "the research prompt is not resent");
  assert.ok(!calls[2].args.includes("--allowedTools"), "no web tools in a repair");
});

test("a problem that can't be attributed to one field goes straight to a full-object repair, with the reason", () => {
  const l = lab();
  const bad = brokenDossier((d) => (d.claims = d.claims.slice(0, 3)));
  const problems = validateResearch(bad);
  assert.ok(problems.some((p) => /at least 5/.test(p)));
  const { results } = l.play([R(bad), R(validDossier())], { scenario: "json", check: "research", fieldRepair: true, resend: false });
  const rows = l.rows();
  assert.equal(rows[1].kind, "repair-full");
  assert.match(rows[1].reason, /not attributable|% of the object/);
  assert.equal(results[0].ok, true);
});

test("callers that don't opt in to field repair get the (single, bounded) full-object repair", () => {
  const l = lab();
  const { results } = l.play([R({ a: 1 }), R({ a: "x", b: 2 })], { scenario: "json", check: "simple", prompt: "BRIEF" });
  assert.equal(results[0].ok, true);
  const rows = l.rows();
  assert.equal(rows[1].kind, "repair-full");
  assert.match(rows[1].reason, /not independent/);
  assert.ok(l.calls()[1].head.startsWith("BRIEF"), "this caller's repair keeps its original prompt");
});

test("maxAttemptsPerOperation = 0 disables repair: invalid output fails immediately", () => {
  const l = lab();
  const { results } = l.play([R({ a: 1 }), R({ a: "x", b: 2 })], { scenario: "json", check: "simple", budgets: { repair: { maxAttemptsPerOperation: 0 } } });
  assert.equal(results[0].ok, false);
  assert.equal(l.calls().length, 1);
});

test("the repair step uses its own model/effort setting; the generation keeps its step", () => {
  const l = lab();
  l.play([R({ a: 1 }), R({ a: "x", b: 2 })], { scenario: "json", check: "simple", step: "script" });
  const [gen, rep] = l.rows();
  assert.equal(gen.step, "script");
  assert.equal(rep.step, "repair");
  assert.equal(gen.effort, "high");
  assert.equal(rep.effort, "low");
});

// ---------- usage capture ----------

test("usage is recorded for successful, failed and usage-less calls; the response text is unchanged", () => {
  const l = lab();
  const { results } = l.play([R({ a: "x", b: 1 })], { scenario: "json", check: "simple" });
  assert.deepEqual(results[0].value, { a: "x", b: 1 });
  const [r] = l.rows();
  assert.equal(r.usage.status, "known");
  assert.equal(r.usage.totalInputTokens, 160);
  assert.equal(r.usage.outputTokens, 20);
  assert.ok(r.model === "claude-sonnet-fake" && r.requestedModel === "sonnet" && r.exitCode === 0);
  assert.ok(!JSON.stringify(r).includes("PROMPT"), "no prompt text in the ledger");
});

test("a failed CLI process still records the usage the CLI reported", () => {
  const l = lab();
  const { results } = l.play([{ stdout: JSON.stringify({ is_error: true, result: "boom", usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }), exit: 1 }], { scenario: "texts", sequence: [{ stage: "outline" }] });
  assert.equal(results[0].ok, false);
  const rows = l.rows();
  assert.equal(rows.length, 2, "the transient failure is retried once, as its own row");
  assert.equal(rows[0].status, "failed");
  assert.equal(rows[0].usage.status, "known");
  assert.equal(rows[0].usage.inputTokens, 5);
  assert.equal(rows[0].error.category, "process");
  assert.equal(rows[1].kind, "retry");
});

test("a call with no usage metadata is 'unknown', not zero", () => {
  const l = lab();
  l.play([{ result: "hi", usage: null }], { scenario: "texts", sequence: [{ stage: "outline" }] });
  const [r] = l.rows();
  assert.equal(r.usage.status, "unknown");
  assert.equal(r.usage.outputTokens, null);
  assert.equal(aggregate(l.rows()).outputTokens, null);
});

// ---------- budget enforcement through real calls ----------

test("a hard budget stops the pipeline before the next call is launched", () => {
  const l = lab();
  const { results } = l.play([{ result: "hi" }], { scenario: "texts", sequence: [{ stage: "outline" }, { stage: "outline" }, { stage: "script" }], budgets: { run: { maxCalls: 1 } } });
  assert.deepEqual(results.map((r) => r.ok), [true, false, false]);
  assert.equal(results[1].kind, "budget");
  assert.equal(results[1].name, "BudgetExceededError");
  assert.equal(results[1].blocks[0].budget, "run.maxCalls");
  assert.equal(results[1].blocks[0].stage, "outline");
  assert.equal(l.calls().length, 1, "the blocked calls never started the CLI");
  const rows = l.rows();
  assert.equal(rows.filter((r) => r.status === "blocked").length, 2);
  assert.equal(aggregate(rows).calls, 1);
});

test("a zero budget blocks the very first call", () => {
  const l = lab();
  const { results } = l.play([{ result: "hi" }], { scenario: "texts", sequence: [{ stage: "research" }], budgets: { run: { maxCalls: 0 } } });
  assert.equal(results[0].kind, "budget");
  assert.equal(l.calls().length, 0);
});

test("stage budgets are per stage: other stages keep going", () => {
  const l = lab();
  const { results } = l.play([{ result: "hi" }], { scenario: "texts", sequence: [{ stage: "outline" }, { stage: "outline" }, { stage: "script" }], budgets: { stage: { maxCalls: 1 } } });
  assert.deepEqual(results.map((r) => r.ok), [true, false, true]);
});

test("actual usage over a token budget blocks the NEXT call (one call may overshoot)", () => {
  const l = lab();
  const { results } = l.play([{ result: "hi" }], { scenario: "texts", sequence: [{ stage: "outline" }, { stage: "outline" }], budgets: { run: { maxOutputTokens: 15 } } }); // each call reports 20
  assert.deepEqual(results.map((r) => r.ok), [true, false]);
  assert.equal(results[1].blocks[0].used, 20);
});

test("unknown usage: warn continues, block stops", () => {
  for (const [policy, expected] of [["warn", [true, true]], ["block", [true, false]]]) {
    const l = lab();
    const { results } = l.play([{ result: "hi", usage: null }], { scenario: "texts", sequence: [{ stage: "outline" }, { stage: "outline" }], budgets: { run: { maxOutputTokens: 1000 }, unknownUsage: policy } });
    assert.deepEqual(results.map((r) => r.ok), expected, policy);
  }
});

test("concurrent calls reserve atomically: they can't all spend the same remaining allowance", () => {
  const l = lab();
  const { results } = l.play([{ result: "hi", delayMs: 300 }], { scenario: "concurrent", n: 6, budgets: { run: { maxCalls: 2 } } });
  assert.equal(results.filter((r) => r.ok).length, 2);
  assert.equal(results.filter((r) => r.kind === "budget").length, 4);
  assert.equal(l.calls().length, 2);
  // With a token budget the remainder is unknowable until a call returns, so only one runs at a time.
  const l2 = lab();
  const r2 = l2.play([{ result: "hi", delayMs: 300 }], { scenario: "concurrent", n: 4, budgets: { run: { maxOutputTokens: 1000 } } });
  assert.equal(r2.results.filter((r) => r.ok).length, 1);
  assert.match(r2.results.find((r) => !r.ok).blocks[0].reason, /in progress/);
});

test("resume restores usage from the ledger and does not reset counters or double count", () => {
  const l = lab();
  const h = { scenario: "texts", sequence: [{ stage: "outline" }], runId: "run-1", budgets: { run: { maxCalls: 2 } } };
  assert.equal(l.play([{ result: "hi" }], h).results[0].ok, true);
  assert.equal(l.play([{ result: "hi" }], h).results[0].ok, true); // a second process, same run
  assert.equal(l.play([{ result: "hi" }], h).results[0].kind, "budget"); // restored: 2 of 2 used
  assert.equal(aggregate(l.rows()).calls, 2);
  // Raising the limit lets the same run continue; a new run starts with new counters.
  assert.equal(l.play([{ result: "hi" }], { ...h, budgets: { run: { maxCalls: 3 } } }).results[0].ok, true);
  assert.equal(l.play([{ result: "hi" }], { ...h, runId: "run-2" }).results[0].ok, true);
  assert.equal(aggregate(l.rows().filter((r) => r.runId === "run-2")).calls, 1);
});
