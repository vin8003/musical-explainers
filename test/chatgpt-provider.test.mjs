import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chatGPTResponseWithToken } from "../scripts/providers/chatgpt.mjs";
import { DEFAULT_SETTINGS, normalizeSettings, resolveSettings, validateSettings } from "../src/schema/settings.mjs";
import { budgetsForProvider } from "../src/schema/usage.mjs";

const sse = (...events) => new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });

test("ChatGPT Responses adapter uses the OAuth bearer, streams to completion, and translates supported options", async () => {
  let request;
  const result = await chatGPTResponseWithToken("Return one JSON object", { allowedTools: ["WebSearch", "Read"], effort: "high" }, "eligible-model", "oauth-access-token", async (url, init) => {
    request = { url, init, body: JSON.parse(init.body) };
    return sse(
      { type: "response.output_text.delta", delta: "{\"ok\":" },
      { type: "response.output_text.delta", delta: "true}" },
      { type: "response.completed", response: { model: "eligible-model", usage: { input_tokens: 10, output_tokens: 3 } } },
    );
  });
  assert.equal(request.url, "https://api.openai.com/v1/responses");
  assert.equal(request.init.headers.authorization, "Bearer oauth-access-token");
  assert.equal(request.body.model, "eligible-model");
  assert.equal(request.body.store, false);
  assert.equal(request.body.stream, true);
  assert.deepEqual(request.body.reasoning, { effort: "high" });
  assert.deepEqual(request.body.tools, [{ type: "web_search" }]);
  assert.deepEqual(request.body.text, { format: { type: "json_object" } });
  assert.equal("temperature" in request.body, false);
  assert.equal("allowedTools" in request.body, false);
  assert.equal(result.text, "{\"ok\":true}");
  assert.deepEqual(result.usage, { input_tokens: 10, output_tokens: 3 });
});

test("ChatGPT plan exhaustion is a hard-stop class and is not translated to a Claude fallback", async () => {
  await assert.rejects(
    chatGPTResponseWithToken("prompt", {}, "eligible-model", "oauth-access-token", async () => sse({
      type: "response.failed",
      response: { error: { code: "subscription_sharing_usage_limit_exceeded" }, usage: { input_tokens: 4, output_tokens: 1 } },
    })),
    (error) => error.category === "usage-limit" && /ChatGPT plan usage limit reached/.test(error.message) && error.usage.input_tokens === 4,
  );
});

test("ChatGPT auth status distinguishes disconnected, consent-required, reauth and connected without exposing tokens", () => {
  const data = mkdtempSync(join(tmpdir(), "me-chatgpt-auth-"));
  const source = `
    import { createHash } from "node:crypto";
    import { resolve } from "node:path";
    import keytar from "keytar";
    import { connectionStatus } from "./scripts/providers/chatgpt-auth.mjs";
    const service = "musical-explainers:chatgpt-plan:" + createHash("sha256").update(resolve(process.env.DATA_ROOT)).digest("hex").slice(0, 16);
    const account = "primary";
    const read = async () => {
      const status = await connectionStatus();
      if (Object.hasOwn(status, "access_token") || Object.hasOwn(status, "refresh_token")) throw new Error("status exposed a token");
      return status.status;
    };
    if (await read() !== "disconnected") throw new Error("expected disconnected");
    await keytar.setPassword(service, account, JSON.stringify({ scopes: ["openid"], email: "person@example.test" }));
    if (await read() !== "consent_required") throw new Error("expected consent_required");
    await keytar.setPassword(service, account, JSON.stringify({ scopes: ["chatgpt.tokens.use.direct"], refresh_token: "secret", reauth_required: true }));
    if (await read() !== "reauth_required") throw new Error("expected reauth_required");
    await keytar.setPassword(service, account, JSON.stringify({ scopes: ["chatgpt.tokens.use.direct"], refresh_token: "secret" }));
    if (await read() !== "connected") throw new Error("expected connected");
    await keytar.deletePassword(service, account);
  `;
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, DATA_ROOT: data } });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally { rmSync(data, { recursive: true, force: true }); }
});

test("provider settings migrate old model rows to Claude and keep each provider's choices independently", () => {
  const legacy = { formats: DEFAULT_SETTINGS.formats, narration: DEFAULT_SETTINGS.narration, models: { research: { model: "haiku", effort: "low" } } };
  const migrated = resolveSettings(legacy).settings;
  assert.equal(migrated.provider, "claude");
  assert.deepEqual(migrated.providers.claude.models.research, { model: "haiku", effort: "low" });
  assert.deepEqual(migrated.providers.chatgpt.models.research, { model: "", effort: "medium" });
  const changed = normalizeSettings({ ...migrated, provider: "chatgpt", providers: {
    claude: { models: { research: { model: "sonnet", effort: "high" } } },
    chatgpt: { models: { research: { model: "account-listed-model", effort: "high" } } },
  } });
  assert.equal(changed.providers.claude.models.research.model, "sonnet");
  assert.equal(changed.providers.chatgpt.models.research.model, "account-listed-model");
  assert.ok(validateSettings({ ...changed, provider: "unsupported" }).some((problem) => /provider must be/.test(problem)));
  assert.ok(validateSettings(changed).some((problem) => /choose an available ChatGPT plan model/.test(problem)), "all ChatGPT stages must have an explicit model before a run");
});

test("ChatGPT subscription usage does not inherit a monetary cost budget", () => {
  const budgets = { run: { maxCalls: 7, maxEstimatedCost: 1 }, stage: { maxInputTokens: 100, maxEstimatedCost: 0.5 } };
  assert.deepEqual(budgetsForProvider(budgets, "chatgpt"), { run: { maxCalls: 7, maxEstimatedCost: null }, stage: { maxInputTokens: 100, maxEstimatedCost: null } });
  assert.equal(budgetsForProvider(budgets, "claude"), budgets);
});
