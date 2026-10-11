// Types for usage.mjs.
export type UsageStatus = "known" | "partial" | "unknown";
export type Usage = {
  status: UsageStatus;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  totalInputTokens: number | null;
  cost: { usd: number; basis: string } | null;
  modelUsed: string | null;
  native: Record<string, unknown>;
};
export type Totals = {
  calls: number; ok: number; failed: number; repairCalls: number; blocked: number;
  inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null; cacheCreationTokens: number | null; totalInputTokens: number | null;
  costUsd: number | null; costUnknownCalls: number; durationMs: number;
  usageKnown: number; usagePartial: number; usageUnknown: number;
  completeness: "none" | "known" | "partial" | "unknown"; lowerBound: boolean;
};
export type LimitStatus = { scope: "run" | "stage"; stage: string | null; metric: string; label: string; limit: number; used: number | null; remaining: number | null; pct: number | null; state: "ok" | "warning" | "exceeded" | "unknown"; lowerBound: boolean };
export type BlockInfo = { budget: string; limit: number; used: number | null; scope: string; stage: string; reason: string };
export declare const USAGE_VERSION: number;
export declare function budgetsForProvider<T>(budgets: T, provider?: string): T;
export declare function normalizeCliUsage(envelope: unknown): Usage;
export declare function unknownUsage(): Usage;
export declare function dedupeLedger<T extends { callId: string }>(rows: T[]): T[];
export declare function parseLedger(text: string): any[];
export declare function aggregate(rows: any[]): Totals;
export declare function aggregateByStage(rows: any[]): Record<string, Totals>;
export declare function summarize(rows: any[], budgets?: unknown): { v: number; run: Totals; stages: Record<string, Totals>; limits: LimitStatus[] | null };
export declare function limitStatus(budgets: unknown, run: Totals, stages: Record<string, Totals>): LimitStatus[];
export declare function decideCall(input: { budgets: unknown; stage: string; scope: { run: Totals; stage: Totals }; inflight?: { run: number; stage: number }; repair?: { isRepair?: boolean; operationAttempts?: number; runRepairCalls?: number } }): { allow: boolean; blocks: BlockInfo[]; warnings: { budget: string; kind: string; message: string }[] };
export declare function describeBlock(b: BlockInfo): string;
export declare function fmtTokens(n: number | null | undefined): string;
export declare function fmtUsd(n: number | null | undefined): string;
export declare function usageLine(t: Totals): string;
