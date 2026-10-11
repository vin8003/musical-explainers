// Types for settings.mjs.
import type { Format } from "./timeline.mjs";

export type FormatDuration = { targetSeconds: number; minSeconds: number; maxSeconds: number };
export type ModelStepId = "research" | "outline" | "script" | "scriptFix" | "review" | "factcheck" | "revise" | "direct" | "repair" | "visualReview";
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";
export type ModelChoice = { model: string; effort: EffortLevel };
export type ModelStep = { id: ModelStepId; label: string; stage: string; tools?: "web" | "images"; why: string };
/** null = unrestricted; 0 is a real zero allowance. */
export type BudgetLimits = { maxInputTokens: number | null; maxOutputTokens: number | null; maxEstimatedCost: number | null; maxCalls: number | null };
export type Budgets = {
  run: BudgetLimits;
  stage: BudgetLimits;
  repair: { maxAttemptsPerOperation: number | null; maxCallsPerRun: number | null };
  warnings: { usagePercent: number };
  unknownUsage: "warn" | "block";
};
export type Settings = {
  version: number;
  formats: Record<Format, FormatDuration>;
  narration: { wordsPerMinute: number; targetTolerance: number };
  /** Model and reasoning effort per Claude call. */
  models: Record<ModelStepId, ModelChoice>;
  budgets: Budgets;
};
export type DurationCheck = { verdict: "ok" | "off-target" | "short" | "long" | "unknown"; message: string };

export declare const SETTINGS_VERSION: number;
export declare const FORMATS: Format[];
export declare const FORMAT_LABEL: Record<Format, string>;
export declare const DEFAULT_SETTINGS: Settings;
export declare function validateSettings(s: unknown): string[];
export declare function normalizeSettings(s: unknown): Settings;
export declare function resolveSettings(raw: unknown): { settings: Settings; source: "defaults" | "file" | "file+defaults"; warnings: string[] };
export declare function formatKey(settings: Settings, format: Format): string;
export declare function checkDuration(seconds: number | null | undefined, settings: Settings, format: Format): DurationCheck;
export declare function fmt(seconds: number): string;
export declare const BLOCKING_VERDICTS: string[];
export declare function isBlocking(verdict: string | null | undefined): boolean;
export declare function wordsToTarget(m: { seconds: number; targetSeconds: number; measuredWpm?: number | null }, fallbackWpm: number): number;
export declare const MODEL_STEPS: ModelStep[];
export declare const MODEL_STEP_IDS: ModelStepId[];
export declare const MODEL_CHOICES: readonly string[];
export declare const EFFORT_LEVELS: readonly EffortLevel[];
export declare function isAllowedModel(m: unknown): boolean;
export declare const BUDGET_LIMIT_KEYS: string[];
export declare const UNKNOWN_USAGE_POLICIES: string[];
export declare const MAX_REPAIR_ATTEMPTS_HARD: number;
export declare function validateBudgets(b: unknown): string[];
export declare function normalizeBudgets(b: unknown): Budgets;
