// Per-step model and effort: defaults, validation, precedence, and the Opus ban.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { DEFAULT_SETTINGS, MODEL_STEPS, normalizeSettings, resolveSettings, validateSettings } from "../src/schema/settings.mjs";

const tsx = (code, env = {}) => {
  const r = spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "-e", code], { encoding: "utf8", env: { ...process.env, PIPELINE_SETTINGS: "", CLAUDE_MODEL: "", CLAUDE_EFFORT: "", ...env } });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split("\n").pop());
};
const resolve = (opts, env) => tsx(`import { resolveModel } from "./scripts/ai"; try { console.log(JSON.stringify(resolveModel(${JSON.stringify(opts)}))); } catch (e) { console.log(JSON.stringify({ error: (e as Error).message })); }`, env);

test("defaults cover every step, are valid, and never use Opus", () => {
  assert.deepEqual(validateSettings(DEFAULT_SETTINGS), []);
  for (const st of MODEL_STEPS) assert.ok(DEFAULT_SETTINGS.providers.claude.models[st.id], st.id);
  assert.ok(Object.values(DEFAULT_SETTINGS.providers.claude.models).every((m) => !/opus/.test(m.model)));
});

test("an old settings file without models still resolves, with default provider models", () => {
  const r = resolveSettings({ formats: DEFAULT_SETTINGS.formats, narration: DEFAULT_SETTINGS.narration });
  assert.equal(r.source, "file+defaults");
  assert.deepEqual(r.settings.providers.claude.models, DEFAULT_SETTINGS.providers.claude.models);
});

test("partial models merge over defaults; invalid ones are rejected, never clamped", () => {
  const n = normalizeSettings({ ...DEFAULT_SETTINGS, providers: undefined, models: { direct: { model: "haiku" } } });
  assert.deepEqual(n.providers.claude.models.direct, { model: "haiku", effort: "low" });
  assert.deepEqual(n.providers.claude.models.script, DEFAULT_SETTINGS.providers.claude.models.script);
  const old = { formats: DEFAULT_SETTINGS.formats, narration: DEFAULT_SETTINGS.narration };
  assert.match(validateSettings(normalizeSettings({ ...old, models: { script: { model: "opus", effort: "high" } } })).join(), /Opus is not allowed/);
  assert.match(validateSettings(normalizeSettings({ ...old, models: { script: { model: "sonnet", effort: "ultra" } } })).join(), /effort must be/);
  assert.deepEqual(validateSettings(normalizeSettings({ ...old, models: { script: { model: "claude-sonnet-5-5", effort: "max" } } })), []);
});

test("precedence: call override > step env > global env > settings > default", () => {
  const snapSettings = { ...DEFAULT_SETTINGS, providers: { ...DEFAULT_SETTINGS.providers, claude: { models: { direct: { model: "haiku", effort: "medium" } } } } };
  const snap = JSON.stringify({ settings: normalizeSettings(snapSettings) });
  assert.deepEqual(resolve({ step: "direct" }, { PIPELINE_SETTINGS: snap }), { model: "haiku", effort: "medium" });
  assert.deepEqual(resolve({ step: "direct" }, { PIPELINE_SETTINGS: snap, CLAUDE_EFFORT: "low" }), { model: "haiku", effort: "low" });
  assert.deepEqual(resolve({ step: "direct" }, { PIPELINE_SETTINGS: snap, CLAUDE_MODEL: "sonnet", CLAUDE_MODEL_DIRECT: "haiku", CLAUDE_EFFORT_DIRECT: "high" }), { model: "haiku", effort: "high" });
  assert.deepEqual(resolve({ step: "direct", model: "sonnet", effort: "max" }, { PIPELINE_SETTINGS: snap }), { model: "sonnet", effort: "max" });
  assert.deepEqual(resolve({}, {}), { model: "sonnet", effort: "medium" });
});

test("Opus and bad effort are refused from any source", () => {
  assert.match(resolve({ step: "script" }, { CLAUDE_MODEL: "opus" }).error, /not allowed/);
  assert.match(resolve({ step: "script" }, { CLAUDE_MODEL_SCRIPT: "claude-opus-5-5" }).error, /not allowed/);
  assert.match(resolve({ step: "script" }, { CLAUDE_EFFORT: "turbo" }).error, /not valid/);
});

test("ChatGPT model resolution does not read Claude-only environment variables", () => {
  const configured = structuredClone(DEFAULT_SETTINGS);
  configured.provider = "chatgpt";
  for (const model of Object.values(configured.providers.chatgpt.models)) model.model = "account-listed-model";
  const snapshot = JSON.stringify({ settings: configured });
  const source = `import { resolveModel } from "./scripts/ai"; const env = new Proxy({ PIPELINE_SETTINGS: ${JSON.stringify(snapshot)} }, { get(t, k) { if (String(k).startsWith("CLAUDE_") || String(k).startsWith("ANTHROPIC_")) throw new Error("read provider-isolated environment variable: " + String(k)); return Reflect.get(t, k); } }); try { console.log(JSON.stringify(resolveModel({ step: "direct" }, env))); } catch (e) { console.log(JSON.stringify({ error: e.message })); }`;
  assert.deepEqual(tsx(source), { model: "account-listed-model", effort: "medium" });
});

test("provider and model changes enter editorial cache keys", () => {
  const claude = structuredClone(DEFAULT_SETTINGS);
  const chatgpt = structuredClone(DEFAULT_SETTINGS);
  chatgpt.provider = "chatgpt";
  for (const model of Object.values(chatgpt.providers.chatgpt.models)) model.model = "account-listed-model";
  const source = `import { researchInputHash, effectiveModelKey } from "./scripts/stages/editorial"; const a = ${JSON.stringify(claude)}; const b = ${JSON.stringify(chatgpt)}; console.log(JSON.stringify({ claude: researchInputHash("topic", undefined, a), chatgpt: researchInputHash("topic", undefined, b), models: effectiveModelKey(b, "research") }));`;
  const result = tsx(source);
  assert.notEqual(result.claude, result.chatgpt);
  assert.deepEqual(result.models.research, { provider: "chatgpt", model: "account-listed-model", effort: "medium" });
});
