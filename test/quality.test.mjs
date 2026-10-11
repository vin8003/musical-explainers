// Deterministic quality gates and concept-based benchmark criteria.
import assert from "node:assert/strict";
import { test } from "node:test";
import { evidenceFromResearch } from "../src/schema/evidence.mjs";
import { evaluateBenchmarkCase } from "../src/schema/quality.mjs";
import { DEFAULT_SETTINGS } from "../src/schema/settings.mjs";
import { validDossier } from "./fixtures/dossier.mjs";

function artifacts() {
  const research = validDossier();
  const evidence = evidenceFromResearch(research, { researchHash: "r1", promptVersion: 1, topic: "packets", at: "2026-01-01T00:00:00Z" });
  const narration = "Packets carry an address; routers send each piece toward its destination, with no dedicated line reserved.";
  const spec = {
    schemaVersion: 2,
    slug: "packet-demo",
    title: "Packets",
    format: "main",
    world: "night",
    brief: { audience: "curious viewers", learningGoal: "explain routing", hook: "How does a message travel?" },
    music: { bpm: 120, key: "C", mode: "major", mood: "bright" },
    shots: [{ id: "segment-1", beatId: "beat-1", section: "intro", purpose: "explain routing", narration, claims: ["c1"], visual: { type: "kinetic", style: "stack" } }],
  };
  const settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  settings.formats.main = { targetSeconds: 8, minSeconds: 7, maxSeconds: 9 };
  const review = {
    scores: { accuracy: 5, clarity: 4, progression: 4 },
    verdict: { pass: true, average: 4.3, reasons: [] },
  };
  return {
    research,
    evidence,
    specs: { main: spec },
    outlines: { main: { beats: [{ id: "beat-1" }] } },
    reviews: { main: review },
    sources: { claims: [{ claim: narration, verdict: "ok", sources: [{ url: "https://example.org/source-1" }] }] },
    settings,
    assetReport: { missingRequired: 0 },
    qa: { status: "pass", summary: "media synchronized", media: { main: { seconds: 8, expectedSeconds: 8 } } },
  };
}

const caseDef = {
  slug: "packet-demo",
  name: "Packets and local routing",
  formats: ["main"],
  expectedClaims: [{ id: "addressed-packets", claimIds: ["c1"], essential: true }],
  essentialExplanations: [{ id: "destination-address", termsAll: ["packet", "address", "destination"] }],
  knownMisconceptions: [{ id: "reserved-line", correctionTermsAny: ["no dedicated line"] }],
  sourceExpectations: [{ claimId: "c1", minSources: 1, kindsAny: ["authoritative"], verificationStatusesAny: ["fetched"] }],
  editorialAcceptance: { minAverage: 4, critical: { accuracy: 4, clarity: 4 } },
};

test("benchmark measures concepts, evidence quality, editorial acceptance, duration and media without a fixed script", () => {
  const result = evaluateBenchmarkCase(caseDef, artifacts());
  assert.equal(result.status, "pass");
  assert.equal(result.coverage, 1);
  assert.equal(result.essentialCoverage, 1);
  assert.ok(result.checks.every((item) => item.status === "pass"), result.checks.filter((item) => item.status !== "pass").map((item) => `${item.id}: ${item.detail}`).join("\n"));
});

test("quality gates fail on broken evidence links, unsupported review, missing assets and unsynchronized media", () => {
  const input = artifacts();
  input.specs.main.shots[0].claims = ["ghost-claim"];
  input.reviews.main.verdict.pass = false;
  input.reviews.main.verdict.reasons = ["accuracy failed"];
  input.assetReport.missingRequired = 1;
  input.qa.media.main.seconds = 10;
  const result = evaluateBenchmarkCase(caseDef, input);
  assert.equal(result.status, "fail");
  const failed = new Set(result.checks.filter((item) => item.status === "fail").map((item) => item.id));
  assert.ok(failed.has("main.evidence-references"));
  assert.ok(failed.has("main.editorial-review"));
  assert.ok(failed.has("main.assets"));
  assert.ok(failed.has("media.synchronization"));
});
