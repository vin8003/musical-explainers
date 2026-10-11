// Shared provider request, validation and bounded repair runtime. Claude uses its local CLI;
// ChatGPT uses Sign in with ChatGPT subscription-backed inference.
// Bounded: a timeout per call, at most one retry on transient errors, and no
// retry at all when the subscription's usage limit is hit.
import { spawn } from "node:child_process";
import { PipelineError } from "./core/files";
import { runSettings } from "./core/settings";
import { applyPatch, extractPatch, fieldRepairPrompt, localRepairJson, planFieldRepair } from "./core/repair";
import { amendCall, finishCall, getUsageContext, reserveCall } from "./core/usage";
import type { Reservation, UsageRecord } from "./core/usage";
import { normalizeCliUsage, unknownUsage } from "../src/schema/usage.mjs";
import type { Usage } from "../src/schema/usage.mjs";
import { MAX_REPAIR_ATTEMPTS_HARD } from "../src/schema/settings.mjs";
import { randomUUID } from "node:crypto";
import { isAllowedModel, EFFORT_LEVELS } from "../src/schema/settings.mjs";
import type { ModelChoice, ModelStepId } from "../src/schema/settings.mjs";
import { chatGPTResponse, listChatGPTModels } from "./providers/chatgpt.mjs";
import { markChatGPTReauthenticationRequired } from "./providers/chatgpt-auth.mjs";

export type ProviderOptions = {
  /** e.g. ["WebSearch", "WebFetch"] for the fact-check stage, ["Read"] for visual review. */
  allowedTools?: string[];
  /** Which pipeline step this call is; picks its model and effort from the job's settings. */
  step?: ModelStepId;
  /** Explicit override for this one call; beats the step's setting. */
  model?: string;
  effort?: string;
  /** Milliseconds before the call is abandoned (default 15 min, CLAUDE_TIMEOUT_MS). */
  timeoutMs?: number;
  label?: string;
  /** How this call is classified in the usage ledger (default "generation"). */
  callKind?: "generation" | "regeneration";
  /** Why, when a call deliberately repeats a large prompt (e.g. "length miss"). Recorded in the ledger. */
  reason?: string;
  /** Images are only encoded and sent by providers/models that support vision. */
  imagePaths?: string[];
};

/** Extra options for aiJson. */
export type JsonOptions<T> = ProviderOptions & {
  /** Problems with the parsed value (empty = valid). Always re-run on the whole object after a repair. */
  check?: (v: T) => string[];
  /**
   * Allow repairing only the failing fields (the schema's fields are independent
   * and the validator names them). Off by default: a caller opts in after
   * checking its validator. `context` adds compact reference data to the prompt.
   */
  fieldRepair?: boolean | { context?: (v: T) => string; hint?: string };
  /**
   * Full-object repair resends the original prompt (default). Set false for
   * prompts that are large or use tools (research): the repair then sends
   * only the previous object and the problems, with no tools.
   */
  repairResendsPrompt?: boolean;
};

function cleanEnv() {
  // A set API key can make the CLI bill the API instead of the subscription.
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  // When launched from inside another Claude Code session, drop its session
  // variables so this run uses your own CLI login.
  for (const key of Object.keys(env)) {
    if (key.startsWith("CLAUDE_CODE_") || key.startsWith("CLAUDE_AGENT_") || key === "CLAUDECODE" || key === "ANTHROPIC_BASE_URL") delete env[key];
  }
  return env;
}

let snapshot: ReturnType<typeof runSettings> | undefined;

/**
 * Model and effort for one call, most specific first:
 *   1. the call's own override (opts.model / opts.effort)
 *   2. CLAUDE_MODEL_<STEP> / CLAUDE_EFFORT_<STEP> (e.g. CLAUDE_MODEL_DIRECT=haiku)
 *   3. CLAUDE_MODEL / CLAUDE_EFFORT, for the whole run
 *   4. the step's row in the job's settings (admin: Settings > Models)
 * Never the CLI's own default. Opus is refused wherever it comes from.
 */
export function resolveModel(opts: Pick<ProviderOptions, "step" | "model" | "effort">, env = process.env): ModelChoice {
  const key = opts.step?.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase();
  let fromSettings: ModelChoice | undefined;
  const settings = (snapshot ??= runSettings(env)).settings;
  if (settings.provider === "chatgpt") {
    if (opts.step) fromSettings = settings.providers.chatgpt.models[opts.step];
    const model = opts.model || fromSettings?.model;
    const effort = opts.effort || fromSettings?.effort || "medium";
    if (!model) throw new PipelineError(`Choose a ChatGPT plan model for ${opts.step ?? "this call"} in Settings.`, "config");
    return { model, effort: effort as ModelChoice["effort"] };
  }
  if (opts.step) fromSettings = settings.providers.claude.models[opts.step];
  const model = opts.model || (key && env[`CLAUDE_MODEL_${key}`]) || env.CLAUDE_MODEL || fromSettings?.model || "sonnet";
  const effort = opts.effort || (key && env[`CLAUDE_EFFORT_${key}`]) || env.CLAUDE_EFFORT || fromSettings?.effort || "medium";
  if (!isAllowedModel(model)) throw new PipelineError(`Model "${model}" is not allowed for ${opts.step ?? "this call"}: use sonnet or haiku (Opus is not used in this project).`, "config");
  if (!(EFFORT_LEVELS as readonly string[]).includes(effort)) throw new PipelineError(`Effort "${effort}" is not valid for ${opts.step ?? "this call"}: use ${EFFORT_LEVELS.join(", ")}.`, "config");
  return { model, effort: effort as ModelChoice["effort"] };
}

type RunResult = { ok: boolean; text?: string; envelope: unknown; exitCode: number | null; error?: { category: string; message: string } };

/** Runs the CLI once. Never rejects for CLI failures: the caller records the call (and any usage the CLI reported) first. */
function runOnce(prompt: string, opts: ProviderOptions, model: string, effort: string): Promise<RunResult> {
  const args = ["-p", "--output-format", "json", "--model", model, "--effort", effort];
  console.log(`  [${opts.step ?? opts.label ?? "claude"}: ${model}, ${effort} effort]`);
  if (opts.allowedTools?.length) args.push("--allowedTools", opts.allowedTools.join(","));
  const timeoutMs = opts.timeoutMs ?? Number(process.env.CLAUDE_TIMEOUT_MS ?? 15 * 60 * 1000);
  return new Promise((resolve) => {
    const child = spawn(process.env.CLAUDE_BIN ?? "claude", args, { env: cleanEnv(), stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    let settled = false;
    const done = (r: RunResult) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      done({ ok: false, envelope: null, exitCode: null, error: { category: "timeout", message: `claude -p timed out after ${Math.round(timeoutMs / 1000)}s` } });
    }, timeoutMs);
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (err += b));
    child.on("error", (e) => done({ ok: false, envelope: null, exitCode: null, error: { category: "missing", message: `Could not run the claude CLI (is it on PATH, or set CLAUDE_BIN, and run claude once to log in?): ${e.message}` } }));
    child.on("close", (code) => {
      // The CLI may print its structured result even when it fails (usage included): keep it.
      let envelope: unknown = null;
      try { envelope = JSON.parse(out); } catch { /* not JSON */ }
      const text = `${out}\n${err}`;
      if (/usage limit|session limit|limit reached|hit your .*limit|rate.?limit.*reset|api_error_status":429/i.test(text) && code !== 0)
        return done({ ok: false, envelope, exitCode: code, error: { category: "usage-limit", message: "Claude subscription usage limit reached; try again after it resets." } });
      if (code !== 0) return done({ ok: false, envelope, exitCode: code, error: { category: "process", message: `claude -p failed (${code}): ${err.slice(0, 600) || out.slice(0, 600)}` } });
      const parsed = envelope as { result?: string; is_error?: boolean } | null;
      if (!parsed) return done({ ok: false, envelope, exitCode: code, error: { category: "envelope", message: `claude -p printed something that isn't JSON: ${out.slice(0, 300)}` } });
      if (parsed.is_error || typeof parsed.result !== "string") return done({ ok: false, envelope, exitCode: code, error: { category: "cli-error", message: `claude -p returned an error: ${out.slice(0, 600)}` } });
      done({ ok: true, text: parsed.result, envelope, exitCode: code });
    });
    child.stdin.end(prompt);
  });
}

type Meta = { operationId: string; attempt: number; kind: string; repair: boolean; reason?: string };
type Called = { text: string; row: UsageRecord };

/** One budgeted, recorded selected-provider call. Throws before launch if a limit is reached. */
async function invoke(prompt: string, opts: ProviderOptions, meta: Meta): Promise<Called> {
  const { model, effort } = resolveModel(opts);
  const settings = (snapshot ??= runSettings()).settings;
  const provider = settings.provider;
  let reportedEffort: string | null = provider === "claude" ? effort : null;
  const res: Reservation = reserveCall({ provider, operation: opts.label ?? opts.step ?? provider, operationId: meta.operationId, step: opts.step, requestedModel: model, effort: reportedEffort, attempt: meta.attempt, repair: meta.repair, kind: meta.kind, reason: meta.reason });
  let r: RunResult;
  let providerUsage: unknown = null;
  if (provider === "claude") {
    r = await runOnce(prompt, opts, model, effort);
    providerUsage = r.envelope;
  } else {
    try {
      const available = await listChatGPTModels();
      const modelInfo = available.find((m) => m.id === model);
      if (!modelInfo) throw Object.assign(new Error(`Model ${model} is not available for the connected ChatGPT plan. Refresh the model list in Settings.`), { category: "unsupported-model" });
      const providerOptions = { ...opts, effort: modelInfo.reasoningEfforts?.includes(effort) ? effort : undefined };
      reportedEffort = providerOptions.effort ?? null;
      const response = await chatGPTResponse(prompt, providerOptions, model);
      providerUsage = response.usage;
      r = { ok: true, text: response.text, envelope: null, exitCode: 0 };
    } catch (e) {
      const err = e as Error & { category?: string; usage?: unknown };
      if (err.category === "auth-expired") await markChatGPTReauthenticationRequired();
      providerUsage = err.usage ?? null;
      r = { ok: false, envelope: null, exitCode: null, error: { category: err.category ?? "provider", message: err.message } };
    }
  }
  const usage = provider === "claude" ? (r.envelope ? normalizeCliUsage(r.envelope) : unknownUsage()) : normalizeResponsesUsage(providerUsage);
  const row = finishCall(res, { status: r.ok ? "ok" : "failed", usage, model: provider === "claude" ? usage.modelUsed : model, effort: reportedEffort, exitCode: r.exitCode, error: r.error ? { category: r.error.category, message: r.error.message.slice(0, 200) } : null });
  if (!r.ok) {
    const c = r.error!.category;
    throw new PipelineError(r.error!.message, c === "usage-limit" ? "busy" : c === "missing" ? "missing" : c === "unsupported-model" || c === "auth-expired" ? "config" : "external");
  }
  return { text: r.text!, row };
}

/** invoke + at most one retry of a transient CLI failure (the retry is its own ledger row). */
async function invokeWithRetry(prompt: string, opts: ProviderOptions, meta: Meta): Promise<Called> {
  try {
    return await invoke(prompt, opts, meta);
  } catch (e) {
    if (!(e instanceof PipelineError) || e.kind !== "external") throw e;
    console.log(`  ${((snapshot ??= runSettings()).settings.provider)} call${opts.label ? ` (${opts.label})` : ""} failed: ${e.message.split("\n")[0].slice(0, 200)}; retrying once`);
    return invoke(prompt, opts, { ...meta, kind: "retry", attempt: meta.attempt + 1, reason: "transient provider failure; no output to repair, so the same prompt is resent once" });
  }
}

const baseMeta = (opts: ProviderOptions): Meta => ({ operationId: randomUUID().slice(0, 8), attempt: 0, kind: opts.callKind ?? "generation", repair: false, reason: opts.reason });

export async function aiText(prompt: string, opts: ProviderOptions = {}): Promise<string> {
  return (await invokeWithRetry(prompt, opts, baseMeta(opts))).text;
}


/** Extracts the outermost JSON object from a reply. */
export function parseJsonReply<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  return JSON.parse(body.slice(start, end + 1)) as T;
}

const maxRepairs = () => {
  const n = getUsageContext().budgets?.repair?.maxAttemptsPerOperation;
  return Math.min(MAX_REPAIR_ATTEMPTS_HARD, typeof n === "number" ? n : MAX_REPAIR_ATTEMPTS_HARD);
};
const repairOpts = (opts: ProviderOptions, keepTools: boolean): ProviderOptions => ({ ...opts, step: "repair", model: undefined, effort: undefined, allowedTools: keepTools ? opts.allowedTools : undefined, callKind: undefined });
const short = (ps: string[]) => ps.slice(0, 8).join("; ");

/**
 * Runs the selected provider and parses a JSON object, validating it with `check`.
 * A defect is repaired as cheaply as is safe, at most `budgets.repair.maxAttemptsPerOperation`
 * times (hard cap 3): a local formatting fix (free), then a field-level repair
 * that returns only the failing fields (merged, then the WHOLE object is
 * re-validated), else a bounded full-object repair. Invalid output is never
 * accepted; every call (failed and repair included) is in the usage ledger.
 */
export async function aiJson<T>(prompt: string, opts: JsonOptions<T> = {}): Promise<T> {
  const meta = baseMeta(opts);
  const limit = maxRepairs();
  let repairs = 0;
  let { text, row } = await invokeWithRetry(prompt, opts, meta);
  let value: T | undefined;
  let fieldMode: "none" | "tried" = "none";
  let settled = false; // the current row already carries its final error (e.g. a rejected patch)
  for (;;) {
    // 1. parse
    if (value === undefined) {
      try {
        value = parseJsonReply<T>(text);
      } catch {
        const local = localRepairJson(text);
        if (local) {
          console.log(`  repaired the reply's formatting locally (${local.fixes.join(", ")}); no extra provider call`);
          value = local.value as T;
        } else {
          row = amendCall(row, { status: "failed", error: { category: "json-parse", message: "reply was not valid JSON" } });
          if (repairs >= limit) throw new PipelineError(`The selected provider did not return valid JSON: ${text.slice(0, 300)}`, "external");
          repairs++;
          ({ text, row } = await invoke(`Your previous reply was not valid JSON. Reformat it as a single valid JSON object without changing its content. Reply with ONLY the JSON object.\n\n${text}`, repairOpts(opts, false), { ...meta, attempt: repairs, kind: "repair-json", repair: true, reason: "reply was not parseable as JSON and could not be fixed locally" }));
          continue;
        }
      }
    }
    // 2. validate
    const problems = opts.check?.(value as T) ?? [];
    if (!problems.length) return value as T;
    if (!settled) row = amendCall(row, { status: "failed", error: { category: "validation", message: `${problems.length} problem(s): ${short(problems)}`.slice(0, 300) } });
    settled = false;
    if (repairs >= limit) throw new PipelineError(`The selected provider's output is still invalid after ${repairs} repair attempt${repairs === 1 ? "" : "s"}: ${problems.slice(0, 8).join("; ")}`, "invalid");
    repairs++;
    console.log(`  ${problems.length} validation problem(s) in provider reply; repairing (attempt ${repairs}/${limit})`);
    const current = value as T;
    const fr = opts.fieldRepair;
    const plan = fr && fieldMode === "none" ? planFieldRepair(current, problems) : ({ safe: false, reason: !fr ? "this output's fields are not independent (field repair not enabled for it)" : "field repair already tried" } as const);
    if (plan.safe) {
      fieldMode = "tried";
      const extra = typeof fr === "object" ? { context: fr.context?.(current), hint: fr.hint } : undefined;
      const called = await invoke(fieldRepairPrompt(current as Record<string, unknown>, plan, extra), repairOpts(opts, false), { ...meta, attempt: repairs, kind: "repair-fields", repair: true, reason: `${plan.paths.length} failing field(s): ${plan.paths.join(", ").slice(0, 160)}` });
      row = called.row;
      let patched: ReturnType<typeof applyPatch> | null = null;
      try { patched = applyPatch(current as Record<string, unknown>, extractPatch(parseJsonReply<unknown>(called.text)), plan); } catch { /* handled below */ }
      if (!patched || "error" in patched) {
        row = amendCall(row, { status: "failed", error: { category: "repair-rejected", message: (patched && "error" in patched ? patched.error : "the repair reply was not a JSON patch").slice(0, 200) } });
        settled = true;
        text = JSON.stringify(current);
        value = current; // keep the original; the next round re-validates it and falls back to a full repair
        continue;
      }
      value = patched.value as T;
      const after = opts.check?.(value) ?? [];
      if (!after.length) return value;
      row = amendCall(row, { status: "failed", error: { category: "validation", message: `repair left ${after.length} problem(s): ${short(after)}`.slice(0, 300) } });
      if (repairs >= limit) throw new PipelineError(`The selected provider's output is still invalid after ${repairs} repair attempt${repairs === 1 ? "" : "s"}: ${after.slice(0, 8).join("; ")}`, "invalid");
      continue;
    }
    // Full-object repair, with the reason on record.
    const resend = opts.repairResendsPrompt !== false;
    const p = `${resend ? `${prompt}\n\n` : ""}Your previous reply:\n${JSON.stringify(current)}\n\nIt failed validation:\n- ${problems.slice(0, 30).join("\n- ")}\n\n${resend ? "" : "Do not search or fetch anything; fix it using only the content above, and do not invent sources or evidence. "}Return the corrected JSON object only.`;
    const called = await invoke(p, repairOpts(opts, resend), { ...meta, attempt: repairs, kind: "repair-full", repair: true, reason: `full-object repair: ${plan.reason}`.slice(0, 200) });
    row = called.row;
    text = called.text;
    value = undefined;
  }
}


function normalizeResponsesUsage(u: any): Usage {
  const count = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
  const inputTokens = count(u?.input_tokens), outputTokens = count(u?.output_tokens);
  const status: Usage["status"] = inputTokens === null && outputTokens === null ? "unknown" : inputTokens !== null && outputTokens !== null ? "known" : "partial";
  return { status, inputTokens, outputTokens, cacheReadTokens: null, cacheCreationTokens: null, totalInputTokens: inputTokens, cost: null, modelUsed: null, native: u && typeof u === "object" ? { provider: "chatgpt-plan", usage: u } : {} };
}
