export type EvidenceClaim = {
  id: string; text: string; status: "supported" | "qualified" | "insufficient" | "excluded";
  qualification: string | null; note: string | null; importance: number | null;
  confidence: "high" | "qualified" | "low"; verificationStatus: string;
  sourceIds: string[]; provenance: { stage: string; topic: string | null; researchPromptVersion: number | null };
};
export type EvidenceSource = {
  id: string; url: string; title: string; passage: string; supports: string;
  kind: "primary" | "authoritative" | "secondary"; verificationStatus: "fetched" | "search-result";
  claimIds: string[]; provenance: { stage: string; topic: string | null; researchPromptVersion: number | null };
};
export type EvidenceStore = {
  version: 1; researchHash: string | null; createdAt: string | null;
  provenance: { stage: string; topic: string | null; researchPromptVersion: number | null };
  claims: EvidenceClaim[]; sources: EvidenceSource[];
};
export declare const EVIDENCE_VERSION: 1;
export declare function sourceId(source: Pick<EvidenceSource, "url" | "title" | "passage">): string;
export declare function evidenceFromResearch(research: any, options?: { researchHash?: string; promptVersion?: number; topic?: string; at?: string }): EvidenceStore;
export declare function validateEvidenceStore(store: unknown): string[];
export declare function evidenceForClaims(store: EvidenceStore, claimIds: string[], options?: { sourceLimit?: number }): { version: 1; claims: EvidenceClaim[]; sources: EvidenceSource[] };
