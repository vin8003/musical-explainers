// The usage ledger and budget circuit breaker for Claude calls.
//
// One append-only JSONL file per video (out/<slug>/usage.jsonl) holds a row per
// call (including failed, repair and blocked ones). Rows carry a stable callId;
// a later row with the same callId updates the earlier one, so retries and
// restarts never double count. The terminal summaries, the admin server and the
// admin UI all aggregate this same file (src/schema/usage.mjs).
//
// The ledger never stores prompts or replies: only metadata, token counts and a
// short error category/message.
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { aggregate, decideCall, describeBlock, limitStatus, parseLedger, summarize, unknownUsage, usageLine } from "../../src/schema/usage.mjs";
import type { Settings } from "../../src/schema/settings.mjs";
import { DATA, PipelineError } from "./files";
import { emit, updateState } from "./state";

export type Budgets = Settings["budgets"];

export type UsageBlock = ReturnType<typeof unknownUsage>;

export type UsageRecord = {
  v: 1;
  runId: string;
  sessionId: string;
  callId: string;
  slug?: string;
  stage: string;
  /** What the call is for, e.g. "research", "script main". Never the prompt. */
  operation: string;
  /** Groups the generation call and all of its repair calls. */
  operationId: string;
  step?: string;
  model: string | null;
  requestedModel: string;
  effort: string | null;
  attempt: number;
  repair: boolean;
  /** generation | retry | repair-json | repair-fields | repair-full | regeneration */
  kind: string;
  reason?: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  /** ok = produced an accepted result; failed = the call or its validation failed; blocked = never launched; running = in flight. */
  status: "ok" | "failed" | "blocked" | "running";
  error?: { category: string; message: string } | null;
  exitCode?: number | null;
  usage: UsageBlock;
  budget?: { decision: "allow" | "block"; warnings?: unknown[]; blocks?: unknown[] };
};

export type UsageContext = {
  slug?: string;
  runId: string;
  sessionId: string;
  stage?: string;
  /** Overrides the default out/<slug>/usage.jsonl (tests). */
  ledgerFile?: string;
  /** The run's budgets (from its settings snapshot). Undefined = unrestricted. */
  budgets?: Budgets;
};

export const newRunId = () => `run-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${randomUUID().slice(0, 6)}`;
let ctx: UsageContext = { runId: newRunId(), sessionId: randomUUID() };
export const setUsageContext = (patch: Partial<UsageContext>) => { ctx = { ...ctx, ...patch }; };
export const getUsageContext = () => ctx;

export const ledgerPath = (slug: string) => join(DATA, "out", slug, "usage.jsonl");
const file = () => ctx.ledgerFile ?? (ctx.slug ? ledgerPath(ctx.slug) : undefined);

export function readLedger(path = file()): UsageRecord[] {
  if (!path || !existsSync(path)) return [];
  return parseLedger(readFileSync(path, "utf8")) as UsageRecord[];
}
export const runRows = () => readLedger().filter((r) => r.runId === ctx.runId);

export function writeRow(row: UsageRecord) {
  const f = file();
  if (!f) return;
  mkdirSync(dirname(f), { recursive: true });
  appendFileSync(f, JSON.stringify(row) + "\n");
}

/** A configured usage limit stopped the pipeline before a Claude call was started. */
export class BudgetExceededError extends PipelineError {
  constructor(public blocks: ReturnType<typeof decideCall>["blocks"], public stage: string) {
    super(`Usage budget reached; no Claude call was started. ${blocks.map(describeBlock).join(" | ")}`, "budget", "Raise or clear the limit in Settings > Usage budgets, then continue the pipeline: completed stages are kept.");
  }
}

const inflight = new Map<string, { stage: string; repair: boolean }>();
const warned = new Set<string>();

export type Reservation = { callId: string; startedAt: string; stage: string; warnings: unknown[]; base: UsageRecord };
export type CallRequest = { operation: string; operationId: string; step?: string; requestedModel: string; effort: string | null; attempt: number; repair: boolean; kind: string; reason?: string };

/**
 * Circuit breaker, run synchronously before every launch (no await between the
 * check and the reservation, so concurrent callers can't share one remainder).
 * Allowed: reserves a slot and writes a "running" row. Blocked: writes a
 * "blocked" row, emits budget_exceeded, records why the run stopped, and throws.
 */
export function reserveCall(req: CallRequest, budgets = ctx.budgets): Reservation {
  const stage = ctx.stage ?? "other";
  // A "running" row from a process that is gone (killed, crashed) is closed as an interrupted call with unknown usage.
  for (const r of runRows()) if (r.status === "running" && r.sessionId !== ctx.sessionId) writeRow({ ...r, status: "failed", endedAt: new Date().toISOString(), error: { category: "interrupted", message: "the process ended before this call reported usage" } });
  // Calls of this process that are still in flight are counted through `inflight`, not through their ledger rows.
  const rows = runRows().filter((r) => !inflight.has(r.callId));
  const callId = `${ctx.runId}-${randomUUID().slice(0, 8)}`;
  const startedAt = new Date().toISOString();
  const flying = [...inflight.values()];
  const repairRows = rows.filter((r) => r.repair && r.status !== "blocked");
  const decision = decideCall({
    budgets,
    stage,
    scope: { run: aggregate(rows), stage: aggregate(rows.filter((r) => r.stage === stage)) },
    inflight: { run: flying.length, stage: flying.filter((i) => i.stage === stage).length },
    repair: { isRepair: req.repair, operationAttempts: repairRows.filter((r) => r.operationId === req.operationId).length, runRepairCalls: repairRows.length + flying.filter((i) => i.repair).length },
  });
  const base: UsageRecord = { v: 1, runId: ctx.runId, sessionId: ctx.sessionId, callId, slug: ctx.slug, stage, operation: req.operation, operationId: req.operationId, step: req.step, model: null, requestedModel: req.requestedModel, effort: req.effort, attempt: req.attempt, repair: req.repair, kind: req.kind, reason: req.reason, startedAt, status: "running", usage: unknownUsage() };
  if (!decision.allow) {
    writeRow({ ...base, endedAt: startedAt, durationMs: 0, status: "blocked", error: { category: "budget", message: decision.blocks.map(describeBlock).join(" | ").slice(0, 400) }, budget: { decision: "block", blocks: decision.blocks } });
    const err = new BudgetExceededError(decision.blocks, stage);
    emit({ event: "usage", v: 1, type: "budget_exceeded", stage, blocks: decision.blocks, ...totalsPayload() });
    if (ctx.slug) updateState(ctx.slug, (s) => { s.usage = { ...(s.usage ?? { runId: ctx.runId, startedAt }), stop: { at: startedAt, stage, blocks: decision.blocks, message: err.message } }; });
    throw err;
  }
  inflight.set(callId, { stage, repair: req.repair });
  base.budget = { decision: "allow", warnings: decision.warnings };
  writeRow(base);
  emit({ event: "usage", v: 1, type: req.repair ? "repair_started" : "call_started", stage, callId, operation: req.operation, kind: req.kind, reason: req.reason, attempt: req.attempt, model: req.requestedModel, effort: req.effort });
  for (const w of decision.warnings) emit({ event: "usage", v: 1, type: "budget_warning", stage, ...(w as object) });
  return { callId, startedAt, stage, warnings: decision.warnings, base };
}

/** Records the outcome of a call (any outcome), releases its reservation, checks warning thresholds and announces the new totals. */
export function finishCall(res: Reservation, patch: Partial<UsageRecord> & Pick<UsageRecord, "status" | "usage">): UsageRecord {
  inflight.delete(res.callId);
  const row: UsageRecord = { ...res.base, ...patch, endedAt: new Date().toISOString(), durationMs: Date.now() - Date.parse(res.startedAt) };
  writeRow(row);
  announce(row);
  return row;
}

/** Updates an already-recorded call after the fact (e.g. the CLI succeeded but the reply failed validation). Same callId, so it replaces rather than adds. */
export function amendCall(row: UsageRecord, patch: Partial<UsageRecord>): UsageRecord {
  const next = { ...row, ...patch };
  writeRow(next);
  announce(next);
  return next;
}

function announce(row: UsageRecord) {
  const payload = totalsPayload();
  emit({ event: "usage", v: 1, type: row.status === "ok" ? "call_completed" : "call_failed", stage: row.stage, call: slimRow(row) });
  emit({ event: "usage", v: 1, type: "usage_updated", stage: row.stage, ...payload });
  for (const l of payload.limits ?? []) {
    const key = `${ctx.runId}:${l.scope}:${l.stage ?? ""}:${l.metric}:${l.state}`;
    if ((l.state === "warning" || l.state === "exceeded") && !warned.has(key)) {
      warned.add(key);
      emit({ event: "usage", v: 1, type: l.state === "warning" ? "budget_warning" : "budget_reached", ...l });
      console.log(`  [budget] ${l.state === "warning" ? "warning" : "limit reached"}: ${l.scope}${l.stage ? ` ${l.stage}` : ""} ${l.label}: ${l.used} of ${l.limit}`);
    }
  }
}

export const slimRow = (r: UsageRecord) => ({
  callId: r.callId, stage: r.stage, operation: r.operation, kind: r.kind, repair: r.repair, reason: r.reason, attempt: r.attempt,
  model: r.model ?? r.requestedModel, effort: r.effort, status: r.status, error: r.error ?? null, durationMs: r.durationMs ?? null, startedAt: r.startedAt, endedAt: r.endedAt ?? null,
  usage: { status: r.usage.status, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, cacheReadTokens: r.usage.cacheReadTokens, cacheCreationTokens: r.usage.cacheCreationTokens, cost: r.usage.cost?.usd ?? null },
});

export function totalsPayload() {
  const s = summarize(runRows(), ctx.budgets);
  return { runId: ctx.runId, totals: s.run, stages: s.stages, limits: s.limits as ReturnType<typeof limitStatus> | null };
}

/** Terminal summary lines (same aggregator the web UI uses). */
export const runSummaryLine = () => usageLine(aggregate(runRows()));
export const stageSummaryLine = (stage: string, sinceIso: string) => usageLine(aggregate(runRows().filter((r) => r.stage === stage && r.startedAt >= sinceIso)));
export { aggregate };
