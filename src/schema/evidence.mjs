// Canonical, compact evidence representation shared by editorial stages.
// Claim IDs are authored once in research; source IDs are deterministic from
// their URL and passage so references survive retries and resumes.
import { createHash } from "node:crypto";

export const EVIDENCE_VERSION = 1;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isText = (value) => typeof value === "string" && value.trim().length > 0;
const hash = (value) => createHash("sha256").update(value).digest("hex").slice(0, 16);

export function sourceId(source) {
  return `src-${hash(`${source.url}\n${source.title}\n${source.passage}`)}`;
}

export function evidenceFromResearch(research, { researchHash, promptVersion, topic, at } = {}) {
  const sourceMap = new Map();
  const claims = (research?.claims ?? []).map((claim) => {
    const sourceIds = [];
    for (const source of claim.sources ?? []) {
      const id = sourceId(source);
      sourceIds.push(id);
      const prior = sourceMap.get(id);
      sourceMap.set(id, {
        id,
        url: source.url,
        title: source.title,
        passage: source.passage,
        supports: source.supports,
        kind: source.kind,
        verificationStatus: source.accessed,
        claimIds: [...new Set([...(prior?.claimIds ?? []), claim.id])],
        provenance: { stage: "research", topic: topic ?? research.topic?.slug ?? null, researchPromptVersion: promptVersion ?? research.promptVersion ?? null },
      });
    }
    const confidence = claim.status === "supported" ? "high" : claim.status === "qualified" ? "qualified" : "low";
    return {
      id: claim.id,
      text: claim.text,
      status: claim.status,
      qualification: claim.qualification ?? null,
      note: claim.note ?? null,
      importance: claim.importance ?? null,
      confidence,
      verificationStatus: claim.status,
      sourceIds: [...new Set(sourceIds)],
      provenance: { stage: "research", topic: topic ?? research.topic?.slug ?? null, researchPromptVersion: promptVersion ?? research.promptVersion ?? null },
    };
  });
  return {
    version: EVIDENCE_VERSION,
    researchHash: researchHash ?? null,
    createdAt: at ?? research.at ?? null,
    provenance: { stage: "research", topic: topic ?? research.topic?.slug ?? null, researchPromptVersion: promptVersion ?? research.promptVersion ?? null },
    claims,
    sources: [...sourceMap.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export function validateEvidenceStore(store) {
  const problems = [];
  if (!isObject(store)) return ["evidence store must be an object"];
  if (store.version !== EVIDENCE_VERSION) problems.push(`evidence version must be ${EVIDENCE_VERSION}`);
  if (!Array.isArray(store.claims) || !Array.isArray(store.sources)) return [...problems, "evidence claims and sources must be lists"];
  const sourceIds = new Set();
  const sourceById = new Map();
  for (const source of store.sources) {
    if (!isObject(source) || !isText(source.id) || !/^https?:\/\//.test(source.url ?? "") || !isText(source.title) || !isText(source.passage) || !isText(source.supports)) {
      problems.push("each evidence source needs a stable id, URL, title, passage and supported point");
      continue;
    }
    if (sourceIds.has(source.id)) problems.push(`duplicate evidence source id ${source.id}`);
    sourceIds.add(source.id);
    sourceById.set(source.id, source);
    if (!Array.isArray(source.claimIds) || source.claimIds.some((id) => typeof id !== "string")) problems.push(`${source.id}: claimIds must be a list`);
    if (!["primary", "authoritative", "secondary"].includes(source.kind) || !["fetched", "search-result"].includes(source.verificationStatus)) problems.push(`${source.id}: source kind or verification status is invalid`);
  }
  const claimIds = new Set();
  for (const claim of store.claims) {
    if (!isObject(claim) || !isText(claim.id) || !isText(claim.text)) {
      problems.push("each evidence claim needs a stable id and text");
      continue;
    }
    if (claimIds.has(claim.id)) problems.push(`duplicate evidence claim id ${claim.id}`);
    claimIds.add(claim.id);
    if (!["supported", "qualified", "insufficient", "excluded"].includes(claim.status) || !["high", "qualified", "low"].includes(claim.confidence)) problems.push(`${claim.id}: evidence status or confidence is invalid`);
    if (!Array.isArray(claim.sourceIds) || claim.sourceIds.some((id) => !sourceIds.has(id))) problems.push(`${claim.id}: sourceIds contain a missing source`);
    else for (const sourceId of claim.sourceIds) if (!sourceById.get(sourceId)?.claimIds?.includes(claim.id)) problems.push(`${claim.id}: source ${sourceId} does not link back to this claim`);
    if (!isText(claim.verificationStatus) || !isText(claim.confidence) || !isObject(claim.provenance)) problems.push(`${claim.id}: verification status, confidence and provenance are required`);
  }
  const claimsById = new Map(store.claims.map((claim) => [claim.id, claim]));
  for (const source of store.sources) for (const id of source.claimIds ?? []) {
    if (!claimIds.has(id)) problems.push(`${source.id}: references unknown claim ${id}`);
    else if (!claimsById.get(id)?.sourceIds?.includes(source.id)) problems.push(`${source.id}: claim ${id} does not link back to this source`);
  }
  return problems;
}

/** Return only evidence that a stage can use; retain source passages and caveats. */
export function evidenceForClaims(store, claimIds, { sourceLimit = Infinity } = {}) {
  const requested = new Set(claimIds ?? []);
  const claims = (store?.claims ?? []).filter((claim) => requested.has(claim.id));
  const allSources = new Map((store?.sources ?? []).map((source) => [source.id, source]));
  const allowedSources = new Set();
  for (const claim of claims) {
    let count = 0;
    for (const id of claim.sourceIds ?? []) if (allSources.has(id) && count++ < sourceLimit) allowedSources.add(id);
  }
  return {
    version: EVIDENCE_VERSION,
    claims: claims.map(({ id, text, status, qualification, note, importance, confidence, verificationStatus, provenance, sourceIds: refs }) => ({
      id, text, status, qualification, note, importance, confidence, verificationStatus, provenance,
      sourceIds: refs.filter((ref) => allowedSources.has(ref)),
    })),
    sources: [...allowedSources].map((id) => allSources.get(id)).filter(Boolean).map((source) => ({
      ...source,
      claimIds: source.claimIds.filter((id) => requested.has(id)),
    })),
  };
}
