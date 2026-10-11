// Deterministic quality and benchmark checks. The benchmark records expected
// learning outcomes and evidence properties; it never prescribes a script.
import { USABLE, researchBlockers } from "./editorial.mjs";
import { checkDuration, isBlocking } from "./settings.mjs";
import { estimateRuntime } from "./timeline.mjs";
import { textOf, validateSpec } from "./storyboard.mjs";
import { validateEvidenceStore } from "./evidence.mjs";

const norm = (value) => String(value ?? "").toLowerCase().replace(/\s+/g, " ").trim();
const includesAll = (haystack, needles = []) => needles.every((needle) => haystack.includes(norm(needle)));
const includesAny = (haystack, needles = []) => needles.length === 0 || needles.some((needle) => haystack.includes(norm(needle)));

function check(id, status, detail, severity = "essential") {
  return { id, status, severity, detail };
}

/** Schema, linkage, duration, asset, fact-check, and final-media checks with no model calls. */
export function deterministicQualityChecks({ slug, specs = {}, outlines = {}, research = null, evidence = null, reviews = {}, sources = null, settings, assetReport = null, qa = null }) {
  const checks = [];
  const usable = new Set((evidence?.claims ?? []).filter((claim) => USABLE.includes(claim.status)).map((claim) => claim.id));
  const known = new Set((evidence?.claims ?? []).map((claim) => claim.id));
  for (const [format, spec] of Object.entries(specs)) {
    if (!spec) { checks.push(check(`${format}.storyboard`, "unavailable", "no storyboard")); continue; }
    const schema = validateSpec(spec, { slug });
    checks.push(check(`${format}.schema`, schema.length ? "fail" : "pass", schema.length ? schema.slice(0, 5).join("; ") : "storyboard schema is valid", "critical"));
    const required = ["audience", "learningGoal", "hook"].filter((field) => !String(spec.brief?.[field] ?? "").trim());
    checks.push(check(`${format}.required-fields`, required.length ? "fail" : "pass", required.length ? `missing brief.${required.join(", brief.")}` : "audience, learning goal, and hook are present", "critical"));
    const limit = format === "short" ? 32 : 45;
    const long = spec.shots.filter((shot) => (shot.narration?.trim().split(/\s+/).filter(Boolean).length ?? 0) > limit);
    checks.push(check(`${format}.word-count`, long.length ? "fail" : "pass", long.length ? `${long.length} segment(s) exceed ${limit} words: ${long.map((shot) => shot.id).join(", ")}` : `all narration segments are within ${limit} words`, "critical"));
    const outline = outlines[format];
    if (outline) {
      const beatIds = new Set((outline.beats ?? []).map((beat) => beat.id));
      const orphaned = spec.shots.filter((shot) => !shot.beatId || !beatIds.has(shot.beatId));
      checks.push(check(`${format}.beat-references`, orphaned.length ? "fail" : "pass", orphaned.length ? `segments without a valid outline beat: ${orphaned.map((shot) => shot.id).join(", ")}` : "every script segment references an outline beat", "critical"));
    } else checks.push(check(`${format}.beat-references`, "unavailable", "no outline artifact"));
    const refs = spec.shots.flatMap((shot) => (shot.claims ?? []).map((id) => ({ shot: shot.id, id })));
    if (refs.length && evidence) {
      const invalid = refs.filter(({ id }) => !known.has(id) || !usable.has(id));
      checks.push(check(`${format}.evidence-references`, invalid.length ? "fail" : "pass", invalid.length ? `unknown or unusable claims: ${invalid.map((x) => `${x.shot}:${x.id}`).join(", ")}` : `${refs.length} claim references resolve to usable evidence`, "critical"));
      const evidenceIssues = validateEvidenceStore(evidence);
      checks.push(check(`${format}.evidence-store`, evidenceIssues.length ? "fail" : "pass", evidenceIssues.length ? evidenceIssues.slice(0, 4).join("; ") : "canonical evidence passes schema and provenance checks", "critical"));
    } else checks.push(check(`${format}.evidence-references`, evidence ? "pass" : "unavailable", evidence ? "the script has no factual claim references" : "canonical evidence is unavailable", "critical"));
    if (research) {
      const blockers = researchBlockers(research);
      checks.push(check(`${format}.research-gate`, blockers.length ? "fail" : "pass", blockers.length ? blockers.slice(0, 4).join("; ") : "research thesis and evidence meet the research gate", "critical"));
    } else checks.push(check(`${format}.research-gate`, "unavailable", "no research artifact"));
    if (settings) {
      const estimate = estimateRuntime(spec, format, settings.narration.wordsPerMinute);
      const verdict = checkDuration(estimate.seconds, settings, format);
      checks.push(check(`${format}.duration`, isBlocking(verdict.verdict) ? "fail" : "pass", `${estimate.seconds.toFixed(1)}s estimated; ${verdict.message}`, "critical"));
    } else checks.push(check(`${format}.duration`, "unavailable", "duration settings are unavailable", "critical"));
    const texts = textOf(spec).flatMap((item) => [item.narration, item.lyric, item.headline, ...item.labels].filter(Boolean));
    const verdictByText = new Map((sources?.claims ?? []).map((claim) => [claim.claim, claim.verdict]));
    const unchecked = [...new Set(texts)].filter((text) => verdictByText.get(text) !== "ok");
    checks.push(check(`${format}.fact-check-coverage`, unchecked.length ? (sources ? "fail" : "unavailable") : "pass", unchecked.length ? `${unchecked.length} text item(s) lack an ok verdict` : `${new Set(texts).size} unique text item(s) have ok verdicts`, "critical"));
    if (assetReport) checks.push(check(`${format}.assets`, assetReport.missingRequired ? "fail" : "pass", assetReport.missingRequired ? `${assetReport.missingRequired} required asset(s) are missing` : "required assets exist", "critical"));
    else checks.push(check(`${format}.assets`, "unavailable", "asset report is unavailable", "critical"));
    const review = reviews[format];
    if (review) checks.push(check(`${format}.editorial-review`, review.verdict?.pass ? "pass" : "fail", review.verdict?.pass ? `passed with average ${review.verdict.average}` : (review.verdict?.reasons ?? []).slice(0, 3).join("; "), "critical"));
    else checks.push(check(`${format}.editorial-review`, "unavailable", "no independent editorial review artifact", "critical"));
  }
  if (qa) {
    const syncFailures = Object.entries(qa.media ?? {}).filter(([, media]) => Math.abs((media.seconds ?? 0) - (media.expectedSeconds ?? 0)) > 0.25);
    const qaFailure = qa.status === "fail" || (qa.findings ?? []).some((finding) => finding.severity === "fail");
    checks.push(check("media.synchronization", syncFailures.length || qaFailure ? "fail" : "pass", syncFailures.length ? syncFailures.map(([format, media]) => `${format}: ${media.seconds}s vs ${media.expectedSeconds}s`).join("; ") : qa.summary ?? "rendered media matches the approved timeline", "critical"));
  } else checks.push(check("media.synchronization", "unavailable", "no final QA report"));
  return checks;
}

function scriptText(specs) {
  return norm(Object.values(specs ?? {}).filter(Boolean).flatMap((spec) => textOf(spec).flatMap((item) => [item.narration, item.lyric, item.headline, ...item.labels])).filter(Boolean).join(" "));
}

function sourceUrls(sources, textContains) {
  return (sources?.claims ?? []).filter((claim) => norm(claim.claim).includes(norm(textContains))).flatMap((claim) => claim.sources ?? []).map((source) => typeof source === "string" ? source : source.url).filter(Boolean);
}

/** Evaluate one suite case against persisted artifacts. Missing evidence is visible as unknown. */
export function evaluateBenchmarkCase(caseDef, artifacts) {
  const checks = deterministicQualityChecks({ ...artifacts, slug: caseDef.slug });
  const content = scriptText(artifacts.specs);
  const allFormats = Object.entries(artifacts.specs ?? {}).filter(([, spec]) => spec).map(([format]) => format);
  const expectedClaims = caseDef.expectedClaims ?? [];
  let expectedCount = 0, claimHits = 0, essentialCount = 0, essentialHits = 0;
  for (const item of expectedClaims) {
    const itemFormats = item.formats ?? caseDef.formats ?? allFormats;
    const relevantSpecs = itemFormats.map((format) => artifacts.specs?.[format]).filter(Boolean);
    if (!relevantSpecs.length) {
      checks.push(check(`benchmark.claim.${item.id}`, "unavailable", "no requested storyboard is available"));
      continue;
    }
    const hit = item.claimIds?.length
      ? relevantSpecs.some((spec) => spec.shots.some((shot) => (shot.claims ?? []).some((id) => item.claimIds.includes(id))))
      : includesAll(scriptText(Object.fromEntries(itemFormats.map((format) => [format, artifacts.specs[format]]))), item.termsAll) && includesAny(scriptText(Object.fromEntries(itemFormats.map((format) => [format, artifacts.specs[format]]))), item.termsAny);
    expectedCount++;
    if (item.essential) essentialCount++;
    if (hit) { claimHits++; if (item.essential) essentialHits++; }
    checks.push(check(`benchmark.claim.${item.id}`, hit ? "pass" : "fail", hit ? "expected concept is explained" : "expected concept is missing from the script", item.essential ? "critical" : "informational"));
  }
  for (const item of caseDef.essentialExplanations ?? []) {
    const formats = item.formats ?? caseDef.formats ?? allFormats;
    const selected = scriptText(Object.fromEntries(formats.map((format) => [format, artifacts.specs?.[format]])));
    const hit = includesAll(selected, item.termsAll) && includesAny(selected, item.termsAny);
    checks.push(check(`benchmark.explanation.${item.id}`, hit ? "pass" : "fail", hit ? "essential explanation is present" : "essential explanation is missing", "critical"));
  }
  for (const item of caseDef.knownMisconceptions ?? []) {
    const accepted = item.correctionTermsAll ? includesAll(content, item.correctionTermsAll) : includesAny(content, item.correctionTermsAny);
    checks.push(check(`benchmark.misconception.${item.id}`, accepted ? "pass" : "fail", accepted ? "the known misconception is corrected" : "the misconception's correction is not explained", "critical"));
  }
  for (const expectation of caseDef.sourceExpectations ?? []) {
    const evidenceSources = expectation.claimId ? (artifacts.evidence?.sources ?? []).filter((source) => source.claimIds?.includes(expectation.claimId)) : [];
    const factSources = expectation.textContains ? sourceUrls(artifacts.sources, expectation.textContains) : [];
    const hits = expectation.claimId
      ? evidenceSources.filter((source) => (!expectation.kindsAny || expectation.kindsAny.includes(source.kind)) && (!expectation.verificationStatusesAny || expectation.verificationStatusesAny.includes(source.verificationStatus))).length
      : factSources.filter((url) => (expectation.domainsAny ?? []).some((domain) => url.includes(domain))).length;
    const passed = hits >= (expectation.minSources ?? 1);
    checks.push(check(`benchmark.source.${expectation.claimId ?? expectation.textContains}`, passed ? "pass" : artifacts.evidence || artifacts.sources ? "fail" : "unavailable", `${hits} qualifying source(s); expected ${expectation.minSources ?? 1}`, "critical"));
  }
  const acceptance = caseDef.editorialAcceptance ?? {};
  for (const format of caseDef.formats ?? allFormats) {
    const review = artifacts.reviews?.[format];
    if (!review) { checks.push(check(`benchmark.editorial.${format}`, "unavailable", "review artifact is unavailable", "critical")); continue; }
    const pass = Boolean(review.verdict?.pass) && (review.verdict?.average ?? 0) >= (acceptance.minAverage ?? 3.8) && Object.entries(acceptance.critical ?? {}).every(([criterion, minimum]) => (review.scores?.[criterion] ?? 0) >= minimum);
    checks.push(check(`benchmark.editorial.${format}`, pass ? "pass" : "fail", `review ${review.verdict?.pass ? "passed" : "failed"}; average ${review.verdict?.average ?? "unknown"}`, "critical"));
  }
  const passed = checks.filter((item) => item.status === "pass").length;
  const failed = checks.filter((item) => item.status === "fail").length;
  const unavailable = checks.filter((item) => item.status === "unavailable").length;
  return {
    slug: caseDef.slug,
    name: caseDef.name,
    status: failed ? "fail" : unavailable ? "incomplete" : "pass",
    passed, failed, unavailable,
    coverage: expectedCount ? claimHits / expectedCount : null,
    essentialCoverage: essentialCount ? essentialHits / essentialCount : null,
    checks,
  };
}
