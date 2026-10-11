// A valid research dossier (passes validateResearch) for repair tests.
const src = (n) => [{ url: `https://example.org/source-${n}`, title: `Source ${n}`, passage: `Finding ${n}`, supports: `claim ${n}`, kind: "authoritative", accessed: "fetched" }];
export const validDossier = () => ({
  qualification: { verdict: "proceed", centralQuestion: "How does it work?", angles: [{ angle: "The mechanism", question: "How?", strengths: "clear", weaknesses: "none", evidence: "strong" }], selectedAngle: "The mechanism", reason: "best evidence", scores: { curiosity: 4, depth: 4, evidence: 5, misconceptions: 3, demonstrations: 4, musical: 3 }, supportedMinutes: { min: 1, max: 12 }, shortInsight: "The one key idea" },
  audience: "curious people", mechanism: "A causes B, which causes C.",
  thesis: { statement: "A leads to C through B", mentalModel: "a relay", claimIds: ["c1", "c2"] },
  prerequisites: [{ term: "A", definition: "the start" }],
  claims: Array.from({ length: 8 }, (_, i) => ({ id: `c${i + 1}`, text: `Fact number ${i + 1}`, status: "supported", importance: 3, sources: src(i + 1) })),
  misconceptions: [{ misconception: "A causes C directly", correction: "B is in between", claimIds: ["c3"] }],
  examples: [{ kind: "example", description: "a concrete case", claimIds: ["c4"] }, { kind: "analogy", description: "like a relay race", claimIds: ["c5"], caveat: "runners don't copy" }],
  insights: [{ insight: "B matters", claimIds: ["c2"] }, { insight: "order matters", claimIds: ["c6"] }, { insight: "C is the result", claimIds: ["c7"] }],
  uncertainties: [], sourceQuality: "good",
});
