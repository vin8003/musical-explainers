// Types for editorial.mjs.
import type { Settings } from "./settings.mjs";
import type { VideoSpec } from "./storyboard.mjs";
import type { Format } from "./timeline.mjs";

export type ClaimStatus = "supported" | "qualified" | "insufficient" | "excluded";
export type Source = { url: string; title: string; passage: string; supports: string; kind: "primary" | "authoritative" | "secondary"; accessed: "fetched" | "search-result" };
export type ResearchClaim = { id: string; text: string; status: ClaimStatus; qualification?: string; note?: string; importance?: number; sources: Source[] };

export type Research = {
  version?: number;
  inputHash?: string;
  promptVersion?: number;
  at?: string;
  topic?: { slug: string; title: string; angle?: string };
  qualification: {
    verdict: "proceed" | "narrow" | "reject";
    centralQuestion: string;
    angles: { angle: string; question?: string; strengths?: string; weaknesses?: string; evidence?: string }[];
    selectedAngle: string;
    reason: string;
    scores: Record<"curiosity" | "depth" | "evidence" | "misconceptions" | "demonstrations" | "musical", number>;
    supportedMinutes: { min: number; max: number };
    shortInsight: string;
  };
  audience: string;
  mechanism: string;
  thesis: { statement: string; mentalModel: string; claimIds: string[] };
  prerequisites: { term: string; definition: string }[];
  claims: ResearchClaim[];
  misconceptions: { misconception: string; correction: string; claimIds?: string[] }[];
  examples: { kind?: string; description: string; claimIds?: string[]; caveat?: string }[];
  insights: { insight: string; claimIds?: string[]; why?: string }[];
  uncertainties: string[];
  exclusions?: { claim: string; reason: string }[];
  sourceQuality: string;
};

export type Beat = { id: string; role: string; point: string; claimIds: string[]; seconds: number; visual?: string };
export type Outline = {
  format?: Format;
  inputHash?: string;
  researchHash?: string;
  durationKey?: string;
  at?: string;
  openingQuestion: string;
  understandingChange: string;
  structure: string;
  prerequisites?: string[];
  beats: Beat[];
  keyExample?: { description: string; claimIds?: string[] };
  complication?: { description: string; claimIds?: string[] };
  conclusion: string;
  longFormOnly?: string[];
  coreInsight?: string;
  chorus?: { line: string; reinforces: string } | null;
  fit: { verdict: "fits" | "too-thin" | "too-much"; note: string };
};

export type ReviewReply = {
  scores: Record<string, number>;
  blocking: { shot?: string; problem: string }[];
  findings: { shot?: string; criterion?: string; severity?: "major" | "minor"; problem: string; fix: string }[];
  summary: string;
};
export type Verdict = { pass: boolean; average: number; reasons: string[] };

export declare const PROMPT_VERSIONS: Record<"research" | "outline" | "script" | "review" | "factcheck" | "direct", number>;
export declare const CLAIM_STATUSES: ClaimStatus[];
export declare const USABLE: ClaimStatus[];
export declare const SOURCE_KINDS: string[];
export declare const BEAT_ROLES: string[];
export declare const STRUCTURES: string[];
export declare const RUBRIC: Record<string, string>;
export declare const PASS_RULES: { minEach: number; minAverage: number; critical: Record<string, number> };
export declare function claimMap(research: Research | null | undefined): Map<string, ResearchClaim>;
export declare function validateResearch(r: unknown): string[];
export declare function researchBlockers(r: Research): string[];
export declare function durationSupport(r: Research, settings: Settings): Record<Format, { ok: boolean; note: string }>;
export declare function validateOutline(o: unknown, research: Research, settings: Settings | null, format: Format): string[];
export declare function outlineBlockers(o: Outline): string[];
export declare function validateReview(r: unknown, shotIds?: string[]): string[];
export declare function reviewVerdict(r: ReviewReply): Verdict;
export declare function scriptText(spec: VideoSpec): { id: string; section: string; n: string | null; l: string | null }[];
