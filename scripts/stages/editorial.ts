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
  claimMap, durationSupport, outlineBlockers, PROMPT_VERSIONS, researchBlockers, reviewVerdict, RUBRIC, PASS_RULES, scriptText, USABLE, validateOutline, validateResearch, validateReview,
} from "../../src/schema/editorial.mjs";
import type { Outline, Research, ReviewReply, Verdict } from "../../src/schema/editorial.mjs";
import { checkDuration, fmt, FORMAT_LABEL, formatKey, isBlocking, wordsToTarget } from "../../src/schema/settings.mjs";
import type { Settings } from "../../src/schema/settings.mjs";
import { SECTIONS } from "../../src/schema/storyboard.mjs";
import type { Shot, VideoSpec } from "../../src/schema/storyboard.mjs";
import { estimateRuntime } from "../../src/schema/timeline.mjs";
import { claudeJson } from "../claude";
import { archive, hashOf, paths, PipelineError, readJson, writeJson } from "../core/files";
import { loadSpec, ownSpec, prompt, saveSpec } from "./text";
import type { Format, RunCtx, StageResult, Topic } from "./types";

const ASPECT: Record<Format, string> = { main: "16:9 landscape", short: "9:16 vertical Short" };
/** Narration words per shot: long enough for one idea, short enough for captions and one visual. */
export const SHOT_WORD_LIMIT: Record<Format, number> = { main: 45, short: 32 };

// ---------- artifacts ----------

export type ResearchFile = Research & { version: 1; inputHash: string; promptVersion: number; at: string; topic: { slug: string; title: string; angle?: string } };
export type OutlineEntry = Outline & { format: Format; inputHash: string; researchHash: string; durationKey: string; at: string; promptVersion: number };
export type OutlineFile = { version: 1; formats: Partial<Record<Format, OutlineEntry>> };
export type ReviewEntry = ReviewReply & {
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
export const loadOutlines = (slug: string) => readJson<OutlineFile>(paths.outline(slug), { version: 1, formats: {} });
export const loadReviews = (slug: string) => readJson<ReviewFile>(paths.review(slug), { version: 1, formats: {} });

/** What the research depends on: the topic as asked, and the research prompt. Duration does NOT invalidate research. */
export const researchInputHash = (title: string, topic?: Topic) => hashOf({ title, angle: topic?.angle ?? "", v: PROMPT_VERSIONS.research });
/** Identity of the dossier's content, for everything downstream. */
export const researchHash = (r: ResearchFile | null) => (r ? hashOf({ ...r, at: null }) : null);
export const outlineInputHash = (rHash: string | null, settings: Settings, format: Format) => hashOf({ research: rHash, duration: formatKey(settings, format), format, v: PROMPT_VERSIONS.outline });
export const outlineHash = (o: OutlineEntry | undefined) => (o ? hashOf({ ...o, at: null }) : null);
export const reviewInputHash = (spec: VideoSpec, oHash: string | null) => hashOf({ script: scriptText(spec), outline: oHash, v: PROMPT_VERSIONS.review });

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

/** Usable claims only, trimmed for prompts (sources keep url/title so writers know provenance). */
function dossierForPrompt(r: ResearchFile) {
  return {
    audience: r.audience,
    centralQuestion: r.qualification.centralQuestion,
    angle: r.qualification.selectedAngle,
    shortInsight: r.qualification.shortInsight,
    mechanism: r.mechanism,
    thesis: r.thesis,
    prerequisites: r.prerequisites,
    claims: r.claims.map((c) => ({ id: c.id, text: c.text, status: c.status, qualification: c.qualification, note: c.note, importance: c.importance, sources: USABLE.includes(c.status) ? c.sources.map((s) => ({ url: s.url, title: s.title })) : undefined })),
    misconceptions: r.misconceptions,
    examples: r.examples,
    insights: r.insights,
    uncertainties: r.uncertainties,
    exclusions: r.exclusions,
  };
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
  const inputHash = researchInputHash(ctx.title, ctx.topic);
  const existing = loadResearch(ctx.slug);
  if (existing && existing.inputHash === inputHash && !ctx.force) {
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
  if (r.inputHash !== researchInputHash(ctx.title, ctx.topic)) throw new PipelineError("The research dossier is out of date for this topic: run the research stage first", "missing");
  const blockers = researchBlockers(r);
  if (blockers.length) throw new PipelineError(blockers.join("; "), "editorial");
  return r;
}

// ---------- outline ----------

export async function outlineStage(ctx: RunCtx): Promise<StageResult> {
  const research = requireResearch(ctx);
  const rHash = researchHash(research)!;
  const outlines = loadOutlines(ctx.slug);
  const done: string[] = [];
  let cached = true;
  for (const format of ctx.formats) {
    const inputHash = outlineInputHash(rHash, ctx.settings, format);
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
      `\n## Research dossier\n${JSON.stringify(dossierForPrompt(research), null, 1)}`,
    ].join("\n");
    console.log(`  outlining the ${FORMAT_LABEL[format]} with claude -p`);
    const reply = await claudeJson<Outline>(brief, { step: "outline", label: `outline ${format}`, check: (o) => validateOutline(o, research, ctx.settings, format), fieldRepair: { context: () => `Claim ids: ${research.claims.map((c) => c.id).join(", ")}` } });
    const entry: OutlineEntry = { ...reply, format, inputHash, researchHash: rHash, durationKey: formatKey(ctx.settings, format), at: new Date().toISOString(), promptVersion: PROMPT_VERSIONS.outline };
    saveOutline(ctx.slug, format, entry);
    const b = outlineBlockers(entry);
    if (b.length) throw new PipelineError(b.join("; "), "editorial", "Choose a narrower or richer angle (backlog), or change the duration in Settings.");
    done.push(`${format}: ${entry.beats.length} beats, ${entry.structure}, planned ${fmt(entry.beats.reduce((n, x) => n + x.seconds, 0))}`);
  }
  return { summary: done.join("; "), cached };
}

// ---------- script ----------

type ScriptShot = Omit<Shot, "visual"> & { beat?: string };
export type ScriptReply = Omit<VideoSpec, "schemaVersion" | "shots"> & { shots: ScriptShot[] };

/** Structural, evidence and runtime checks on a script reply. Problems go back to Claude once. */
export function checkScript(r: ScriptReply, format: Format, research: Research | null, settings: Settings, strictDuration = false): string[] {
  const p: string[] = [];
  const min = format === "short" ? 3 : 8;
  if (!Array.isArray(r?.shots) || r.shots.length < min) return [`shots must list at least ${min} shots`];
  const cm = claimMap(research);
  const ids = new Set<string>();
  r.shots.forEach((s, i) => {
    const at = `shot ${i + 1}${s?.id ? ` (${s.id})` : ""}`;
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s.id ?? "") || ids.has(s.id)) p.push(`${at}: id must be unique kebab-case`);
    ids.add(s.id);
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
    shots: r.shots.map(({ beat, short: _short, ...s }) => ({
      ...s,
      purpose: beat ? `${beat}: ${s.purpose ?? ""}`.replace(/: $/, "") : s.purpose,
      visual: s.section === "chorus" ? { type: "kinetic", style: "punch" } : { type: "kinetic", style: "stack", lines: [s.headline ?? s.narration!.split(/\s+/).slice(0, 5).join(" ")] },
    })) as Shot[],
  };
}

/** Whether a format's script is current: written from this outline, under these duration settings, with this prompt. */
export function scriptFreshness(slug: string, format: Format, settings: Settings): { status: "fresh" | "stale" | "missing"; reason: string } {
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
  return { status: "fresh", reason: `${spec.shots.length} shots, est. ${fmt(e.estimate?.seconds ?? 0)}` };
}

async function writeScript(ctx: RunCtx, format: Format, research: ResearchFile, outline: OutlineEntry, extra: string[] = []) {
  const topic = ctx.topic;
  const brief = [
    prompt("script"),
    durationBrief(ctx.settings, format),
    `\nTopic: ${ctx.title}`,
    `Use slug: ${ctx.slug}`,
    topic?.chorusIdea ? `Producer's chorus idea (use it only if it states the mechanism accurately): ${topic.chorusIdea}` : "",
    topic?.notes ? `Producer notes: ${topic.notes}` : "",
    topic?.review?.notes ? `Notes from the last human review (address them): ${topic.review.notes}` : "",
    `\n## Approved outline (${FORMAT_LABEL[format]})\n${JSON.stringify({ ...outline, inputHash: undefined, researchHash: undefined, durationKey: undefined, at: undefined }, null, 1)}`,
    `\n## Research dossier\n${JSON.stringify(dossierForPrompt(research), null, 1)}`,
    ...extra,
  ].filter(Boolean).join("\n");
  console.log(`  writing the ${FORMAT_LABEL[format]} script with claude -p`);
  let reply = await claudeJson<ScriptReply>(brief, { step: "script", label: `script ${format}`, check: (r) => checkScript(r, format, research, ctx.settings) });
  // Length is checked after the structural checks so the model gets one precise, numeric retry. If it still
  // misses, the script is kept and the miss is surfaced (the editorial review judges format fit, and the
  // measured audio is the final gate) instead of failing before anyone can look at it.
  const miss = checkScript(reply, format, research, ctx.settings, true);
  if (miss.length) {
    console.log(`  ${FORMAT_LABEL[format]} length: ${miss[0]}`);
    try {
      reply = await claudeJson<ScriptReply>(`${brief}\n\n## Your previous attempt missed the length\n${miss[0]}\nPrevious attempt:\n${JSON.stringify(reply.shots.map((x) => ({ id: x.id, section: x.section, narration: x.narration, lyric: x.lyric, claims: x.claims })), null, 1)}\nRewrite it with the length fixed, changing as little else as possible.`, { step: "scriptFix", label: `script ${format} (length)`, callKind: "regeneration", reason: "length miss: editorial length criterion unchanged, whole script rewritten with measured numbers", check: (r) => checkScript(r, format, research, ctx.settings, true) });
    } catch (e) {
      if (!(e instanceof PipelineError) || e.kind !== "invalid") throw e;
      console.log(`  keeping the first ${FORMAT_LABEL[format]} script; its length miss will be flagged`);
    }
  }
  const spec = toSpec(reply, ctx.slug, format);
  const est = estimateRuntime(spec, format, ctx.settings.narration.wordsPerMinute);
  const check = checkDuration(est.seconds, ctx.settings, format);
  spec.editorial = {
    outlineHash: outlineHash(outline)!,
    researchHash: researchHash(research)!,
    durationKey: formatKey(ctx.settings, format),
    promptVersion: PROMPT_VERSIONS.script,
    estimate: { seconds: Math.round(est.seconds * 10) / 10, spokenWords: est.spokenWords, sungWords: est.sungWords, wordsPerMinute: est.wordsPerMinute, verdict: check.verdict, message: check.message },
    at: new Date().toISOString(),
  };
  return { spec, check };
}

export async function scriptStage(ctx: RunCtx): Promise<StageResult> {
  const research = requireResearch(ctx);
  const outlines = loadOutlines(ctx.slug);
  const done: string[] = [];
  const warnings: string[] = [];
  let cached = true;
  for (const format of ctx.formats) {
    const fresh = scriptFreshness(ctx.slug, format, ctx.settings);
    const revise = ctx.revise?.[format];
    if (fresh.status === "fresh" && !ctx.fresh && !ctx.force && !revise) {
      done.push(`${format}: kept (${fresh.reason})`);
      continue;
    }
    const outline = outlines.formats[format];
    if (!outline || outline.inputHash !== outlineInputHash(researchHash(research), ctx.settings, format)) throw new PipelineError(`The ${FORMAT_LABEL[format]} outline is missing or out of date: run the outline stage first`, "missing");
    cached = false;
    const extra = revise ? [`\n## Revise the previous version\n${revise}\n\nPrevious version:\n${JSON.stringify(ownSpec(ctx.slug, format)?.shots.map((s) => ({ id: s.id, section: s.section, narration: s.narration, lyric: s.lyric, claims: s.claims })), null, 1)}`] : [];
    const { spec, check } = await writeScript(ctx, format, research, outline, extra);
    saveSpec(ctx.slug, spec, revise ? `before-revision-${format}` : `fresh-script-${format}`, format);
    if (check.verdict === "off-target") warnings.push(`${FORMAT_LABEL[format]}: ${check.message}`);
    done.push(`${format}: ${spec.shots.length} shots, ${spec.editorial!.estimate!.spokenWords} words, est. ${fmt(spec.editorial!.estimate!.seconds)}`);
  }
  return { summary: done.join("; "), cached, warnings };
}

// ---------- editorial review ----------

export function reviewFreshness(slug: string, format: Format): { status: "fresh" | "stale" | "missing" | "failed"; reason: string } {
  const spec = ownSpec(slug, format);
  if (!spec) return { status: "missing", reason: "no script for this format" };
  const r = loadReviews(slug).formats[format];
  if (!r) return { status: "missing", reason: "not reviewed" };
  const oHash = outlineHash(loadOutlines(slug).formats[format]);
  if (r.inputHash !== reviewInputHash(spec, oHash)) return { status: "stale", reason: "the script changed since the review" };
  if (!r.verdict.pass) return { status: "failed", reason: `editorial review failed: ${r.verdict.reasons.slice(0, 2).join("; ")}` };
  return { status: "fresh", reason: `passed, average ${r.verdict.average}` };
}

function reviewPrompt(spec: VideoSpec, format: Format, research: ResearchFile, outline: OutlineEntry, settings: Settings) {
  const est = estimateRuntime(spec, format, settings.narration.wordsPerMinute);
  const rubric = Object.entries(RUBRIC).map(([k, v]) => `- ${k}: ${v}`).join("\n");
  return [
    prompt("review").replace("{{RUBRIC}}", rubric),
    `\nPass rules (applied by the pipeline): every criterion >= ${PASS_RULES.minEach}, ${Object.entries(PASS_RULES.critical).map(([k, v]) => `${k} >= ${v}`).join(", ")}, average >= ${PASS_RULES.minAverage}, and no blocking problem.`,
    durationBrief(settings, format),
    `Estimated runtime of this script: ${fmt(est.seconds)} (${est.spokenWords} spoken words, ${est.sungWords} sung words, ${est.shots} shots).`,
    format === "short" ? "This Short must stand on its own: judge it as if the viewer never sees the landscape video." : "",
    `\n## Script\n${JSON.stringify(spec.shots.map((s) => ({ id: s.id, section: s.section, purpose: s.purpose, narration: s.narration, lyric: s.lyric, headline: s.headline, claims: s.claims })), null, 1)}`,
    `\n## Approved outline\n${JSON.stringify({ ...outline, inputHash: undefined, researchHash: undefined, durationKey: undefined }, null, 1)}`,
    `\n## Research dossier\n${JSON.stringify(dossierForPrompt(research), null, 1)}`,
  ].filter(Boolean).join("\n");
}

export async function reviewStage(ctx: RunCtx): Promise<StageResult> {
  const research = requireResearch(ctx);
  const maxRevisions = Number(process.env.REVIEW_MAX_REVISIONS ?? 1);
  const done: string[] = [];
  let cached = true;
  for (const format of ctx.formats) {
    let spec = ownSpec(ctx.slug, format);
    if (!spec) throw new PipelineError(`No ${FORMAT_LABEL[format]} script to review: run the script stage first`, "missing");
    const outline = loadOutlines(ctx.slug).formats[format];
    if (!outline) throw new PipelineError(`No ${FORMAT_LABEL[format]} outline: run the outline stage first`, "missing");
    const oHash = outlineHash(outline)!;
    const prev = loadReviews(ctx.slug).formats[format];
    if (prev && prev.inputHash === reviewInputHash(spec, oHash) && prev.verdict.pass && !ctx.force) {
      done.push(`${format}: passed (cached, average ${prev.verdict.average})`);
      continue;
    }
    cached = false;
    const history: ReviewEntry["history"] = prev && prev.inputHash === reviewInputHash(spec, oHash) ? prev.history : [];
    // A stored failing review of this exact script is reused, so a re-run goes straight to revision.
    let reply: ReviewReply | null = prev && !prev.verdict.pass && prev.inputHash === reviewInputHash(spec, oHash) && !ctx.force ? prev : null;
    for (let round = 0; ; round++) {
      if (!reply) {
        console.log(`  editorial review of the ${FORMAT_LABEL[format]} (round ${round + 1})`);
        reply = await claudeJson<ReviewReply>(reviewPrompt(spec, format, research, outline, ctx.settings), { step: "review", label: `review ${format}`, check: (r) => validateReview(r), fieldRepair: true });
        // A reviewer naming a shot that doesn't exist is a slip, not a reason to discard the review: keep the finding, drop the bad reference.
        const known = new Set(spec.shots.map((s) => s.id));
        const fix = <T extends { shot?: string; problem: string }>(x: T): T => (x.shot && !known.has(x.shot) ? { ...x, shot: undefined, problem: `(${x.shot}) ${x.problem}` } : x);
        reply = { ...reply, blocking: reply.blocking.map(fix), findings: reply.findings.map(fix) };
      }
      const verdict = reviewVerdict(reply);
      history.push({ at: new Date().toISOString(), scores: reply.scores, verdict, revised: false });
      const entry: ReviewEntry = {
        scores: reply.scores, blocking: reply.blocking, findings: reply.findings, summary: reply.summary,
        format, inputHash: reviewInputHash(spec, oHash), scriptHash: hashOf(scriptText(spec)), outlineHash: oHash, at: new Date().toISOString(), verdict,
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
      // Bounded revision: rewrite the script from the same outline with the review's findings.
      const notes = [
        `The editorial review failed this script (${verdict.reasons.join("; ")}).`,
        reply.blocking.length ? `Blocking problems:\n${reply.blocking.map((b) => `- ${b.shot ? `${b.shot}: ` : ""}${b.problem}`).join("\n")}` : "",
        `Findings to fix:\n${reply.findings.map((f) => `- ${f.shot ?? ""} [${f.criterion ?? ""}] ${f.problem} Fix: ${f.fix}`).join("\n")}`,
        "Rewrite the whole script so it fixes these problems, still following the outline and the dossier. Keep what worked.",
      ].filter(Boolean).join("\n\n");
      const prevShots = spec.shots.map((s) => ({ id: s.id, section: s.section, narration: s.narration, lyric: s.lyric, claims: s.claims }));
      const { spec: next } = await writeScript(ctx, format, research, outline, [`\n## Revise the previous version\n${notes}\n\nPrevious version:\n${JSON.stringify(prevShots, null, 1)}`]);
      saveSpec(ctx.slug, next, `before-review-revision-${format}`, format);
      history[history.length - 1].revised = true;
      spec = next;
      reply = null;
    }
  }
  return { summary: done.join("; "), cached };
}

