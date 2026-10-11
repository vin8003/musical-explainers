import type { Settings } from "../../src/schema/settings.mjs";

export type Topic = { slug: string; title: string; angle?: string; chorusIdea?: string; notes?: string; status?: string; review?: { notes?: string } };

export type Format = "main" | "short";

export type RunCtx = {
  slug: string;
  title: string;
  topic?: Topic;
  /** Rewrite the outline and script from scratch (old spec archived). Research is kept. */
  fresh: boolean;
  /** Re-run a stage even if its inputs haven't changed. */
  force: boolean;
  /** Limit direct/render/qa to these shot ids. */
  shots?: string[];
  /** Reviewer notes for targeted direction. */
  notes?: string;
  /** Half-resolution, faster render. */
  preview: boolean;
  formats: Format[];
  allowMissingAssets: boolean;
  /** Ask Claude to look at the contact sheets (uses subscription). */
  visualReview: boolean;
  /** Automatic fix rounds after QA (default 1). */
  fixRounds: number;
  /** The duration settings snapshot this run uses (resolved once when the job starts). */
  settings: Settings;
  /** Targeted script revision (e.g. after a duration failure): extra instructions per format. */
  revise?: Partial<Record<Format, string>>;
};

export type StageResult = {
  summary: string;
  /** True when the stage found its outputs fresh and did nothing. */
  cached: boolean;
  warnings?: string[];
  inputHash?: string;
};
