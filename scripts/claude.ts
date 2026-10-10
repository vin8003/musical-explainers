// Runs the Claude Code CLI headlessly (`claude -p`) on the local machine.
// Uses the logged-in Claude Code subscription: no API key involved.
import { spawnSync } from "node:child_process";

export type ClaudeOptions = {
  /** e.g. ["WebSearch", "WebFetch"] for the fact-check stage. */
  allowedTools?: string[];
  model?: string;
};

export function claudeText(prompt: string, opts: ClaudeOptions = {}): string {
  // A set API key can make the CLI bill the API instead of the subscription.
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  // When launched from inside another Claude Code session, drop its session
  // variables so this run uses your own CLI login.
  for (const key of Object.keys(env)) {
    if (key.startsWith("CLAUDE_CODE_") || key.startsWith("CLAUDE_AGENT_") || key === "CLAUDECODE" || key === "ANTHROPIC_BASE_URL") {
      delete env[key];
    }
  }

  const args = ["-p", "--output-format", "json"];
  if (opts.model) args.push("--model", opts.model);
  if (opts.allowedTools?.length) args.push("--allowedTools", opts.allowedTools.join(","));

  const res = spawnSync(process.env.CLAUDE_BIN ?? "claude", args, { input: prompt, encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024 });
  if (res.error) throw new Error(`Could not run the claude CLI (is it on PATH, or set CLAUDE_BIN, and run claude once to log in?): ${res.error.message}`);
  if (res.status !== 0) throw new Error(`claude -p failed (${res.status}): ${res.stderr}`);
  const out = JSON.parse(res.stdout) as { result?: string; is_error?: boolean };
  if (out.is_error || typeof out.result !== "string") throw new Error(`claude -p returned an error: ${res.stdout}`);
  return out.result;
}

/** Runs claude and parses a JSON object from the reply, retrying once if it is malformed. */
export function claudeJson<T>(prompt: string, opts: ClaudeOptions = {}): T {
  for (let attempt = 0; ; attempt++) {
    const text = claudeText(prompt, opts);
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    try {
      return JSON.parse(text.slice(start, end + 1)) as T;
    } catch (err) {
      if (attempt >= 1) throw new Error(`Claude did not return valid JSON: ${text.slice(0, 300)}`);
    }
  }
}
