// Usage accounting and budget rules, shared (plain ESM) by the pipeline (tsx),
// the admin server (plain node) and the admin UI, so the terminal and the web
// read ONE ledger through ONE aggregator. See docs/usage-budgets.md.
//
// Accounting rules
//  * Numbers come only from the Claude CLI's structured output (`claude -p
//    --output-format json`: `usage`, `modelUsage`, `total_cost_usd`). Nothing is
//    estimated from text length. A field the CLI did not report is `null`
//    ("unknown"), never 0.
//  * The CLI (like the API) reports `input_tokens` EXCLUDING cached tokens;
//    cache reads and cache writes are separate fields. So
//        totalInputTokens = inputTokens + cacheReadTokens + cacheCreationTokens
//    and each token is counted once. The native fields are kept in `native`.
//  * Cost is the CLI's own `total_cost_usd`: an ESTIMATE at API list prices,
//    not a bill, and not the 5-hour usage-window percentage (which no public
//    interface exposes). No price table is hardcoded here.
//  * Every call is a ledger row, including failed, repair and blocked ones.

export const USAGE_VERSION = 1;

const isNum = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
const num = (v) => (isNum(v) ? v : null);
const sum = (xs) => xs.reduce((a, b) => a + (b ?? 0), 0);

/**
 * Normalizes one parsed CLI result envelope (or null/garbage) into the
 * application usage schema. Tolerates other CLI versions: anything missing is
 * null and `status` says how complete it is.
 *   known   input, output and both cache categories reported
 *   partial some token fields reported, others not
 *   unknown nothing reported
 */
export function normalizeCliUsage(envelope) {
  const u = envelope && typeof envelope === "object" ? envelope.usage : null;
  const usage = u && typeof u === "object" ? u : {};
  const inputTokens = num(usage.input_tokens);
  const outputTokens = num(usage.output_tokens);
  const cacheReadTokens = num(usage.cache_read_input_tokens);
  const cacheCreationTokens = num(usage.cache_creation_input_tokens);
  const fields = [inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens];
  const present = fields.filter((x) => x !== null).length;
  const status = present === 0 ? "unknown" : present === 4 ? "known" : "partial";
  const modelUsage = envelope?.modelUsage && typeof envelope.modelUsage === "object" ? envelope.modelUsage : null;
  const models = modelUsage ? Object.keys(modelUsage) : [];
  const native = {};
  if (present) {
    const { iterations, ...rest } = usage; // iterations repeat the totals per turn; keep the count only
    native.usage = rest;
    if (Array.isArray(iterations)) native.iterations = iterations.length;
  }
  if (modelUsage) native.modelUsage = modelUsage;
  if (envelope && typeof envelope === "object") for (const k of ["num_turns", "duration_ms", "duration_api_ms", "stop_reason", "terminal_reason"]) if (k in envelope) native[k] = envelope[k];
  return {
    status,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    /** Sum of the input categories that were reported; null when none were. */
    totalInputTokens: [inputTokens, cacheReadTokens, cacheCreationTokens].some((x) => x !== null) ? sum([inputTokens, cacheReadTokens, cacheCreationTokens]) : null,
    cost: isNum(envelope?.total_cost_usd) ? { usd: envelope.total_cost_usd, basis: "claude-cli total_cost_usd (estimate at API list prices; not a bill)" } : null,
    modelUsed: models.length ? models.join(" + ") : null,
    native,
  };
}

/** A usage block for a call that produced no usable metadata. */
export const unknownUsage = () => ({ status: "unknown", inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null, totalInputTokens: null, cost: null, modelUsed: null, native: {} });

/** Ledger rows are append-only; a later row with the same callId updates the earlier one (idempotent writes, last wins). */
export function dedupeLedger(rows) {
  const byId = new Map();
  for (const r of rows) {
    if (!r || typeof r !== "object" || typeof r.callId !== "string") continue;
    byId.set(r.callId, byId.has(r.callId) ? { ...byId.get(r.callId), ...r } : r);
  }
  return [...byId.values()].sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
}

export function parseLedger(text) {
  const rows = [];
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* a torn last line is ignored */ }
  }
  return dedupeLedger(rows);
}

const launched = (r) => r.status !== "blocked";

/**
 * Totals for a list of ledger rows. Token and cost fields are null (unknown),
 * not 0, when no launched call reported them; with mixed knowledge they are the
 * sum of what was reported and `lowerBound` is true.
 */
export function aggregate(rows) {
  const calls = rows.filter(launched);
  const sumKnown = (f) => {
    const vals = calls.map(f).filter((x) => x !== null && x !== undefined);
    return vals.length ? sum(vals) : null;
  };
  // A call still running has no usage yet; that is "pending", not "unknown".
  const done = calls.filter((r) => r.status !== "running");
  const usageKnown = done.filter((r) => r.usage?.status === "known").length;
  const usagePartial = done.filter((r) => r.usage?.status === "partial").length;
  const usageUnknown = done.length - usageKnown - usagePartial;
  const costKnown = done.filter((r) => isNum(r.usage?.cost?.usd)).length;
  return {
    calls: calls.length,
    ok: calls.filter((r) => r.status === "ok").length,
    failed: calls.filter((r) => r.status === "failed").length,
    repairCalls: calls.filter((r) => r.repair).length,
    blocked: rows.length - calls.length,
    inputTokens: sumKnown((r) => r.usage?.inputTokens),
    outputTokens: sumKnown((r) => r.usage?.outputTokens),
    cacheReadTokens: sumKnown((r) => r.usage?.cacheReadTokens),
    cacheCreationTokens: sumKnown((r) => r.usage?.cacheCreationTokens),
    totalInputTokens: sumKnown((r) => r.usage?.totalInputTokens),
    costUsd: sumKnown((r) => r.usage?.cost?.usd),
    costUnknownCalls: done.length - costKnown,
    durationMs: sum(calls.map((r) => r.durationMs)),
    usageKnown,
    usagePartial,
    usageUnknown,
    completeness: !done.length ? "none" : usageUnknown + usagePartial === 0 ? "known" : usageKnown + usagePartial === 0 ? "unknown" : "partial",
    lowerBound: usagePartial + usageUnknown > 0 && usageKnown + usagePartial > 0,
  };
}

export function aggregateByStage(rows) {
  const stages = {};
  for (const r of rows) (stages[r.stage ?? "other"] ??= []).push(r);
  return Object.fromEntries(Object.entries(stages).map(([k, v]) => [k, aggregate(v)]));
}

/** Everything the UI and terminal show for one run, from the rows alone. */
export function summarize(rows, budgets) {
  const run = aggregate(rows);
  const stages = aggregateByStage(rows);
  return { v: USAGE_VERSION, run, stages, limits: budgets ? limitStatus(budgets, run, stages) : null };
}

// ---------- budgets ----------

const METRICS = [
  { key: "maxInputTokens", label: "input tokens", used: (t) => t.totalInputTokens, kind: "tokens" },
  { key: "maxOutputTokens", label: "output tokens", used: (t) => t.outputTokens, kind: "tokens" },
  { key: "maxEstimatedCost", label: "estimated cost (USD)", used: (t) => t.costUsd, kind: "cost" },
  { key: "maxCalls", label: "Claude calls", used: (t) => t.calls, kind: "calls" },
];

/**
 * Per-limit status for display and warnings: each configured limit with its
 * usage, remaining and percent. `used` is null when usage is unknown, and
 * `lowerBound` says the real number may be higher.
 */
export function limitStatus(budgets, run, stages) {
  const threshold = budgets?.warnings?.usagePercent ?? 80;
  const one = (scope, stage, limits, totals) =>
    METRICS.filter((m) => limits?.[m.key] !== null && limits?.[m.key] !== undefined).map((m) => {
      const limit = limits[m.key];
      const used = m.used(totals);
      const pct = used === null ? null : limit === 0 ? (used > 0 ? 100 : 0) : (used / limit) * 100;
      const state = used === null ? (totals.calls ? "unknown" : "ok") : used >= limit ? "exceeded" : pct >= threshold ? "warning" : "ok";
      return { scope, stage, metric: m.key, label: m.label, limit, used, remaining: used === null ? null : Math.max(0, limit - used), pct, state, lowerBound: Boolean(totals.lowerBound) };
    });
  const out = one("run", null, budgets?.run, run);
  for (const [stage, t] of Object.entries(stages ?? {})) out.push(...one("stage", stage, budgets?.stage, t));
  return out;
}

/**
 * Decision before a Claude call. Pure: `scope` = { run, stage } totals for the
 * run and for this stage, `inflight` = calls reserved but not yet finished in
 * this scope, `repair` = { isRepair, operationAttempts, runRepairCalls }.
 * Returns { allow, blocks[], warnings[] }; each block names the budget, limit,
 * current consumption and stage so the caller can raise a typed error.
 *
 * Limits: token and cost budgets can't be guaranteed within one call (usage is
 * only known when the CLI returns), so they gate on consumption so far; one
 * call may overshoot, and the NEXT call is then refused. To keep concurrent
 * calls from all spending the same remainder, a token or cost budget admits
 * only one in-flight call per scope.
 */
export function decideCall({ budgets, stage, scope, inflight = { run: 0, stage: 0 }, repair = {} }) {
  const blocks = [];
  const warnings = [];
  const b = budgets ?? {};
  const policy = b.unknownUsage ?? "warn";
  const block = (budget, limit, used, scopeName, reason) => blocks.push({ budget, limit, used, scope: scopeName, stage, reason });
  for (const [scopeName, limits, totals, flying] of [["run", b.run, scope.run, inflight.run], ["stage", b.stage, scope.stage, inflight.stage]]) {
    if (!limits) continue;
    for (const m of METRICS) {
      const limit = limits[m.key];
      if (limit === null || limit === undefined) continue;
      const name = `${scopeName}.${m.key}`;
      if (m.kind === "calls") {
        const used = totals.calls + flying;
        if (used >= limit) block(name, limit, used, scopeName, `${used} of ${limit} Claude calls already made or in progress`);
        continue;
      }
      if (flying > 0) {
        block(name, limit, m.used(totals), scopeName, "another call is in progress and its usage is not known yet, so the remaining budget can't be reserved safely");
        continue;
      }
      // No calls yet means nothing has been used (a real zero), so a zero allowance blocks the first call.
      const used = totals.calls === 0 ? 0 : m.used(totals);
      const missing = totals.calls > 0 && (used === null || totals.usageUnknown + totals.usagePartial > 0 || (m.kind === "cost" && totals.costUnknownCalls > 0));
      if (used !== null && used >= limit) block(name, limit, used, scopeName, `${used} of ${limit} ${m.label} already used`);
      else if (missing) {
        const why = `some calls in this ${scopeName} have unknown ${m.label}, so ${name} can't be verified`;
        if (policy === "block") block(name, limit, used, scopeName, why);
        else warnings.push({ budget: name, kind: "unknown-usage", message: `${why}; continuing (unknownUsage = warn)` });
      }
    }
  }
  const r = b.repair ?? {};
  if (repair.isRepair) {
    if (r.maxCallsPerRun !== null && r.maxCallsPerRun !== undefined && (repair.runRepairCalls ?? 0) >= r.maxCallsPerRun)
      block("repair.maxCallsPerRun", r.maxCallsPerRun, repair.runRepairCalls, "run", `${repair.runRepairCalls} repair calls already made in this run`);
    const per = r.maxAttemptsPerOperation;
    if (per !== null && per !== undefined && (repair.operationAttempts ?? 0) >= per)
      block("repair.maxAttemptsPerOperation", per, repair.operationAttempts, "operation", `${repair.operationAttempts} repair attempts already made for this operation`);
  }
  return { allow: blocks.length === 0, blocks, warnings };
}

/** Human line for a block, used by the typed error and the UI. */
export const describeBlock = (b) => `${b.budget} (limit ${b.limit}, used ${b.used ?? "unknown"}${b.stage ? `, stage ${b.stage}` : ""}): ${b.reason}`;

export const fmtTokens = (n) => (n === null || n === undefined ? "unknown" : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
export const fmtUsd = (n) => (n === null || n === undefined ? "unknown" : `$${n < 1 ? n.toFixed(4) : n.toFixed(2)}`);

/** One terminal line from aggregated totals; says what is unavailable rather than printing 0. */
export function usageLine(t) {
  if (!t.calls) return "no Claude calls";
  const bits = [`${t.calls} call${t.calls === 1 ? "" : "s"}${t.failed ? ` (${t.failed} failed)` : ""}`];
  if (t.repairCalls) bits.push(`${t.repairCalls} repair`);
  bits.push(t.totalInputTokens === null ? "tokens in: unknown" : `in ${fmtTokens(t.totalInputTokens)}${t.cacheReadTokens ? ` (cache read ${fmtTokens(t.cacheReadTokens)})` : ""}${t.lowerBound ? "+" : ""}`);
  bits.push(t.outputTokens === null ? "out: unknown" : `out ${fmtTokens(t.outputTokens)}${t.lowerBound ? "+" : ""}`);
  bits.push(t.costUsd === null ? "est. cost: unavailable" : `est. cost ${fmtUsd(t.costUsd)}${t.costUnknownCalls ? "+" : ""}`);
  bits.push(`${Math.round(t.durationMs / 1000)}s`);
  if (t.usageUnknown || t.usagePartial) bits.push(`usage metadata missing/partial on ${t.usageUnknown + t.usagePartial} call(s)`);
  return bits.join(", ");
}
