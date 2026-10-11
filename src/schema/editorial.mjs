// Editorial artifacts that come before (and judge) a script: the research
// dossier, the per-format outline and the editorial review. Plain ESM so the
// pipeline, the admin server and the tests share one set of rules.
//
//   specs/<slug>.research.json   qualification + dossier + thesis (format-independent)
//   specs/<slug>.outline.json    { formats: { main, short } } outlines (depend on research + duration)
//   specs/<slug>.review.json     { formats: { main, short } } editorial reviews (depend on the script text)

/** Bump when a prompt changes in a way that should invalidate what it produced. */
export const PROMPT_VERSIONS = { research: 1, outline: 1, script: 2, review: 1, factcheck: 2, direct: 2 };

export const CLAIM_STATUSES = ["supported", "qualified", "insufficient", "excluded"];
/** Claims a script may state (qualified ones only with their qualification). */
export const USABLE = ["supported", "qualified"];
export const SOURCE_KINDS = ["primary", "authoritative", "secondary"];
export const BEAT_ROLES = ["hook", "setup", "prerequisite", "mechanism", "example", "misconception", "complication", "resolution", "recap"];
export const STRUCTURES = ["causal-chain", "worked-example", "investigation", "comparison", "myth-busting", "journey", "other"];

/** Editorial rubric, 0-5 each. Pass rules are in reviewVerdict. */
export const RUBRIC = {
  accuracy: "Accuracy and evidence: material claims are supported by the dossier and appropriately qualified.",
  clarity: "Explanatory clarity: a viewer can understand the mechanism, not merely memorize terminology.",
  progression: "Logical progression: each beat builds on the one before it.",
  specificity: "Specificity and depth: concrete, informative details rather than generic statements.",
  examples: "Examples and mental models: they clarify the mechanism without misleading.",
  engagement: "Narrative engagement: the opening question is resolved and there is a reason to keep watching.",
  memorability: "Memorability: the ending leaves a useful mental model or insight.",
  formatFit: "Format fit: depth, pacing and scope suit the configured duration (no padding, no cramming).",
  music: "Musical contribution: the chorus/lyrics reinforce the mechanism instead of replacing explanation.",
  redundancy: "Redundancy and filler (5 = none): no repetition that adds no understanding.",
};
export const PASS_RULES = {
  minEach: 3,
  minAverage: 3.8,
  /** Criteria that must reach this score on their own: a high average can't buy back an inaccurate or unclear explanation. */
  critical: { accuracy: 4, clarity: 4, progression: 3 },
};

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const isStr = (v) => typeof v === "string" && v.trim().length > 0;
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const URL_RE = /^https?:\/\/[^\s]+$/;

export const claimMap = (research) => new Map((research?.claims ?? []).map((c) => [c.id, c]));

// ---------- research dossier ----------

/** Problems with a research dossier (empty = valid). Blocking content problems are reported by researchBlockers. */
export function validateResearch(r) {
  const p = [];
  if (!isObj(r)) return ["research must be a JSON object"];
  const q = r.qualification;
  if (!isObj(q)) p.push("qualification is required");
  else {
    if (!["proceed", "narrow", "reject"].includes(q.verdict)) p.push("qualification.verdict must be proceed, narrow or reject");
    if (!isStr(q.centralQuestion)) p.push("qualification.centralQuestion is required");
    if (!isStr(q.selectedAngle)) p.push("qualification.selectedAngle is required");
    if (!isStr(q.reason)) p.push("qualification.reason is required (why this angle)");
    if (!Array.isArray(q.angles) || q.angles.length < 1) p.push("qualification.angles must compare at least one angle");
    if (!isObj(q.scores)) p.push("qualification.scores is required");
    else for (const k of ["curiosity", "depth", "evidence", "misconceptions", "demonstrations", "musical"]) if (!isNum(q.scores[k]) || q.scores[k] < 0 || q.scores[k] > 5) p.push(`qualification.scores.${k} must be 0-5`);
    const sup = q.supportedMinutes;
    if (!isObj(sup) || !isNum(sup.min) || !isNum(sup.max) || sup.min <= 0 || sup.min > sup.max) p.push("qualification.supportedMinutes {min, max} must give the range of non-padded explanation this angle supports, in minutes");
    if (!isStr(q.shortInsight)) p.push("qualification.shortInsight is required (the one idea a Short could teach)");
  }
  if (!isStr(r.audience)) p.push("audience is required");
  if (!isStr(r.mechanism)) p.push("mechanism is required (a concise explanation of how it works)");
  const claims = Array.isArray(r.claims) ? r.claims : [];
  if (claims.length < 5) p.push("claims must list at least 5 claims");
  const ids = new Set();
  claims.forEach((c, i) => {
    const at = `claims[${i}]${c?.id ? ` (${c.id})` : ""}`;
    if (!isObj(c)) return p.push(`${at} must be an object`);
    if (!ID_RE.test(c.id ?? "")) p.push(`${at}: id must be kebab-case`);
    else if (ids.has(c.id)) p.push(`${at}: duplicate id`);
    ids.add(c.id);
    if (!isStr(c.text)) p.push(`${at}: text is required`);
    if (!CLAIM_STATUSES.includes(c.status)) p.push(`${at}: status must be one of ${CLAIM_STATUSES.join(", ")}`);
    if (c.status === "qualified" && !isStr(c.qualification)) p.push(`${at}: a qualified claim needs its qualification`);
    if ((c.status === "excluded" || c.status === "insufficient") && !isStr(c.note)) p.push(`${at}: say why it is ${c.status} (note)`);
    const sources = Array.isArray(c.sources) ? c.sources : [];
    if (USABLE.includes(c.status)) {
      if (!sources.length) p.push(`${at}: a ${c.status} claim needs at least one source`);
      if (c.status === "supported" && !sources.some((s) => s?.accessed === "fetched")) p.push(`${at}: a supported claim needs at least one source you actually opened (accessed: "fetched"); otherwise mark it qualified or insufficient`);
    }
    sources.forEach((s, j) => {
      if (!isObj(s) || !URL_RE.test(s.url ?? "")) p.push(`${at}: sources[${j}].url must be an http(s) URL`);
      if (!isStr(s?.title)) p.push(`${at}: sources[${j}].title is required`);
      if (!isStr(s?.passage)) p.push(`${at}: sources[${j}].passage (the relevant finding) is required`);
      if (!isStr(s?.supports)) p.push(`${at}: sources[${j}].supports (what it supports) is required`);
      if (!SOURCE_KINDS.includes(s?.kind)) p.push(`${at}: sources[${j}].kind must be one of ${SOURCE_KINDS.join(", ")}`);
      if (!["fetched", "search-result"].includes(s?.accessed)) p.push(`${at}: sources[${j}].accessed must be "fetched" (you opened the page) or "search-result" (snippet only)`);
    });
  });
  const refs = (list, where) => (list ?? []).forEach((id) => { if (!ids.has(id)) p.push(`${where}: unknown claim id "${id}"`); });
  if (!isObj(r.thesis) || !isStr(r.thesis.statement) || !isStr(r.thesis.mentalModel)) p.push("thesis {statement, mentalModel, claimIds} is required");
  else if (!Array.isArray(r.thesis.claimIds) || !r.thesis.claimIds.length) p.push("thesis.claimIds must name the claims the thesis rests on");
  else refs(r.thesis.claimIds, "thesis");
  if (!Array.isArray(r.prerequisites)) p.push("prerequisites must be a list (may be empty)");
  if (!Array.isArray(r.misconceptions) || !r.misconceptions.length) p.push("misconceptions must list at least one misconception and its correction");
  else r.misconceptions.forEach((m, i) => { if (!isStr(m?.misconception) || !isStr(m?.correction)) p.push(`misconceptions[${i}] needs misconception and correction`); refs(m?.claimIds, `misconceptions[${i}]`); });
  if (!Array.isArray(r.examples) || r.examples.length < 2) p.push("examples must list at least two concrete examples, analogies or demonstrations");
  else r.examples.forEach((e, i) => { if (!isStr(e?.description)) p.push(`examples[${i}].description is required`); refs(e?.claimIds, `examples[${i}]`); });
  if (!Array.isArray(r.insights) || r.insights.length < 3) p.push("insights must list at least three insights, most valuable first");
  else r.insights.forEach((x, i) => { if (!isStr(x?.insight)) p.push(`insights[${i}].insight is required`); refs(x?.claimIds, `insights[${i}]`); });
  if (!Array.isArray(r.uncertainties)) p.push("uncertainties must be a list (may be empty)");
  if (!isStr(r.sourceQuality)) p.push("sourceQuality is required (source quality and limitations)");
  return p;
}

/** Content reasons the pipeline must not write a script from this dossier. */
export function researchBlockers(r) {
  const b = [];
  if (r?.qualification?.verdict === "reject") b.push(`The topic was rejected: ${r.qualification.reason}`);
  const cm = claimMap(r);
  const weak = (r?.thesis?.claimIds ?? []).filter((id) => !USABLE.includes(cm.get(id)?.status));
  if (weak.length) b.push(`The central thesis rests on claim(s) that are not supported: ${weak.join(", ")}`);
  // The thesis is the one thing the whole video leans on: every claim under it needs
  // evidence that was actually opened, a quoted passage, and (if qualified) its limits.
  for (const id of r?.thesis?.claimIds ?? []) {
    const c = cm.get(id);
    if (!c || !USABLE.includes(c.status)) continue;
    const opened = (c.sources ?? []).filter((s) => s?.accessed === "fetched" && isStr(s?.passage) && isStr(s?.supports));
    if (!opened.length) b.push(`Thesis claim "${id}" has no opened source with a quoted passage; snippets and bare links don't count`);
    if (c.status === "qualified" && !isStr(c.qualification)) b.push(`Thesis claim "${id}" is qualified but states no qualification`);
    if ((c.importance ?? 0) >= 4 && !opened.some((s) => s.kind === "primary" || s.kind === "authoritative")) b.push(`Thesis claim "${id}" has only secondary sources; the central claim needs a primary or authoritative one`);
  }
  const usable = (r?.claims ?? []).filter((c) => USABLE.includes(c.status)).length;
  if (usable < 5) b.push(`Only ${usable} usable claim(s): not enough verified material for an explainer`);
  return b;
}

/** Fits the configured durations? Uses the dossier's own estimate of how much non-padded explanation the angle supports. */
export function durationSupport(r, settings) {
  const out = {};
  const sup = r?.qualification?.supportedMinutes;
  for (const f of ["main", "short"]) {
    const d = settings.formats[f];
    if (!sup) out[f] = { ok: true, note: "no estimate" };
    else if (d.minSeconds / 60 > sup.max) out[f] = { ok: false, note: `the angle supports about ${sup.min}-${sup.max} min without padding; the ${f === "main" ? "landscape" : "Short"} minimum is ${(d.minSeconds / 60).toFixed(1)} min` };
    else out[f] = { ok: true, note: `supports ${sup.min}-${sup.max} min` };
  }
  return out;
}

// ---------- outline ----------

export function validateOutline(o, research, settings, format) {
  const p = [];
  if (!isObj(o)) return ["outline must be a JSON object"];
  const cm = claimMap(research);
  for (const k of ["openingQuestion", "understandingChange", "conclusion"]) if (!isStr(o[k])) p.push(`${k} is required`);
  if (!STRUCTURES.includes(o.structure)) p.push(`structure must be one of ${STRUCTURES.join(", ")}`);
  if (!isObj(o.fit) || !["fits", "too-thin", "too-much"].includes(o.fit.verdict) || !isStr(o.fit.note)) p.push("fit {verdict: fits|too-thin|too-much, note} is required");
  const beats = Array.isArray(o.beats) ? o.beats : [];
  const [minBeats, maxBeats] = format === "short" ? [3, 7] : [6, 24];
  if (beats.length < minBeats || beats.length > maxBeats) p.push(`beats must list ${minBeats}-${maxBeats} beats for this format`);
  const ids = new Set();
  let total = 0;
  beats.forEach((b, i) => {
    const at = `beats[${i}]${b?.id ? ` (${b.id})` : ""}`;
    if (!ID_RE.test(b?.id ?? "") || ids.has(b.id)) p.push(`${at}: id must be unique kebab-case`);
    ids.add(b?.id);
    if (!BEAT_ROLES.includes(b?.role)) p.push(`${at}: role must be one of ${BEAT_ROLES.join(", ")}`);
    if (!isStr(b?.point)) p.push(`${at}: point is required`);
    if (!isNum(b?.seconds) || b.seconds <= 0) p.push(`${at}: seconds (planned length) is required`);
    else total += b.seconds;
    const claims = Array.isArray(b?.claimIds) ? b.claimIds : [];
    if (!claims.length && !["hook", "recap", "resolution"].includes(b?.role)) p.push(`${at}: name the research claims this beat rests on (claimIds)`);
    for (const id of claims) {
      const c = cm.get(id);
      if (!c) p.push(`${at}: unknown claim id "${id}"`);
      else if (!USABLE.includes(c.status)) p.push(`${at}: claim "${id}" is ${c.status} in the research and can't be used`);
    }
  });
  if (!beats.some((b) => b?.role === "mechanism")) p.push("at least one beat must explain the mechanism");
  if (format === "main") {
    if (!beats.some((b) => b?.role === "example")) p.push("the landscape outline needs a worked example beat");
    if (!beats.some((b) => b?.role === "complication" || b?.role === "misconception")) p.push("the landscape outline needs a complication or misconception beat");
    if (!Array.isArray(o.longFormOnly)) p.push("longFormOnly must list the concepts that belong only in the landscape video");
  }
  if (format === "short" && !isStr(o.coreInsight)) p.push("coreInsight (the one idea the Short teaches) is required");
  if (o.chorus != null && (!isObj(o.chorus) || !isStr(o.chorus.line) || !isStr(o.chorus.reinforces))) p.push("chorus must be null or {line, reinforces}");
  if (settings) {
    const d = settings.formats[format];
    if (total && (total < d.minSeconds || total > d.maxSeconds)) p.push(`planned beat lengths add up to ${Math.round(total)}s; they must fit ${d.minSeconds}-${d.maxSeconds}s (target ${d.targetSeconds}s)`);
  }
  return p;
}

/** The outline itself says the topic can't fill the format honestly. */
export function outlineBlockers(o) {
  if (o?.fit?.verdict === "too-thin") return [`The outline says this angle is too thin for the configured duration: ${o.fit.note}`];
  return [];
}

// ---------- editorial review ----------

export function validateReview(r, shotIds) {
  const p = [];
  if (!isObj(r)) return ["review must be a JSON object"];
  if (!isObj(r.scores)) p.push("scores is required");
  else for (const k of Object.keys(RUBRIC)) if (!isNum(r.scores[k]) || r.scores[k] < 0 || r.scores[k] > 5) p.push(`scores.${k} must be 0-5`);
  if (!Array.isArray(r.blocking)) p.push("blocking must be a list (empty when nothing blocks)");
  else r.blocking.forEach((b, i) => { if (!isStr(b?.problem)) p.push(`blocking[${i}].problem is required`); });
  if (!Array.isArray(r.findings)) p.push("findings must be a list");
  else r.findings.forEach((f, i) => {
    if (!isStr(f?.problem) || !isStr(f?.fix)) p.push(`findings[${i}] needs problem and fix`);
    if (f?.criterion != null && !(f.criterion in RUBRIC)) p.push(`findings[${i}].criterion must be one of ${Object.keys(RUBRIC).join(", ")}`);
    if (f?.shot != null && shotIds && !shotIds.includes(f.shot)) p.push(`findings[${i}].shot "${f.shot}" is not a shot id`);
  });
  if (!isStr(r.summary)) p.push("summary is required");
  return p;
}

/**
 * Pass/fail is decided here, not by the reviewer: every criterion >= minEach,
 * the critical criteria at their own bar, the average >= minAverage, and no
 * blocking problem (an unsupported central claim, an incoherent explanation,
 * padding) regardless of scores.
 */
export function reviewVerdict(review) {
  const reasons = [];
  const s = review?.scores ?? {};
  const keys = Object.keys(RUBRIC);
  for (const b of review?.blocking ?? []) reasons.push(`blocking: ${b.problem}`);
  for (const k of keys) if (!(s[k] >= PASS_RULES.minEach)) reasons.push(`${k} scored ${s[k] ?? "?"} (minimum ${PASS_RULES.minEach})`);
  for (const [k, min] of Object.entries(PASS_RULES.critical)) if (s[k] >= PASS_RULES.minEach && !(s[k] >= min)) reasons.push(`${k} scored ${s[k]} (needs ${min})`);
  const avg = keys.reduce((n, k) => n + (isNum(s[k]) ? s[k] : 0), 0) / keys.length;
  if (avg < PASS_RULES.minAverage) reasons.push(`average ${avg.toFixed(2)} (needs ${PASS_RULES.minAverage})`);
  return { pass: reasons.length === 0, average: Math.round(avg * 100) / 100, reasons };
}

/** The text a review judged: changing it makes the review stale. */
export function scriptText(spec) {
  return (spec?.shots ?? []).map((s) => ({ id: s.id, section: s.section, n: s.narration ?? null, l: s.lyric ?? null }));
}
