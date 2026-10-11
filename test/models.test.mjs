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
const resolve = (opts, env) => tsx(`import { resolveModel } from "./scripts/claude"; try { console.log(JSON.stringify(resolveModel(${JSON.stringify(opts)}))); } catch (e) { console.log(JSON.stringify({ error: (e as Error).message })); }`, env);

test("defaults cover every step, are valid, and never use Opus", () => {
  assert.deepEqual(validateSettings(DEFAULT_SETTINGS), []);
  for (const st of MODEL_STEPS) assert.ok(DEFAULT_SETTINGS.models[st.id], st.id);
  assert.ok(Object.values(DEFAULT_SETTINGS.models).every((m) => !/opus/.test(m.model)));
});

test("an old settings file without models still resolves, with default models", () => {
  const r = resolveSettings({ formats: DEFAULT_SETTINGS.formats, narration: DEFAULT_SETTINGS.narration });
  assert.equal(r.source, "file");
  assert.deepEqual(r.settings.models, DEFAULT_SETTINGS.models);
});

test("partial models merge over defaults; invalid ones are rejected, never clamped", () => {
  const n = normalizeSettings({ ...DEFAULT_SETTINGS, models: { direct: { model: "haiku" } } });
  assert.deepEqual(n.models.direct, { model: "haiku", effort: "low" });
  assert.deepEqual(n.models.script, DEFAULT_SETTINGS.models.script);
  assert.match(validateSettings(normalizeSettings({ models: { script: { model: "opus", effort: "high" } }, formats: DEFAULT_SETTINGS.formats, narration: DEFAULT_SETTINGS.narration })).join(), /Opus is not allowed/);
  assert.match(validateSettings(normalizeSettings({ models: { script: { model: "sonnet", effort: "ultra" } }, formats: DEFAULT_SETTINGS.formats, narration: DEFAULT_SETTINGS.narration })).join(), /effort must be/);
  assert.deepEqual(validateSettings(normalizeSettings({ models: { script: { model: "claude-sonnet-5-5", effort: "max" } }, formats: DEFAULT_SETTINGS.formats, narration: DEFAULT_SETTINGS.narration })), []);
});

test("precedence: call override > step env > global env > settings > default", () => {
  const snap = JSON.stringify({ settings: normalizeSettings({ ...DEFAULT_SETTINGS, models: { direct: { model: "haiku", effort: "medium" } } }) });
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
