// Editorial rules: research dossiers, outlines and the review verdict.
import assert from "node:assert/strict";
import { test } from "node:test";
import { durationSupport, researchBlockers, reviewVerdict, validateOutline, validateResearch, validateReview } from "../src/schema/editorial.mjs";
import { evidenceForClaims, evidenceFromResearch, validateEvidenceStore } from "../src/schema/evidence.mjs";
import { DEFAULT_SETTINGS } from "../src/schema/settings.mjs";

const src = (n, accessed = "fetched") => ({ url: `https://example.org/${n}`, title: `S${n}`, passage: "p", supports: "s", kind: "primary", accessed });
const dossier = () => ({
  qualification: { verdict: "proceed", centralQuestion: "q?", angles: [{ angle: "a" }], selectedAngle: "a", reason: "r", scores: { curiosity: 4, depth: 4, evidence: 4, misconceptions: 3, demonstrations: 3, musical: 3 }, supportedMinutes: { min: 3, max: 9 }, shortInsight: "i" },
  audience: "all", mechanism: "m",
  thesis: { statement: "t", mentalModel: "mm", claimIds: ["c1", "c2"] },
  prerequisites: [],
  claims: Array.from({ length: 6 }, (_, i) => ({ id: `c${i + 1}`, text: `claim ${i + 1}`, status: "supported", sources: [src(i + 1)] })),
  misconceptions: [{ misconception: "x", correction: "y", claimIds: ["c3"] }],
  examples: [{ description: "e1", claimIds: ["c4"] }, { description: "e2" }],
  insights: [{ insight: "a" }, { insight: "b" }, { insight: "c" }],
  uncertainties: [], sourceQuality: "good",
});

test("a complete dossier validates", () => assert.deepEqual(validateResearch(dossier()), []));

test("canonical evidence keeps stable claim/source IDs, passage, qualifications, confidence, and provenance", () => {
  const research = dossier();
  research.claims[0].status = "qualified";
  research.claims[0].qualification = "only in the tested context";
  const store = evidenceFromResearch(research, { researchHash: "research-hash", promptVersion: 4, topic: "sample" });
  const again = evidenceFromResearch(research, { researchHash: "research-hash", promptVersion: 4, topic: "sample" });
  assert.equal(store.claims[0].id, "c1");
  assert.equal(store.claims[0].confidence, "qualified");
  assert.equal(store.claims[0].qualification, "only in the tested context");
  assert.equal(store.claims[0].provenance.topic, "sample");
  assert.equal(store.sources[0].id, again.sources[0].id);
  assert.ok(store.sources.some((source) => source.url === "https://example.org/1" && source.passage === "p" && source.verificationStatus === "fetched"));
  assert.deepEqual(validateEvidenceStore(store), []);
  const brokenLink = structuredClone(store);
  brokenLink.claims[0].sourceIds = [];
  assert.ok(validateEvidenceStore(brokenLink).some((problem) => /does not link back/.test(problem)));
  const compact = evidenceForClaims(store, ["c1"]);
  assert.deepEqual(compact.claims.map((claim) => claim.id), ["c1"]);
  assert.ok(compact.sources.length === 1 && compact.sources[0].claimIds.every((id) => id === "c1"));
  assert.ok(!JSON.stringify(compact).includes('"id": "c6"'));
});

test("a supported claim must rest on a source that was actually opened", () => {
  const d = dossier();
  d.claims[0].sources = [src(1, "search-result")];
  assert.ok(validateResearch(d).some((p) => /actually opened|fetched/.test(p)));
  d.claims[0].status = "qualified";
  d.claims[0].qualification = "only in TCP";
  assert.deepEqual(validateResearch(d), []);
});

test("claims need a URL, passage, kind and provenance; insufficient/excluded claims need a reason", () => {
  const d = dossier();
  d.claims[1].sources = [{ url: "not-a-url", title: "", passage: "", supports: "", kind: "blog", accessed: "maybe" }];
  const p = validateResearch(d).join("\n");
  for (const re of [/url must be an http/, /title is required/, /passage/, /supports/, /kind must be/, /accessed must be/]) assert.match(p, re);
  const e = dossier();
  e.claims[2].status = "insufficient";
  assert.ok(validateResearch(e).some((x) => /say why/.test(x)));
});

test("references to unknown claims are rejected", () => {
  const d = dossier();
  d.examples[0].claimIds = ["nope"];
  assert.ok(validateResearch(d).some((p) => /unknown claim id "nope"/.test(p)));
});

test("an unsupported central thesis blocks the content; so does a rejected topic or too little evidence", () => {
  const d = dossier();
  d.claims[1].status = "insufficient";
  assert.match(researchBlockers(d).join(), /central thesis rests on claim/);
  const r = dossier();
  r.qualification.verdict = "reject";
  assert.match(researchBlockers(r).join(), /rejected/);
  const thin = dossier();
  thin.claims = thin.claims.slice(0, 3);
  assert.match(researchBlockers(thin).join(), /Only 3 usable/);
  assert.deepEqual(researchBlockers(dossier()), []);
});

test("a topic that supports only 3-9 minutes can't fill a configured landscape minimum above that", () => {
  const d = dossier();
  assert.equal(durationSupport(d, DEFAULT_SETTINGS).main.ok, true);
  const long = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  long.formats.main = { targetSeconds: 900, minSeconds: 720, maxSeconds: 1200 };
  const r = durationSupport(d, long);
  assert.equal(r.main.ok, false);
  assert.match(r.main.note, /without padding/);
  assert.equal(r.short.ok, true);
});

const outline = (format) => {
  const long = format === "main";
  const roles = long ? ["hook", "setup", "mechanism", "example", "complication", "resolution"] : ["hook", "mechanism", "resolution"];
  return {
    openingQuestion: "q", understandingChange: "u", structure: "causal-chain", fit: { verdict: "fits", note: "ok" }, conclusion: "c", coreInsight: "i", longFormOnly: ["x"],
    beats: roles.map((role, i) => ({ id: `b${i}`, role, point: "p", seconds: (long ? 420 : 45) / roles.length, claimIds: ["hook", "resolution"].includes(role) ? [] : ["c1"] })),
  };
};

test("outlines: valid for each format, tied to usable claims, and fitting the configured duration", () => {
  assert.deepEqual(validateOutline(outline("main"), dossier(), DEFAULT_SETTINGS, "main"), []);
  assert.deepEqual(validateOutline(outline("short"), dossier(), DEFAULT_SETTINGS, "short"), []);
  // A 45 s plan is not a landscape video.
  assert.ok(validateOutline(outline("short"), dossier(), DEFAULT_SETTINGS, "main").some((p) => /planned beat lengths add up/.test(p)));
  const o = outline("main");
  o.beats[2].claimIds = ["ghost"];
  assert.ok(validateOutline(o, dossier(), DEFAULT_SETTINGS, "main").some((p) => /unknown claim id/.test(p)));
  const d = dossier();
  d.claims[0].status = "excluded";
  d.claims[0].note = "wrong";
  assert.ok(validateOutline(outline("main"), d, DEFAULT_SETTINGS, "main").some((p) => /can't be used/.test(p)));
});

const scores = (over = {}) => ({ accuracy: 5, clarity: 5, progression: 5, specificity: 4, examples: 4, engagement: 4, memorability: 4, formatFit: 4, music: 4, redundancy: 4, ...over });
const review = (over, blocking = []) => ({ scores: scores(over), blocking, findings: [], summary: "s" });

test("review verdict: a strong script passes", () => assert.equal(reviewVerdict(review()).pass, true));

test("review verdict: a high average cannot buy back a weak critical criterion or a blocking problem", () => {
  const weakClarity = reviewVerdict(review({ clarity: 3 }));
  assert.equal(weakClarity.pass, false);
  assert.match(weakClarity.reasons.join(), /clarity scored 3 \(needs 4\)/);
  assert.ok(weakClarity.average > 4.0);
  const blocked = reviewVerdict(review({}, [{ field: "global", problem: "central claim is unsupported" }]));
  assert.equal(blocked.pass, false);
  assert.match(blocked.reasons.join(), /blocking: central claim/);
  assert.equal(reviewVerdict(review({ redundancy: 2 })).pass, false);
  assert.equal(reviewVerdict(review({ specificity: 3, examples: 3, engagement: 3, memorability: 3, formatFit: 3, music: 3, redundancy: 3 })).pass, false); // average too low
});

test("review replies are validated", () => {
  assert.deepEqual(validateReview(review(), ["a"]), []);
  const bad = { scores: { accuracy: 9 }, blocking: "no", findings: [{ problem: "x" }], summary: "" };
  const p = validateReview(bad, ["a"]).join("\n");
  assert.match(p, /scores\.accuracy must be 0-5/);
  assert.match(p, /blocking must be a list/);
  assert.match(p, /needs problem and fix/);
  // Segment ids and the exact field to repair are checked before accepting a review.
  const ref = { ...review(), findings: [{ segmentId: "ghost", field: "narration", severity: "major", criterion: "clarity", problem: "p", fix: "f" }] };
  assert.deepEqual(validateReview(ref), []);
  assert.match(validateReview(ref, ["a"]).join(), /not a segment id/);
  const untargeted = { ...review(), findings: [{ field: "narration", severity: "major", problem: "p", fix: "f" }] };
  assert.match(validateReview(untargeted, ["a"]).join(), /need a segmentId/);
});

test("the central thesis needs opened, quoted, adequately scoped evidence, not just a 'supported' label", () => {
  // Snippet-only source under a qualified thesis claim: the dossier validates, but it can't carry the video.
  const snippet = dossier();
  snippet.claims[0].status = "qualified";
  snippet.claims[0].qualification = "only in TCP";
  snippet.claims[0].sources = [src(1, "search-result")];
  assert.deepEqual(validateResearch(snippet), []);
  assert.match(researchBlockers(snippet).join(), /Thesis claim "c1" has no opened source/);

  // An over-generalised claim (qualified with no stated limits) is invalid outright.
  const broad = dossier();
  broad.claims[1].status = "qualified";
  assert.ok(validateResearch(broad).some((p) => /needs its qualification/.test(p)));

  // An empty passage means no source text backs the wording.
  const hollow = dossier();
  hollow.claims[0].sources = [{ ...src(1), passage: " " }];
  assert.match(researchBlockers(hollow).join(), /Thesis claim "c1" has no opened source/);

  // A high-importance thesis claim resting only on secondary sources is not enough.
  const secondary = dossier();
  secondary.claims[0].importance = 5;
  secondary.claims[0].sources = [{ ...src(1), kind: "secondary" }];
  assert.match(researchBlockers(secondary).join(), /only secondary sources/);

  assert.deepEqual(researchBlockers(dossier()), []);
});
