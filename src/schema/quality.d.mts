export type QualityCheck = { id: string; status: "pass" | "fail" | "unavailable"; severity: "critical" | "essential" | "informational"; detail: string };
export type BenchmarkResult = {
  slug: string; name: string; status: "pass" | "fail" | "incomplete";
  passed: number; failed: number; unavailable: number;
  coverage: number | null; essentialCoverage: number | null;
  checks: QualityCheck[];
};
export declare function deterministicQualityChecks(artifacts: Record<string, any>): QualityCheck[];
export declare function evaluateBenchmarkCase(caseDef: Record<string, any>, artifacts: Record<string, any>): BenchmarkResult;
