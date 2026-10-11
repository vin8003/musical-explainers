// Runs the Claude Code CLI headlessly (`claude -p`) on the local machine.
// Uses the logged-in Claude Code subscription: no API key involved.
// Bounded: a timeout per call, at most one retry on transient errors, and no
// retry at all when the subscription's usage limit is hit.
import { spawn } from "node:child_process";
import { PipelineError } from "./core/files";
import { runSettings } from "./core/settings";
import { isAllowedModel, EFFORT_LEVELS } from "../src/schema/settings.mjs";
import type { ModelChoice, ModelStepId } from "../src/schema/settings.mjs";

export type ClaudeOptions = {
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
export function resolveModel(opts: Pick<ClaudeOptions, "step" | "model" | "effort">, env = process.env): ModelChoice {
  const key = opts.step?.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase();
  let fromSettings: ModelChoice | undefined;
  if (opts.step) fromSettings = (snapshot ??= runSettings(env)).settings.models[opts.step];
  const model = opts.model || (key && env[`CLAUDE_MODEL_${key}`]) || env.CLAUDE_MODEL || fromSettings?.model || "sonnet";
  const effort = opts.effort || (key && env[`CLAUDE_EFFORT_${key}`]) || env.CLAUDE_EFFORT || fromSettings?.effort || "medium";
  if (!isAllowedModel(model)) throw new PipelineError(`Model "${model}" is not allowed for ${opts.step ?? "this call"}: use sonnet or haiku (Opus is not used in this project).`, "config");
  if (!(EFFORT_LEVELS as readonly string[]).includes(effort)) throw new PipelineError(`Effort "${effort}" is not valid for ${opts.step ?? "this call"}: use ${EFFORT_LEVELS.join(", ")}.`, "config");
  return { model, effort: effort as ModelChoice["effort"] };
}

function runOnce(prompt: string, opts: ClaudeOptions): Promise<string> {
  const args = ["-p", "--output-format", "json"];
  const { model, effort } = resolveModel(opts);
  args.push("--model", model, "--effort", effort);
  console.log(`  [${opts.step ?? opts.label ?? "claude"}: ${model}, ${effort} effort]`);
  if (opts.allowedTools?.length) args.push("--allowedTools", opts.allowedTools.join(","));
  const timeoutMs = opts.timeoutMs ?? Number(process.env.CLAUDE_TIMEOUT_MS ?? 15 * 60 * 1000);
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.CLAUDE_BIN ?? "claude", args, { env: cleanEnv(), stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new PipelineError(`claude -p timed out after ${Math.round(timeoutMs / 1000)}s`, "external"));
    }, timeoutMs);
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (err += b));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new PipelineError(`Could not run the claude CLI (is it on PATH, or set CLAUDE_BIN, and run claude once to log in?): ${e.message}`, "missing"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const text = `${out}\n${err}`;
      if (/usage limit|session limit|limit reached|hit your .*limit|rate.?limit.*reset|api_error_status":429/i.test(text) && code !== 0)
        return reject(new PipelineError("Claude subscription usage limit reached; try again after it resets.", "busy"));
      if (code !== 0) return reject(new PipelineError(`claude -p failed (${code}): ${err.slice(0, 600) || out.slice(0, 600)}`, "external"));
      try {
        const parsed = JSON.parse(out) as { result?: string; is_error?: boolean };
        if (parsed.is_error || typeof parsed.result !== "string") return reject(new PipelineError(`claude -p returned an error: ${out.slice(0, 600)}`, "external"));
        resolve(parsed.result);
      } catch {
        reject(new PipelineError(`claude -p printed something that isn't JSON: ${out.slice(0, 300)}`, "external"));
      }
    });
    child.stdin.end(prompt);
  });
}

export async function claudeText(prompt: string, opts: ClaudeOptions = {}): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await runOnce(prompt, opts);
    } catch (e) {
      if (!(e instanceof PipelineError) || e.kind !== "external" || attempt >= 1) throw e;
      console.log(`  claude call${opts.label ? ` (${opts.label})` : ""} failed: ${e.message.split("\n")[0].slice(0, 200)}; retrying once`);
    }
  }
}

/** Extracts the outermost JSON object from a reply. */
export function parseJsonReply<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  return JSON.parse(body.slice(start, end + 1)) as T;
}

/**
 * Runs claude and parses a JSON object. If `check` returns problems, the
 * reply is sent back once with the problems so Claude can fix its own output.
 */
export async function claudeJson<T>(prompt: string, opts: ClaudeOptions & { check?: (v: T) => string[] } = {}): Promise<T> {
  let p = prompt;
  for (let attempt = 0; ; attempt++) {
    const text = await claudeText(p, opts);
    let value: T;
    try {
      value = parseJsonReply<T>(text);
    } catch {
      if (attempt >= 1) throw new PipelineError(`Claude did not return valid JSON: ${text.slice(0, 300)}`, "external");
      p = `${prompt}\n\nYour previous reply was not valid JSON. Reply with ONLY the JSON object.`;
      continue;
    }
    const problems = opts.check?.(value) ?? [];
    if (!problems.length) return value;
    if (attempt >= 1) throw new PipelineError(`Claude's output is still invalid after one repair: ${problems.slice(0, 8).join("; ")}`, "invalid");
    console.log(`  ${problems.length} validation problem(s) in Claude's reply; asking it to fix them`);
    p = `${prompt}\n\nYour previous reply:\n${JSON.stringify(value)}\n\nIt failed validation:\n- ${problems.slice(0, 30).join("\n- ")}\n\nReturn the corrected JSON only.`;
  }
}
