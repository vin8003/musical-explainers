# Usage telemetry, repair and budgets

Every Claude call the pipeline makes is recorded, bounded and (optionally) budgeted.

## What is measured

Numbers come only from `claude -p --output-format json` (`usage`, `modelUsage`, `total_cost_usd`; checked against CLI 2.1.197). Nothing is estimated from text length. A field the CLI does not report is **unknown** (`null`), never 0.

- `input_tokens` from the CLI **excludes** cached tokens; cache reads and cache writes are separate fields. So `totalInputTokens = inputTokens + cacheReadTokens + cacheCreationTokens`, each token counted once. Native fields are kept in the row's `usage.native`.
- Completeness per call: `known` (input, output, both cache fields), `partial`, `unknown`. Totals are `null` when nothing was reported; with mixed knowledge they are a lower bound (shown with a trailing `+`).
- **Estimated cost** is the CLI's own `total_cost_usd` (an estimate at API list prices). It is not a bill, and it is **not** the five-hour usage-window percentage, which no public interface exposes, so it is not shown. No price table is hardcoded.
- Failed calls keep whatever usage the CLI printed; a call that died before printing (timeout, missing CLI) is `unknown`.

## Ledger

`out/<slug>/usage.jsonl`, append-only, one row per call: run/call/operation ids, stage, step, requested and actual model, effort, attempt, kind (`generation`, `retry`, `repair-json`, `repair-fields`, `repair-full`, `regeneration`) with a reason, timestamps, duration, exit code, status (`ok`, `failed`, `blocked`, `running`), error category (`json-parse`, `validation`, `repair-rejected`, `process`, `timeout`, `usage-limit`, `budget`, `interrupted`, ...), usage and the budget decision. A later row with the same `callId` replaces the earlier one, so restarts and retries never double count. **Prompts and replies are never stored.** Videos without a ledger show usage as unavailable.

Terminal summaries, the admin API (`GET /api/videos/:slug/usage`), the live job strip and the Usage tab all aggregate this one file (`src/schema/usage.mjs`). Live updates ride the existing `@@` event lines and SSE as `{event: "usage", v: 1, type}` with `call_started`, `call_completed`, `call_failed`, `repair_started`, `usage_updated`, `budget_warning`, `budget_reached`, `budget_exceeded`.

A **run** is one production attempt for a video: it keeps its id (and restores its totals from the ledger) across failures, budget stops and resumes, and a new one begins with `--fresh` or after a run finishes.

## Repair

A reply that fails validation is not retried with the original prompt plus the reply. In order:

1. **Local fix** of a formatting defect with one reading (trailing comma, raw newline in a string): no call.
2. **Field repair** (callers that opt in: research, outline, review): the failing paths are taken from the validator's messages (`claims[3]`, `thesis`, ...); the model gets only those fields, the problems and compact context, with no web tools, and returns `{"patch": {...}}`. The patch is merged deterministically (unrequested paths, non-objects and changed ids are rejected; unmentioned fields keep their original values) and the **whole** object is re-validated. Valid claims, sources and provenance are never regenerated and nothing is searched twice.
3. **Full-object repair** when problems can't be attributed to existing fields (e.g. "at least 5 claims") or the fields are most of the object, or field repair already failed. The reason is recorded. For research it sends only the previous object and problems (no original prompt, no tools); other callers keep resending their prompt, as before.

Repairs use the new **Output repair** model/effort (default sonnet, low); the generation keeps its own step. Attempts per operation are capped by `budgets.repair.maxAttemptsPerOperation` (default 1, hard cap 3, 0 disables repair). Invalid output is never accepted.

Audit of other retry paths: the script length retry (`scriptFix`) deliberately regenerates the script with measured numbers (editorial criterion unchanged) and is labelled `regeneration`; direct, fact-check revision, visual review and script use a full-object repair with their prompt; a transient CLI failure is retried once with the same prompt (no output to repair) as a separate `retry` row.

## Budgets (`budgets` in `config/settings.json`, Settings > Usage budgets)

```json
{ "budgets": {
  "run":   { "maxInputTokens": null, "maxOutputTokens": null, "maxEstimatedCost": null, "maxCalls": null },
  "stage": { "maxInputTokens": null, "maxOutputTokens": null, "maxEstimatedCost": null, "maxCalls": null },
  "repair": { "maxAttemptsPerOperation": 1, "maxCallsPerRun": null },
  "warnings": { "usagePercent": 80 },
  "unknownUsage": "warn" } }
```

- **Empty / `null` / omitted = unrestricted. `0` is a real zero allowance** and blocks every call. Negative, fractional counts and non-numbers are rejected. Existing settings files (no `budgets`) stay valid and unrestricted.
- *Run* limits cover all calls of the run: failed, repair, review, revision. *Stage* limits apply to each stage separately. Input tokens means all input categories (fresh + cache read + cache write). Call counts include failed and repair calls.
- Checked **before every call**, atomically with its reservation. A blocked call is never started: it raises `BudgetExceededError` (kind `budget`, naming budget, limit, use and stage), the pipeline stops cleanly, completed stages are kept, and the reason is in `state.json` (`usage.stop`), the job and the Usage tab. Raise or clear the limit and continue.
- Token and cost use is only known when a call returns, so **one call can overshoot** a token or cost limit; the next call is refused. The CLI offers no hard token ceiling, so none is promised. With a token or cost budget only one call per scope may be in flight (the remainder can't be reserved).
- `unknownUsage`: when a limit is set but earlier calls reported no usage (or no cost), `warn` continues with a warning, `block` refuses. Cost limits only use cost the CLI reported.
- A job uses the budgets in its start-time settings snapshot, like every other setting.
- A budget stop is distinct from generation/validation failures (`invalid`) and from the subscription's usage-window limit (`busy`).
