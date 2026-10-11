// Research-first editorial stages. Research informs writing, never the other
// way round:
//
//   research  qualification + angle + evidence dossier + thesis  (one claude call, web tools)
//   outline   per format: how the viewer's understanding changes   (one call per format)
//   script    per format: narration/lyrics from dossier + outline   (one call per format)
//   review    per format: independent editorial rubric, bounded revision of the script
//
// Each artifact records the hashes of what it was made from, so a duration
// change re-plans only that format's outline/script, a research change
// re-plans both, and a landscape rewrite never touches the Short.
import {
  claimMap, durationSupport, outlineBlockers, PROMPT_VERSIONS, researchBlockers, reviewVerdict, RUBRIC, PASS_RULES, USABLE, validateOutline, validateResearch, validateReview,
} from "../../src/schema/editorial.mjs";
import type { Outline, Research, ReviewReply, Verdict } from "../../src/schema/editorial.mjs";
import { EVIDENCE_VERSION, evidenceForClaims, evidenceFromResearch, validateEvidenceStore } from "../../src/schema/evidence.mjs";
import type { EvidenceStore } from "../../src/schema/evidence.mjs";
import { checkDuration, fmt, FORMAT_LABEL, formatKey, isBlocking, wordsToTarget } from "../../src/schema/settings.mjs";
import type { Settings } from "../../src/schema/settings.mjs";
import { SECTIONS, validateSpec } from "../../src/schema/storyboard.mjs";
import type { Shot, VideoSpec } from "../../src/schema/storyboard.mjs";
import { estimateRuntime } from "../../src/schema/timeline.mjs";
import { claudeJson } from "../claude";
import { archive, hashFile, hashOf, paths, PipelineError, readJson, writeJson } from "../core/files";
import { loadSpec, ownSpec, prompt, saveSpec } from "./text";
import type { Format, RunCtx, StageResult, Topic } from "./types";

const ASPECT: Record<Format, string> = { main: "16:9 landscape", short: "9:16 vertical Short" };
/** Narration words per shot: long enough for one idea, short enough for captions and one visual. */
export const SHOT_WORD_LIMIT: Record<Format, number> = { main: 45, short: 32 };

// ---------- artifacts ----------

export type ResearchFile = Research & { version: 1; inputHash: string; promptVersion: number; at: string; topic: { slug: string; title: string; angle?: string } };
export type OutlineEntry = Outline & { format: Format; inputHash: string; researchHash: string; evidenceHash: string; durationKey: string; at: string; promptVersion: number };
export type OutlineFile = { version: 1; formats: Partial<Record<Format, OutlineEntry>> };
export type ReviewEntry = ReviewReply & {
  findings: (ReviewReply["findings"][number] & { id: string })[];
  blocking: (ReviewReply["blocking"][number] & { id: string })[];
  format: Format;
  inputHash: string;
  scriptHash: string;
  outlineHash: string;
  at: string;
  verdict: Verdict;
  estimate?: NonNullable<VideoSpec["editorial"]>["estimate"];
  history: { at: string; scores: Record<string, number>; verdict: Verdict; revised: boolean }[];
};
export type ReviewFile = { version: 1; formats: Partial<Record<Format, ReviewEntry>> };

export const loadResearch = (slug: string) => readJson<ResearchFile | null>(paths.research(slug), null);
export const loadEvidence = (slug: string) => readJson<EvidenceStore | null>(paths.evidence(slug), null);
export const loadOutlines = (slug: string) => readJson<OutlineFile>(paths.outline(slug), { version: 1, formats: {} });
export const loadReviews = (slug: string) => readJson<ReviewFile>(paths.review(slug), { version: 1, formats: {} });

/** What the research depends on: the topic as asked, and the research prompt. Duration does NOT invalidate research. */
const modelEnvKey = (step: string) => step.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase();
export function effectiveModelKey(settings: Settings, ...steps: string[]) {
  return Object.fromEntries(steps.map((step) => {
    const key = modelEnvKey(step);
    return [step, {
      model: process.env[`CLAUDE_MODEL_${key}`] || process.env.CLAUDE_MODEL || settings.models[step as keyof Settings["models"]]?.model,
      effort: process.env[`CLAUDE_EFFORT_${key}`] || process.env.CLAUDE_EFFORT || settings.models[step as keyof Settings["models"]]?.effort,
    }];
  }));
}
export const researchInputHash = (title: string, topic?: Topic, settings?: Settings) => hashOf({ title, angle: topic?.angle ?? "", models: settings ? effectiveModelKey(settings, "research") : null, schema: 1, v: PROMPT_VERSIONS.research });
/** Identity of the dossier's content, for everything downstream. */
export const researchHash = (r: ResearchFile | null) => (r ? hashOf({ ...r, at: null }) : null);
export const evidenceHash = (e: EvidenceStore | null) => (e ? hashOf({ version: e.version, claims: e.claims, sources: e.sources }) : null);
export const outlineInputHash = (rHash: string | null, settings: Settings, format: Format, eHash: string | null = rHash) => hashOf({ research: rHash, evidence: eHash, evidenceVersion: EVIDENCE_VERSION, duration: formatKey(settings, format), models: effectiveModelKey(settings, "outline"), schema: 2, format, v: PROMPT_VERSIONS.outline });
export const outlineHash = (o: OutlineEntry | undefined) => (o ? hashOf({ ...o, at: null }) : null);
const reviewScriptContext = (spec: VideoSpec) => ({
  brief: spec.brief ?? null,
  music: { bpm: spec.music.bpm, key: spec.music.key ?? null, mode: spec.music.mode ?? null, mood: spec.music.mood ?? null },
  shots: spec.shots.map((shot) => ({ id: shot.id, beatId: shot.beatId ?? null, section: shot.section, purpose: shot.purpose ?? null, narration: shot.narration ?? null, lyric: shot.lyric ?? null, headline: shot.headline ?? null, claims: shot.claims ?? [] })),
});
export const reviewInputHash = (spec: VideoSpec, oHash: string | null, eHash: string | null = null, settings?: Settings) => hashOf({
  script: reviewScriptContext(spec), outline: oHash, evidence: eHash,
  duration: settings ? formatKey(settings, spec.format ?? "main") : null,
  wordsPerMinute: settings?.narration.wordsPerMinute ?? null,
  models: settings ? effectiveModelKey(settings, "review") : null,
  schema: 2, v: PROMPT_VERSIONS.review,
});

export function ensureEvidence(slug: string, research: ResearchFile): EvidenceStore {
  const rHash = researchHash(research)!;
  const current = loadEvidence(slug);
  const valid = current && current.researchHash === rHash && validateEvidenceStore(current).length === 0;
  if (valid) return current;
  const next = evidenceFromResearch(research, { researchHash: rHash, promptVersion: research.promptVersion, topic: research.topic.slug, at: research.at });
  const problems = validateEvidenceStore(next);
  if (problems.length) throw new PipelineError(`Cannot build canonical evidence: ${problems.slice(0, 5).join("; ")}`, "invalid");
  archive(slug, paths.evidence(slug), "evidence");
  writeJson(paths.evidence(slug), next);
  return next;
}

function outlineContext(research: ResearchFile, evidence: EvidenceStore) {
  const ids = evidence.claims.filter((claim) => USABLE.includes(claim.status)).map((claim) => claim.id);
  return {
    audience: research.audience,
    centralQuestion: research.qualification.centralQuestion,
    angle: research.qualification.selectedAngle,
    shortInsight: research.qualification.shortInsight,
    mechanism: research.mechanism,
    thesis: research.thesis,
    prerequisites: research.prerequisites,
    claims: evidenceForClaims(evidence, ids, { sourceLimit: 1 }),
    misconceptions: research.misconceptions,
    examples: research.examples,
    insights: research.insights,
    uncertainties: research.uncertainties,
  };
}

function scriptEvidence(research: ResearchFile, evidence: EvidenceStore, outline: OutlineEntry) {
  const ids = [...new Set([...(research.thesis.claimIds ?? []), ...outline.beats.flatMap((beat) => beat.claimIds ?? [])])];
  return { thesis: research.thesis, evidence: evidenceForClaims(evidence, ids) };
}

export function directionInputHash(spec: VideoSpec, outline: OutlineEntry | undefined, evidence: EvidenceStore | null, settings: Settings, research: ResearchFile | null = null) {
  const ids = [...new Set(spec.shots.flatMap((shot) => shot.claims ?? []))];
  const relevantEvidence = evidence ? evidenceForClaims(evidence, ids) : null;
  return hashOf({
    script: {
      title: spec.title, format: spec.format ?? "main", brief: spec.brief ?? null, world: spec.world ?? null, bpm: spec.music.bpm,
      shots: spec.shots.map((shot) => ({ id: shot.id, beatId: shot.beatId ?? null, section: shot.section, purpose: shot.purpose ?? null, narration: shot.narration ?? null, lyric: shot.lyric ?? null, headline: shot.headline ?? null, short: shot.short ?? false, claims: shot.claims ?? [] })),
    },
    outline: outline ? {
      openingQuestion: outline.openingQuestion, structure: outline.structure,
      beats: outline.beats.map(({ id, role, point, visual }) => ({ id, role, point, visual })),
      keyExample: outline.keyExample ?? null, complication: outline.complication ?? null, conclusion: outline.conclusion,
    } : null,
    evidence: relevantEvidence,
    demonstrations: research?.examples.filter((example) => (example.claimIds ?? []).some((id) => ids.includes(id))) ?? [],
    assetsManifest: hashFile(paths.assetsManifest),
    models: effectiveModelKey(settings, "direct"),
    schema: 2,
    promptVersion: PROMPT_VERSIONS.direct,
  });
}

export const factcheckItemHash = (text: string, claimIds: string[], evidence: EvidenceStore | null, settings: Settings) => hashOf({
  text,
  evidence: evidence ? evidenceForClaims(evidence, claimIds) : null,
  models: effectiveModelKey(settings, "factcheck"),
  promptVersion: PROMPT_VERSIONS.factcheck,
  schema: 2,
});

function saveOutline(slug: string, format: Format, entry: OutlineEntry) {
  const file = loadOutlines(slug);
  archive(slug, paths.outline(slug), `outline-${format}`);
  file.formats[format] = entry;
  writeJson(paths.outline(slug), file);
}
function saveReview(slug: string, format: Format, entry: ReviewEntry) {
  const file = loadReviews(slug);
  archive(slug, paths.review(slug), `review-${format}`);
  file.formats[format] = entry;
  writeJson(paths.review(slug), file);
}

/** Typical per-shot overhead: narration lead + tail (0.8 s) plus rounding up to whole bars. Calibrated against measured timelines. */
const SHOT_OVERHEAD_S = 1.8;
const typicalShots = (format: Format, target: number) => (format === "short" ? Math.max(3, Math.round(target / 9)) : Math.max(8, Math.round(target / 16)));

function durationBrief(settings: Settings, format: Format) {
  const d = settings.formats[format];
  const wpm = settings.narration.wordsPerMinute;
  const shots = typicalShots(format, d.targetSeconds);
  const words = Math.max(10, Math.round(((d.targetSeconds - shots * SHOT_OVERHEAD_S) * wpm) / 60));
  return [
    `## Format: ${FORMAT_LABEL[format]} (${ASPECT[format]})`,
    `Target duration: ${fmt(d.targetSeconds)} (${d.targetSeconds} s). Allowed range: ${fmt(d.minSeconds)}-${fmt(d.maxSeconds)}. Estimates more than ${Math.round(settings.narration.targetTolerance * 100)}% from the target are flagged.`,
    `Narration delivery rate: ${wpm} words per minute. Every shot also costs about ${SHOT_OVERHEAD_S} s of overhead (lead-in, tail and rounding up to whole bars), and a sung chorus shot takes at least 2 bars. So with about ${shots} shots, plan roughly ${words} spoken words in total (a diagnostic, not a contract: fewer, longer shots carry more words, many short shots carry fewer).`,
    `Per-shot narration limit: ${SHOT_WORD_LIMIT[format]} words.`,
  ].join("\n");
}

// ---------- research ----------

export async function researchStage(ctx: RunCtx): Promise<StageResult> {
  const inputHash = researchInputHash(ctx.title, ctx.topic, ctx.settings);
  const existing = loadResearch(ctx.slug);
  if (existing && existing.inputHash === inputHash && !ctx.force) {
    ensureEvidence(ctx.slug, existing);
    const blockers = researchBlockers(existing);
    if (blockers.length) throw new PipelineError(blockers.join("; "), "editorial", "Open the Research tab. Narrow the topic's angle in the backlog, or re-run research.");
    return { summary: `cached: ${summarizeResearch(existing)}`, cached: true, inputHash };
  }
  const brief = [
    prompt("research"),
    `\n## Topic\nTitle: ${ctx.title}`,
    ctx.topic?.angle ? `Producer's hook idea (a suggestion, not a requirement; replace it if a stronger angle exists): ${ctx.topic.angle}` : "",
    ctx.topic?.notes ? `Producer notes: ${ctx.topic.notes}` : "",
  ].filter(Boolean).join("\n");
  console.log(`  researching with claude -p (web search)`);
  const reply = await claudeJson<Research>(brief, { allowedTools: ["WebSearch", "WebFetch"], step: "research", label: "research", check: validateResearch,
    // Repairs return only the failing fields/elements, so valid claims, sources and provenance are never regenerated and nothing is searched twice.
    fieldRepair: { hint: "If a supported claim lacks an opened source, do not invent one: set its status to \"qualified\" with a qualification, or \"insufficient\" with a note.", context: (r) => `Claim ids: ${(Array.isArray(r?.claims) ? r.claims : []).map((c) => `${c?.id} (${c?.status})`).join(", ")}` },
    repairResendsPrompt: false, timeoutMs: Number(process.env.CLAUDE_RESEARCH_TIMEOUT_MS ?? 30 * 60 * 1000) });
  const file: ResearchFile = { ...reply, version: 1, inputHash, promptVersion: PROMPT_VERSIONS.research, at: new Date().toISOString(), topic: { slug: ctx.slug, title: ctx.title, angle: ctx.topic?.angle } };
  archive(ctx.slug, paths.research(ctx.slug), "research");
  writeJson(paths.research(ctx.slug), file);
  ensureEvidence(ctx.slug, file);
  const blockers = researchBlockers(file);
  if (blockers.length) throw new PipelineError(blockers.join("; "), "editorial", "Open the Research tab. Narrow the topic's angle in the backlog, or re-run research.");
  const warnings = Object.entries(durationSupport(file, ctx.settings)).filter(([, v]) => !v.ok).map(([f, v]) => `${FORMAT_LABEL[f as Format]}: ${v.note}`);
  return { summary: summarizeResearch(file), cached: false, warnings, inputHash };
}

export function summarizeResearch(r: ResearchFile) {
  const n = (st: string) => r.claims.filter((c) => c.status === st).length;
  const fetched = new Set(r.claims.flatMap((c) => c.sources.filter((s) => s.accessed === "fetched").map((s) => s.url))).size;
  return `${r.qualification.verdict}: "${r.qualification.selectedAngle}" · ${n("supported")} supported, ${n("qualified")} qualified, ${n("insufficient") + n("excluded")} not usable · ${fetched} sources opened`;
}

function requireResearch(ctx: RunCtx) {
  const r = loadResearch(ctx.slug);
  if (!r) throw new PipelineError("No research dossier yet: run the research stage first", "missing");
  if (r.inputHash !== researchInputHash(ctx.title, ctx.topic, ctx.settings)) throw new PipelineError("The research dossier is out of date for this topic or effective research settings: run the research stage first", "missing");
  const blockers = researchBlockers(r);
  if (blockers.length) throw new PipelineError(blockers.join("; "), "editorial");
  ensureEvidence(ctx.slug, r);
  return r;
}

// ---------- outline ----------

export async function outlineStage(ctx: RunCtx): Promise<StageResult> {
  const research = requireResearch(ctx);
  const evidence = ensureEvidence(ctx.slug, research);
  const eHash = evidenceHash(evidence)!;
  const rHash = researchHash(research)!;
  const outlines = loadOutlines(ctx.slug);
  const done: string[] = [];
  let cached = true;
  for (const format of ctx.formats) {
    const inputHash = outlineInputHash(rHash, ctx.settings, format, eHash);
    const cur = outlines.formats[format];
    if (cur && cur.inputHash === inputHash && !ctx.force && !ctx.fresh) {
      const b = outlineBlockers(cur);
      if (b.length) throw new PipelineError(b.join("; "), "editorial", "Choose a narrower or richer angle (backlog), or change the duration in Settings.");
      done.push(`${format}: cached (${cur.beats.length} beats, ${cur.structure})`);
      continue;
    }
    cached = false;
    const support = durationSupport(research, ctx.settings)[format];
    if (!support.ok)
      throw new PipelineError(`${FORMAT_LABEL[format]}: the researched angle can't fill the configured duration without padding (${support.note})`, "editorial", "Pick a richer angle for the topic, or lower the minimum duration in Settings > Video formats.");
    const brief = [
      prompt("outline"),
      durationBrief(ctx.settings, format),
      `\n## Research and evidence\n${JSON.stringify(outlineContext(research, evidence), null, 1)}`,
    ].join("\n");
    console.log(`  outlining the ${FORMAT_LABEL[format]} with claude -p`);
    const reply = await claudeJson<Outline>(brief, { step: "outline", label: `outline ${format}`, check: (o) => validateOutline(o, research, ctx.settings, format), fieldRepair: { context: () => `Claim ids: ${research.claims.map((c) => c.id).join(", ")}` } });
    const entry: OutlineEntry = { ...reply, format, inputHash, researchHash: rHash, evidenceHash: eHash, durationKey: formatKey(ctx.settings, format), at: new Date().toISOString(), promptVersion: PROMPT_VERSIONS.outline };
    saveOutline(ctx.slug, format, entry);
    const b = outlineBlockers(entry);
    if (b.length) throw new PipelineError(b.join("; "), "editorial", "Choose a narrower or richer angle (backlog), or change the duration in Settings.");
    done.push(`${format}: ${entry.beats.length} beats, ${entry.structure}, planned ${fmt(entry.beats.reduce((n, x) => n + x.seconds, 0))}`);
  }
  return { summary: done.join("; "), cached };
}

// ---------- script ----------

type ScriptShot = Omit<Shot, "visual" | "beatId"> & { beatId: string };
export type ScriptReply = Omit<VideoSpec, "schemaVersion" | "shots"> & { shots: ScriptShot[] };

/** Structural, evidence and runtime checks on a script reply. Problems go back to Claude once. */
export function checkScript(r: ScriptReply, format: Format, research: Research | null, settings: Settings, strictDuration = false, outline?: OutlineEntry): string[] {
  const p: string[] = [];
  const min = format === "short" ? 3 : 8;
  if (!Array.isArray(r?.shots) || r.shots.length < min) return [`shots must list at least ${min} shots`];
  const cm = claimMap(research);
  const ids = new Set<string>();
  r.shots.forEach((s, i) => {
    const at = `shot ${i + 1}${s?.id ? ` (${s.id})` : ""}`;
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s.id ?? "") || ids.has(s.id)) p.push(`${at}: id must be unique kebab-case`);
    ids.add(s.id);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s.beatId ?? "") || (outline && !outline.beats.some((beat) => beat.id === s.beatId))) p.push(`${at}: beatId must reference a stable id in the approved outline`);
    if (!SECTIONS.includes(s.section)) p.push(`${at}: bad section`);
    if (s.section === "chorus" ? !s.lyric : !s.narration) p.push(`${at}: ${s.section === "chorus" ? "chorus needs a lyric" : "needs narration"}`);
    if (s.section === "chorus" && s.narration) p.push(`${at}: a chorus shot is sung: lyric only, no narration`);
    const words = s.narration?.split(/\s+/).filter(Boolean).length ?? 0;
    if (words > SHOT_WORD_LIMIT[format]) p.push(`${at}: narration is ${words} words (max ${SHOT_WORD_LIMIT[format]}); split it into two shots`);
    if (s.headline && s.headline.split(/\s+/).length > 6) p.push(`${at}: headline over 5 words`);
    if (research) {
      if (s.claims != null && !Array.isArray(s.claims)) p.push(`${at}: claims must be a list of claim ids`);
      for (const id of s.claims ?? []) {
        const c = cm.get(id);
        if (!c) p.push(`${at}: claim "${id}" is not in the research dossier`);
        else if (!USABLE.includes(c.status)) p.push(`${at}: claim "${id}" is ${c.status} in the research; don't state it`);
      }
    }
  });
  if (!r.music?.bpm) p.push("music.bpm is required");
  if (!p.length && strictDuration) {
    const est = estimateRuntime(toSpec(r, "x", format), format, settings.narration.wordsPerMinute);
    const c = checkDuration(est.seconds, settings, format);
    if (isBlocking(c.verdict)) {
      const d = settings.formats[format];
      const delta = wordsToTarget({ seconds: est.seconds, targetSeconds: d.targetSeconds, measuredWpm: settings.narration.wordsPerMinute }, settings.narration.wordsPerMinute);
      p.push(`estimated runtime ${fmt(est.seconds)} (${est.spokenWords} spoken + ${est.sungWords} sung words at ${settings.narration.wordsPerMinute} wpm, including musical time) misses the ${fmt(d.targetSeconds)} target (${c.message}; allowed ${fmt(d.minSeconds)}-${fmt(d.maxSeconds)}, tolerance ${Math.round(settings.narration.targetTolerance * 100)}%); aim for ${fmt(d.targetSeconds)}: ${delta > 0 ? `add about ${delta} words of real explanation (mechanism detail, the worked example, a misconception) from the dossier, not repetition` : `cut about ${-delta} words, keeping the mechanism and the example`}`);
    }
  }
  return p;
}

/** A draft storyboard: script text with placeholder kinetic visuals until the director runs. */
export function toSpec(r: ScriptReply, slug: string, format: Format): VideoSpec {
  return {
    schemaVersion: 2,
    slug,
    title: r.title,
    format,
    brief: r.brief,
    world: r.world ?? "night",
    direction: { status: "draft", at: new Date().toISOString(), by: "script" },
    music: r.music,
    shots: r.shots.map(({ short: _short, ...s }) => ({
      ...s,
      beatId: s.beatId,
      visual: s.section === "chorus" ? { type: "kinetic", style: "punch" } : { type: "kinetic", style: "stack", lines: [s.headline ?? s.narration!.split(/\s+/).slice(0, 5).join(" ")] },
    })) as Shot[],
  };
}

/** Whether a format's script is current: written from this outline, under these duration settings, with this prompt. */
export const scriptInputHash = (outline: OutlineEntry, eHash: string | null, settings: Settings, format: Format) => hashOf({ outline: outlineHash(outline), evidence: eHash, duration: formatKey(settings, format), models: effectiveModelKey(settings, "script", "scriptFix"), schema: 2, v: PROMPT_VERSIONS.script });

export function scriptFreshness(slug: string, format: Format, settings: Settings, researchOverride?: ResearchFile, evidenceOverride?: EvidenceStore): { status: "fresh" | "stale" | "missing"; reason: string } {
  const spec = ownSpec(slug, format);
  if (!spec) {
    const legacy = loadSpec(slug, format);
    return legacy ? { status: "stale", reason: "the old single storyboard is used; no independent script for this format yet" } : { status: "missing", reason: "no script yet" };
  }
  const e = spec.editorial;
  if (!e?.outlineHash) return { status: "stale", reason: "written before the research-first workflow" };
  const outline = loadOutlines(slug).formats[format];
  if (!outline) return { status: "stale", reason: "its outline is missing" };
  if (e.outlineHash !== outlineHash(outline)) return { status: "stale", reason: "the outline changed" };
  if (e.durationKey !== formatKey(settings, format)) return { status: "stale", reason: "duration settings changed" };
  if (e.promptVersion !== PROMPT_VERSIONS.script) return { status: "stale", reason: "the script prompt changed" };
  const research = researchOverride ?? loadResearch(slug);
  const evidence = evidenceOverride ?? loadEvidence(slug);
  if (!research || !evidence || evidence.researchHash !== researchHash(research)) return { status: "stale", reason: "canonical evidence is missing or out of date" };
  const eHash = evidenceHash(evidence);
  if (e.evidenceHash !== eHash || e.scriptInputHash !== scriptInputHash(outline, eHash, settings, format)) return { status: "stale", reason: "evidence or effective model settings changed" };
  return { status: "fresh", reason: `${spec.shots.length} shots, est. ${fmt(e.estimate?.seconds ?? 0)}` };
}

function lengthRepairPlan(reply: ScriptReply, outline: OutlineEntry, format: Format, issue: string) {
  const delta = Number(issue.match(/(?:add|cut) about (\d+) words/)?.[1] ?? 0);
  const adding = /add about/.test(issue);
  const roleByBeat = new Map(outline.beats.map((beat) => [beat.id, beat.role]));
  const candidates = reply.shots.filter((shot) => shot.narration).sort((a, b) => {
    const words = (shot: ScriptShot) => shot.narration?.split(/\s+/).filter(Boolean).length ?? 0;
    if (adding) {
      const roleRank = (shot: ScriptShot) => ["mechanism", "example", "complication"].includes(roleByBeat.get(shot.beatId) ?? "") ? 0 : 1;
      return roleRank(a) - roleRank(b) || words(a) - words(b);
    }
    return words(b) - words(a);
  });
  const count = Math.min(candidates.length, Math.max(1, Math.ceil(delta / SHOT_WORD_LIMIT[format])));
  const targets = new Map<string, Set<string>>(candidates.slice(0, count).map((shot) => [shot.id, new Set(["narration"])]));
  const findings: ReviewReply["findings"] = [...targets.keys()].map((segmentId) => ({
    segmentId, field: "narration", criterion: "formatFit", severity: "major",
    problem: issue,
    fix: adding ? `Add about ${delta} words of useful mechanism or example detail in this segment; keep all supplied claim qualifications.` : `Cut about ${delta} words across the selected segments while keeping the mechanism and worked example.`,
  }));
  return { targets, findings };
}

function replyFromSpec(spec: VideoSpec): ScriptReply {
  const { schemaVersion: _schema, editorial: _editorial, direction: _direction, shots, ...base } = spec;
  return { ...base, shots: shots.map(({ visual: _visual, ...shot }) => shot as ScriptShot) } as ScriptReply;
}

async function writeScript(ctx: RunCtx, format: Format, research: ResearchFile, evidence: EvidenceStore, outline: OutlineEntry, extra: string[] = []) {
  const topic = ctx.topic;
  const brief = [
    prompt("script"),
    durationBrief(ctx.settings, format),
    `\nTopic: ${ctx.title}`,
    `Use slug: ${ctx.slug}`,
    topic?.chorusIdea ? `Producer's chorus idea (use it only if it states the mechanism accurately): ${topic.chorusIdea}` : "",
    topic?.notes ? `Producer notes: ${topic.notes}` : "",
    topic?.review?.notes ? `Notes from the last human review (address them): ${topic.review.notes}` : "",
    `\n## Approved outline (${FORMAT_LABEL[format]})\n${JSON.stringify({ ...outline, inputHash: undefined, researchHash: undefined, evidenceHash: undefined, durationKey: undefined, at: undefined }, null, 1)}`,
    `\n## Thesis and referenced evidence\n${JSON.stringify(scriptEvidence(research, evidence, outline), null, 1)}`,
    ...extra,
  ].filter(Boolean).join("\n");
  console.log(`  writing the ${FORMAT_LABEL[format]} script with claude -p`);
  let reply = await claudeJson<ScriptReply>(brief, { step: "script", label: `script ${format}`, check: (r) => checkScript(r, format, research, ctx.settings, false, outline), fieldRepair: { context: () => `Evidence claim ids: ${scriptEvidence(research, evidence, outline).evidence.claims.map((c) => c.id).join(", ")}\nOutline beat ids: ${outline.beats.map((b) => b.id).join(", ")}` } });
  // Length is checked after the structural checks so the model gets one precise, numeric retry. If it still
  // misses, the script is kept and the miss is surfaced (the editorial review judges format fit, and the
  // measured audio is the final gate) instead of failing before anyone can look at it.
  const miss = checkScript(reply, format, research, ctx.settings, true, outline);
  if (miss.length) {
    console.log(`  ${FORMAT_LABEL[format]} length: ${miss[0]}`);
    const plan = lengthRepairPlan(reply, outline, format, miss[0]);
    let localized = false;
    if (plan.targets.size) {
      const before = toSpec(reply, ctx.slug, format);
      try {
        const repaired = await repairScriptSegments(ctx, format, before, research, evidence, outline, plan.findings, plan.targets, `length miss: patch ${plan.targets.size} narration segment(s), preserving all other content`);
        if (!repaired.unsafeReason) {
          reply = replyFromSpec(repaired.spec);
          localized = true;
        } else console.log(`  local length repair unsafe: ${repaired.unsafeReason}`);
      } catch (error) {
        if (!(error instanceof PipelineError) || error.kind !== "invalid") throw error;
        console.log(`  local length repair failed validation: ${error.message}`);
      }
    }
    if (!localized) {
      try {
        reply = await claudeJson<ScriptReply>(`${brief}\n\n## Local length repair was unsafe\n${miss[0]}\nPrevious segments:\n${JSON.stringify(reply.shots.map((x) => ({ id: x.id, beatId: x.beatId, section: x.section, narration: x.narration, lyric: x.lyric, claims: x.claims })), null, 1)}\nA targeted patch could not meet the required duration. Regenerate the script only as a fallback, retaining every sound segment and changing as little as necessary.`, { step: "scriptFix", label: `script ${format} (length fallback)`, callKind: "regeneration", reason: "full regeneration fallback after localized length repair was unsafe", check: (r) => checkScript(r, format, research, ctx.settings, true, outline) });
      } catch (e) {
        if (!(e instanceof PipelineError) || e.kind !== "invalid") throw e;
        console.log(`  keeping the first ${FORMAT_LABEL[format]} script; its length miss will be flagged`);
      }
    }
  }
  const spec = toSpec(reply, ctx.slug, format);
  const est = estimateRuntime(spec, format, ctx.settings.narration.wordsPerMinute);
  const check = checkDuration(est.seconds, ctx.settings, format);
  spec.editorial = {
    outlineHash: outlineHash(outline)!,
    researchHash: researchHash(research)!,
    evidenceHash: evidenceHash(evidence)!,
    scriptInputHash: scriptInputHash(outline, evidenceHash(evidence), ctx.settings, format),
    durationKey: formatKey(ctx.settings, format),
    promptVersion: PROMPT_VERSIONS.script,
    estimate: { seconds: Math.round(est.seconds * 10) / 10, spokenWords: est.spokenWords, sungWords: est.sungWords, wordsPerMinute: est.wordsPerMinute, verdict: check.verdict, message: check.message },
    at: new Date().toISOString(),
  };
  return { spec, check };
}

export async function scriptStage(ctx: RunCtx): Promise<StageResult> {
  const research = requireResearch(ctx);
  const evidence = ensureEvidence(ctx.slug, research);
  const eHash = evidenceHash(evidence)!;
  const outlines = loadOutlines(ctx.slug);
  const done: string[] = [];
  const warnings: string[] = [];
  let cached = true;
  for (const format of ctx.formats) {
    const fresh = scriptFreshness(ctx.slug, format, ctx.settings, research, evidence);
    const revise = ctx.revise?.[format];
    if (fresh.status === "fresh" && !ctx.fresh && !ctx.force && !revise) {
      done.push(`${format}: kept (${fresh.reason})`);
      continue;
    }
    const outline = outlines.formats[format];
    if (!outline || outline.inputHash !== outlineInputHash(researchHash(research), ctx.settings, format, eHash)) throw new PipelineError(`The ${FORMAT_LABEL[format]} outline is missing or out of date: run the outline stage first`, "missing");
    cached = false;
    const extra = revise ? [`\n## Revise the previous version\n${revise}\n\nPrevious version:\n${JSON.stringify(ownSpec(ctx.slug, format)?.shots.map((s) => ({ id: s.id, section: s.section, narration: s.narration, lyric: s.lyric, claims: s.claims })), null, 1)}`] : [];
    const { spec, check } = await writeScript(ctx, format, research, evidence, outline, extra);
    saveSpec(ctx.slug, spec, revise ? `before-revision-${format}` : `fresh-script-${format}`, format);
    if (check.verdict === "off-target") warnings.push(`${FORMAT_LABEL[format]}: ${check.message}`);
    done.push(`${format}: ${spec.shots.length} shots, ${spec.editorial!.estimate!.spokenWords} words, est. ${fmt(spec.editorial!.estimate!.seconds)}`);
  }
  return { summary: done.join("; "), cached, warnings };
}

// ---------- editorial review ----------

export function reviewFreshness(slug: string, format: Format, settings?: Settings): { status: "fresh" | "stale" | "missing" | "failed"; reason: string } {
  const spec = ownSpec(slug, format);
  if (!spec) return { status: "missing", reason: "no script for this format" };
  const r = loadReviews(slug).formats[format];
  if (!r) return { status: "missing", reason: "not reviewed" };
  const oHash = outlineHash(loadOutlines(slug).formats[format]);
  const evidence = loadEvidence(slug);
  if (!evidence) return { status: "stale", reason: "canonical evidence is missing" };
  if (r.inputHash !== reviewInputHash(spec, oHash, evidenceHash(evidence), settings)) return { status: "stale", reason: "the script, evidence, or reviewer settings changed" };
  if (!r.verdict.pass) return { status: "failed", reason: `editorial review failed: ${r.verdict.reasons.slice(0, 2).join("; ")}` };
  return { status: "fresh", reason: `passed, average ${r.verdict.average}` };
}

function reviewPrompt(spec: VideoSpec, format: Format, research: ResearchFile, evidence: EvidenceStore, outline: OutlineEntry, settings: Settings) {
  const est = estimateRuntime(spec, format, settings.narration.wordsPerMinute);
  const rubric = Object.entries(RUBRIC).map(([k, v]) => `- ${k}: ${v}`).join("\n");
  return [
    prompt("review").replace("{{RUBRIC}}", rubric),
    `\nPass rules (applied by the pipeline): every criterion >= ${PASS_RULES.minEach}, ${Object.entries(PASS_RULES.critical).map(([k, v]) => `${k} >= ${v}`).join(", ")}, average >= ${PASS_RULES.minAverage}, and no blocking problem.`,
    durationBrief(settings, format),
    `Estimated runtime of this script: ${fmt(est.seconds)} (${est.spokenWords} spoken words, ${est.sungWords} sung words, ${est.shots} shots).`,
    format === "short" ? "This Short must stand on its own: judge it as if the viewer never sees the landscape video." : "",
    `\n## Script segments\n${JSON.stringify(spec.shots.map((s) => ({ id: s.id, beatId: s.beatId, section: s.section, purpose: s.purpose, narration: s.narration, lyric: s.lyric, headline: s.headline, claims: s.claims })), null, 1)}`,
    `\n## Relevant outline\n${JSON.stringify({ openingQuestion: outline.openingQuestion, understandingChange: outline.understandingChange, structure: outline.structure, beats: outline.beats, keyExample: outline.keyExample, complication: outline.complication, conclusion: outline.conclusion, coreInsight: outline.coreInsight }, null, 1)}`,
    `\n## Thesis and evidence used by this script\n${JSON.stringify({ thesis: research.thesis, evidence: evidenceForClaims(evidence, [...new Set([...(research.thesis.claimIds ?? []), ...spec.shots.flatMap((s) => s.claims ?? [])])]) }, null, 1)}`,
  ].filter(Boolean).join("\n");
}

const severityRank = { blocking: 0, major: 1, minor: 2 };
export function stableReview(reply: ReviewReply) {
  const identity = (kind: string, item: any) => `${kind}-${hashOf({ segmentId: item.segmentId ?? null, field: item.field, criterion: item.criterion ?? null, problem: item.problem, fix: item.fix ?? null }).slice(0, 12)}`;
  const blocking = reply.blocking.map((item) => ({ ...item, id: identity("block", item) }));
  const findings = reply.findings.map((item) => ({ ...item, id: identity("finding", item) })).sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || a.id.localeCompare(b.id));
  return { ...reply, blocking, findings };
}

export function safeSegmentRepairTargets(spec: VideoSpec, reply: ReviewReply) {
  if (reply.blocking.length || reply.findings.some((finding) => finding.severity === "blocking")) return null;
  const allowed = new Set(["narration", "lyric", "headline", "purpose"]);
  const targets = new Map<string, Set<string>>();
  for (const finding of reply.findings) {
    if (!finding.segmentId || !allowed.has(finding.field) || !spec.shots.some((shot) => shot.id === finding.segmentId)) return null;
    const fields = targets.get(finding.segmentId) ?? new Set<string>();
    fields.add(finding.field);
    targets.set(finding.segmentId, fields);
  }
  return targets.size ? targets : null;
}

export function mergeScriptPatches(spec: VideoSpec, patches: { id: string; fields: Partial<Shot> }[], targets: Map<string, Set<string>>): VideoSpec {
  const byId = new Map(patches.map((patch) => [patch.id, patch.fields]));
  return { ...spec, direction: { status: "draft", at: new Date().toISOString(), by: "script-repair" }, shots: spec.shots.map((shot) => {
    const fields = byId.get(shot.id);
    if (!fields) return shot;
    const allowed = targets.get(shot.id) ?? new Set<string>();
    const next = { ...shot };
    for (const key of Object.keys(fields) as (keyof Shot)[]) {
      if (key === "claims") next.claims = fields.claims;
      else if (allowed.has(key)) (next as any)[key] = fields[key];
    }
    return next;
  }) };
}

async function repairScriptSegments(ctx: RunCtx, format: Format, before: VideoSpec, research: ResearchFile, evidence: EvidenceStore, outline: OutlineEntry, findings: ReviewReply["findings"], targets: Map<string, Set<string>>, reason = "localized editorial repair for named segment fields") {
  type SegmentPatchReply = { patches: Array<{ id: string; fields: Partial<Shot> }>; unsafeReason?: string | null };
  const segmentIds = [...targets.keys()];
  const claimIds = [...new Set(segmentIds.flatMap((id) => before.shots.find((shot) => shot.id === id)?.claims ?? []))];
  const allowedClaims = evidenceForClaims(evidence, claimIds);
  const segments = before.shots.filter((shot) => targets.has(shot.id)).map((shot) => ({ id: shot.id, beatId: shot.beatId, section: shot.section, purpose: shot.purpose, narration: shot.narration, lyric: shot.lyric, headline: shot.headline, claims: shot.claims, requestedFields: [...targets.get(shot.id)!] }));
  const request = { format, wordLimit: SHOT_WORD_LIMIT[format], findings: findings.filter((f) => targets.has(f.segmentId!)).map(({ segmentId, field, severity, problem, fix }) => ({ segmentId, field, severity, problem, fix })), segments, evidence: allowedClaims, relevantBeats: outline.beats.filter((beat) => segments.some((segment) => segment.beatId === beat.id)) };
  const reply = await claudeJson<SegmentPatchReply>(`${prompt("repair-script-segments")}\n\nRepair request:\n${JSON.stringify(request, null, 1)}`, {
    step: "scriptFix", label: `review repair ${format}`, callKind: "regeneration", reason,
    check: (value) => {
      if (!Array.isArray(value?.patches)) return ["patches must be a list"];
      if (value.unsafeReason) return value.patches.length ? ["an unsafe repair must not also return patches"] : [];
      if (!value.patches.length) return ["return a patch for at least one affected segment or explain why the repair is unsafe"];
      const seen = new Set<string>();
      const issues: string[] = [];
      for (const patch of value.patches) {
        const id = patch?.id;
        const allowedFields = targets.get(id);
        if (!allowedFields || seen.has(id)) { issues.push(`unknown or duplicate affected segment id ${id}`); continue; }
        seen.add(id);
        if (!patch.fields || typeof patch.fields !== "object" || Array.isArray(patch.fields)) { issues.push(`${id}: fields must be an object`); continue; }
        for (const field of Object.keys(patch.fields)) if (!allowedFields.has(field) && !(field === "claims" && [...allowedFields].some((x) => ["narration", "lyric"].includes(x)))) issues.push(`${id}: ${field} was not requested`);
        for (const field of allowedFields) if (field in patch.fields && typeof (patch.fields as any)[field] !== "string") issues.push(`${id}.${field} must be text`);
        if ("claims" in patch.fields && (!Array.isArray(patch.fields.claims) || patch.fields.claims.some((id) => !allowedClaims.claims.some((claim) => claim.id === id)))) issues.push(`${id}.claims references evidence outside the supplied subset`);
      }
      return issues;
    },
  });
  if (reply.unsafeReason) return { unsafeReason: reply.unsafeReason, spec: before };
  const next = mergeScriptPatches(before, reply.patches, targets);
  const schemaIssues = validateSpec(next, { slug: ctx.slug });
  const scriptIssues = checkScript(next as unknown as ScriptReply, format, research, ctx.settings, true, outline);
  if (schemaIssues.length || scriptIssues.length) throw new PipelineError(`Localized review repair failed validation: ${[...schemaIssues, ...scriptIssues].slice(0, 6).join("; ")}`, "invalid");
  const estimate = estimateRuntime(next, format, ctx.settings.narration.wordsPerMinute);
  const duration = checkDuration(estimate.seconds, ctx.settings, format);
  next.editorial = { ...next.editorial, estimate: { seconds: Math.round(estimate.seconds * 10) / 10, spokenWords: estimate.spokenWords, sungWords: estimate.sungWords, wordsPerMinute: estimate.wordsPerMinute, verdict: duration.verdict, message: duration.message }, at: new Date().toISOString() };
  return { unsafeReason: null, spec: next };
}

export async function reviewStage(ctx: RunCtx): Promise<StageResult> {
  const research = requireResearch(ctx);
  const evidence = ensureEvidence(ctx.slug, research);
  const eHash = evidenceHash(evidence)!;
  const maxRevisions = Number(process.env.REVIEW_MAX_REVISIONS ?? 1);
  const done: string[] = [];
  let cached = true;
  for (const format of ctx.formats) {
    let spec = ownSpec(ctx.slug, format);
    if (!spec) throw new PipelineError(`No ${FORMAT_LABEL[format]} script to review: run the script stage first`, "missing");
    const outline = loadOutlines(ctx.slug).formats[format];
    if (!outline) throw new PipelineError(`No ${FORMAT_LABEL[format]} outline: run the outline stage first`, "missing");
    const oHash = outlineHash(outline)!;
    const inputHash = reviewInputHash(spec, oHash, eHash, ctx.settings);
    const prev = loadReviews(ctx.slug).formats[format];
    if (prev && prev.inputHash === inputHash && prev.verdict.pass && !ctx.force) {
      done.push(`${format}: passed (cached, average ${prev.verdict.average})`);
      continue;
    }
    cached = false;
    const history: ReviewEntry["history"] = prev && prev.inputHash === inputHash ? prev.history : [];
    // A stored failing review of this exact script is reused, so a re-run goes straight to revision.
    let reply: ReviewReply | null = prev && !prev.verdict.pass && prev.inputHash === inputHash && !ctx.force ? prev : null;
    for (let round = 0; ; round++) {
      if (!reply) {
        console.log(`  editorial review of the ${FORMAT_LABEL[format]} (round ${round + 1})`);
        reply = await claudeJson<ReviewReply>(reviewPrompt(spec!, format, research, evidence, outline, ctx.settings), { step: "review", label: `review ${format}`, check: (r) => validateReview(r, spec!.shots.map((s) => s.id)), fieldRepair: true });
      }
      const normalized = stableReview(reply!);
      reply = normalized;
      const verdict = reviewVerdict(normalized);
      history.push({ at: new Date().toISOString(), scores: normalized.scores, verdict, revised: false });
      const entry: ReviewEntry = {
        scores: normalized.scores, blocking: normalized.blocking, findings: normalized.findings, summary: normalized.summary,
        format, inputHash: reviewInputHash(spec, oHash, eHash, ctx.settings), scriptHash: hashOf(reviewScriptContext(spec)), outlineHash: oHash, at: new Date().toISOString(), verdict,
        estimate: spec.editorial?.estimate, history: [...history],
      };
      saveReview(ctx.slug, format, entry);
      if (verdict.pass) {
        done.push(`${format}: passed (average ${verdict.average}${round ? ` after ${round} revision(s)` : ""})`);
        break;
      }
      console.log(`  ${FORMAT_LABEL[format]} failed the editorial review: ${verdict.reasons.join("; ")}`);
      if (round >= maxRevisions)
        throw new PipelineError(`${FORMAT_LABEL[format]} failed the editorial review after ${maxRevisions} revision(s): ${verdict.reasons.slice(0, 4).join("; ")}`, "editorial", "Open the Research & review tab to read the findings; edit the script, rewrite it with Fresh script, or re-run the review.");
      // Local patches preserve every unflagged segment. Full regeneration is
      // reserved for global/thesis findings or an unsafe local repair.
      const targets = safeSegmentRepairTargets(spec!, normalized);
      if (targets) {
        try {
          const repaired = await repairScriptSegments(ctx, format, spec!, research, evidence, outline, normalized.findings, targets);
          if (!repaired.unsafeReason) {
            saveSpec(ctx.slug, repaired.spec, `before-review-repair-${format}`, format);
            history[history.length - 1].revised = true;
            spec = repaired.spec;
            reply = null;
            continue;
          }
          console.log(`  local repair unsafe: ${repaired.unsafeReason}`);
        } catch (error) {
          if (!(error instanceof PipelineError) || error.kind !== "invalid") throw error;
          console.log(`  local repair could not be validated (${error.message}); using bounded full regeneration`);
        }
      }
      const notes = [
        `The editorial review failed this script (${verdict.reasons.join("; ")}).`,
        normalized.blocking.length ? `Blocking problems:\n${normalized.blocking.map((b) => `- ${b.segmentId ? `${b.segmentId}.${b.field}: ` : `${b.field}: `}${b.problem}`).join("\n")}` : "",
        `Findings to fix:\n${normalized.findings.map((f) => `- ${f.segmentId ? `${f.segmentId}.${f.field}` : f.field} [${f.severity}/${f.criterion ?? "editorial"}] ${f.problem} Fix: ${f.fix}`).join("\n")}`,
        "This issue could not be repaired locally without changing the thesis, evidence, or multiple dependent segments. Rebuild from the same approved outline and compact evidence, preserving sound segments where safe.",
      ].filter(Boolean).join("\n\n");
      const prevShots = spec.shots.map((s) => ({ id: s.id, beatId: s.beatId, section: s.section, narration: s.narration, lyric: s.lyric, headline: s.headline, claims: s.claims }));
      const { spec: next } = await writeScript(ctx, format, research, evidence, outline, [`\n## Full regeneration fallback\n${notes}\n\nPrevious accepted segments:\n${JSON.stringify(prevShots, null, 1)}`]);
      saveSpec(ctx.slug, next, `before-review-revision-${format}`, format);
      history[history.length - 1].revised = true;
      spec = next;
      reply = null;
    }
  }
  return { summary: done.join("; "), cached };
}

