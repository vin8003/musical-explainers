// Per-video production state (out/<slug>/state.json): what each stage last
// did, with which inputs, so stages can be cached, marked stale, retried and
// shown honestly in the admin panel. Also the candidate/approval history.
import { paths, readJson, writeJson } from "./files";

export const STAGES = ["research", "outline", "script", "review", "factcheck", "direct", "assets", "audio", "render", "qa", "package"] as const;
export type Stage = (typeof STAGES)[number];

export type StageRecord = {
  status: "idle" | "running" | "done" | "failed" | "cancelled" | "skipped";
  /** Hash of the inputs the last successful run used. */
  inputHash?: string;
  startedAt?: string;
  endedAt?: string;
  attempts?: number;
  error?: { message: string; kind?: string; hint?: string } | null;
  /** Short human summary of the result, e.g. "12 claims ok" or "full mix, 1:42". */
  summary?: string;
  warnings?: string[];
};

export type Candidate = {
  id: string;
  createdAt: string;
  preview: boolean;
  formats: string[];
  /** Hashes that went into this render, to tell if it is stale. */
  specHash: string;
  audioHash: string | null;
  codeHash: string;
  audio: Record<string, string>;
  qa?: { status: "pass" | "warn" | "fail"; at: string; summary: string };
  /** Duration settings this candidate was made under, and its measured lengths per cut. */
  durations?: Partial<Record<"main" | "short", { targetSeconds: number; minSeconds: number; maxSeconds: number; seconds: number; verdict: string; timelineSeconds?: number; soundtrackSeconds?: number | null; probed?: boolean }>>;
  review?: { decision: "approved" | "rejected"; notes: string; at: string };
};

export type ProductionState = {
  slug: string;
  stages: Partial<Record<Stage, StageRecord>>;
  candidates: Candidate[];
  approved?: string | null;
  /** The settings snapshot of the latest pipeline run (a later settings change doesn't rewrite it). */
  run?: { at: string; settings: unknown; source: string; formats: string[]; pid: number } | null;
  /** Last stage that completed successfully, for "resume from here". */
  checkpoint?: Stage | null;
  /** Usage run (see scripts/core/usage.ts). A budget stop is kept in `stop` so it can be inspected after the process exits. */
  usage?: { runId: string; startedAt: string; completedAt?: string; stop?: { at: string; stage: string; blocks: unknown[]; message: string } | null };
  updatedAt?: string;
};

export function loadState(slug: string): ProductionState {
  const s = readJson<ProductionState>(paths.state(slug), { slug, stages: {}, candidates: [] });
  s.stages ??= {};
  s.candidates ??= [];
  return s;
}

export function saveState(s: ProductionState) {
  s.updatedAt = new Date().toISOString();
  writeJson(paths.state(s.slug), s);
}

/** Re-reads, applies fn, writes: keeps concurrent writers (admin review vs pipeline) from clobbering each other's fields. */
export function updateState(slug: string, fn: (s: ProductionState) => void): ProductionState {
  const s = loadState(slug);
  fn(s);
  saveState(s);
  return s;
}

export function setStage(slug: string, stage: Stage, patch: Partial<StageRecord>) {
  return updateState(slug, (s) => {
    s.stages[stage] = { ...(s.stages[stage] ?? { status: "idle" }), ...patch };
    if (patch.status === "done") s.checkpoint = stage;
  });
}

/** Machine-readable progress line for the admin panel (it parses lines starting with @@). */
export function emit(event: Record<string, unknown>) {
  console.log(`@@ ${JSON.stringify(event)}`);
}
