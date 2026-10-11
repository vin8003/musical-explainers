#!/usr/bin/env node
// A stand-in `claude -p --output-format json` that plays back a script:
// $SCRIPT is a JSON array of steps, consumed one per call (the last repeats).
//   { result: "text" | object, usage?: {...}|null, cost?: number, exit?: 1, stdout?: "raw", delayMs?: n }
// Every call is appended to $FAKE_LOG as {n, chars, head}. No network, no model.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
let input = "";
for await (const c of process.stdin) input += c;
const steps = JSON.parse(readFileSync(process.env.SCRIPT, "utf8"));
const idxFile = `${process.env.SCRIPT}.idx`;
const n = existsSync(idxFile) ? Number(readFileSync(idxFile, "utf8")) : 0;
writeFileSync(idxFile, String(n + 1));
appendFileSync(process.env.FAKE_LOG, JSON.stringify({ n, chars: input.length, head: input.slice(0, 160), args: process.argv.slice(2) }) + "\n");
const step = steps[Math.min(n, steps.length - 1)];
if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
const usage = step.usage === undefined ? { input_tokens: 10, cache_creation_input_tokens: 50, cache_read_input_tokens: 100, output_tokens: 20 } : step.usage;
const env = { type: "result", is_error: Boolean(step.exit), result: typeof step.result === "string" ? step.result : JSON.stringify(step.result), ...(usage ? { usage } : {}), ...(step.cost !== undefined ? { total_cost_usd: step.cost } : {}), ...(usage ? { modelUsage: { "claude-sonnet-fake": {} } } : {}) };
process.stdout.write(step.stdout ?? JSON.stringify(env), () => process.exit(step.exit ?? 0));
