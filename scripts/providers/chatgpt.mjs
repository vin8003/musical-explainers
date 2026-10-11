import { readFile } from "node:fs/promises";
import { getChatGPTAccessToken, markChatGPTReauthenticationRequired } from "./chatgpt-auth.mjs";

export async function listChatGPTModels(fetcher = fetch) {
  const token = await getChatGPTAccessToken();
  const response = await fetcher("https://api.openai.com/v1/models", { headers: { authorization: `Bearer ${token}` } });
  const body = await response.json().catch(() => ({}));
  if (response.status === 401) await markChatGPTReauthenticationRequired();
  if (!response.ok) throw new Error(`Could not load ChatGPT plan models (${body.error?.code ?? response.status}).`);
  return (body.models ?? []).filter((m) => m.visibility === "list" && typeof m.slug === "string").map((m) => ({ id: m.slug, name: m.display_name ?? m.slug, reasoningEfforts: m.reasoning_efforts ?? null }));
}

/** Official Responses API adapter. Uses the user's SIWC OAuth bearer token only. */
export async function chatGPTResponse(prompt, options, model, fetcher = fetch) {
  return chatGPTResponseWithToken(prompt, options, model, await getChatGPTAccessToken(), fetcher);
}

/** Transport seam for integration tests; application calls use the token-backed wrapper above. */
export async function chatGPTResponseWithToken(prompt, options, model, token, fetcher = fetch) {
  const inputContent = [{ type: "input_text", text: prompt }];
  for (const path of options.imagePaths ?? []) {
    const bytes = await readFile(path);
    const mime = path.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
    inputContent.push({ type: "input_image", image_url: `data:${mime};base64,${bytes.toString("base64")}` });
  }
  const body = {
    model,
    input: [{ role: "user", content: inputContent }],
    store: false,
    stream: true,
    text: { format: { type: "json_object" } },
    ...(options.effort ? { reasoning: { effort: options.effort } } : {}),
  };
  if ((options.allowedTools ?? []).some((t) => t === "WebSearch" || t === "WebFetch")) body.tools = [{ type: "web_search" }];
  const response = await fetcher("https://api.openai.com/v1/responses", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(options.timeoutMs ?? 15 * 60_000),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    const info = err.error ?? err;
    const code = info.code ?? info.type ?? response.status;
    const usageLimit = ["subscription_sharing_usage_limit_exceeded", "subscription_sharing_usage_unavailable"].includes(code);
    const detail = typeof info.message === "string" ? info.message : typeof info.detail === "string" ? info.detail : "";
    const param = typeof info.param === "string" ? `; parameter: ${info.param}` : "";
    const requestId = response.headers.get("x-request-id");
    const diagnostic = `${code}${param}${requestId ? `; request: ${requestId}` : ""}${detail ? `: ${detail.slice(0, 180)}` : ""}`;
    const e = new Error(usageLimit ? "ChatGPT plan usage limit reached. Review Manage usage in ChatGPT Settings before trying again." : `ChatGPT Responses request failed (${diagnostic}).`);
    e.category = usageLimit ? "usage-limit" : response.status === 401 ? "auth-expired" : response.status === 404 ? "unsupported-model" : response.status === 400 || response.status === 403 ? "request-invalid" : response.status === 429 ? "rate-limit" : "provider";
    e.usage = null;
    throw e;
  }
  if (!response.body) throw Object.assign(new Error("ChatGPT returned no response stream."), { category: "stream" });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", output = "", completed = null, failure = null, failureUsage = null;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() ?? "";
    for (const block of events) {
      const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
      if (!data || data === "[DONE]") continue;
      let event;
      try { event = JSON.parse(data); } catch { continue; }
      if (event.type === "response.output_text.delta") output += event.delta ?? "";
      if (event.type === "response.completed") completed = event.response;
      if (["response.failed", "response.incomplete", "error"].includes(event.type)) {
        failure = event.response?.error ?? event.error ?? { code: event.type };
        failure.event = event.type;
        failure.responseId = event.response?.id ?? null;
        failureUsage = event.response?.usage ?? null;
      }
    }
  }
  if (failure) {
    const code = failure.code ?? "unknown_error";
    const limit = ["subscription_sharing_usage_limit_exceeded", "subscription_sharing_usage_unavailable"].includes(code);
    const detail = typeof failure.message === "string" ? `: ${failure.message.slice(0, 300)}` : "";
    const param = typeof failure.param === "string" ? `; parameter: ${failure.param}` : "";
    const responseId = failure.responseId ? ` [response ${failure.responseId}]` : "";
    const requestId = response.headers.get("x-request-id");
    const invalidRequest = code === "invalid_request_error" || code === "subscription_sharing_unsupported_capability";
    throw Object.assign(new Error(limit ? "ChatGPT plan usage limit reached. Review Manage usage in ChatGPT Settings before trying again." : `ChatGPT response ${failure.event ?? "failed"} (${code}${param}${requestId ? `; request: ${requestId}` : ""})${detail}${responseId}.`), { category: limit ? "usage-limit" : invalidRequest ? "request-invalid" : "provider", usage: completed?.usage ?? failureUsage });
  }
  if (!completed) throw Object.assign(new Error("ChatGPT stream ended without response.completed."), { category: "stream", usage: null });
  if (!output.trim()) throw Object.assign(new Error("ChatGPT completed the request without text output."), { category: "empty", usage: completed.usage ?? null });
  return { text: output, usage: completed.usage ?? null, model: completed.model ?? model };
}
