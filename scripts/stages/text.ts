// Storyboard files per format, the fact-check (incremental, claim-level, with
// bounded targeted revision) and creative direction (whole storyboard or
// selected shots). Research, outline, script and editorial review live in
// editorial.ts.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ANCHORS, CAMERA_MOVES, ICONS, JOURNEY_SCENES, SCENES_3D, SFX, TRANSITIONS, lintSpec, migrateSpec, textOf, validateSpec,
} from "../../src/schema/storyboard.mjs";
import type { Shot, VideoSpec } from "../../src/schema/storyboard.mjs";
import { aiJson } from "../ai";
import { archive, paths, PipelineError, readJson, ROOT, writeJson } from "../core/files";
import { evidenceForClaims } from "../../src/schema/evidence.mjs";
import { PROMPT_VERSIONS } from "../../src/schema/editorial.mjs";
import type { Format, RunCtx, StageResult } from "./types";

export const prompt = (name: string) => readFileSync(join(ROOT, "prompts", `${name}.md`), "utf8");

/**
 * The storyboard for a cut. Each format has its own (specs/<slug>.json for the
 * landscape video, specs/<slug>.short.json for the Short). Videos made before
 * formats were split have one storyboard that serves both cuts (the Short uses
 * its shots marked `short`), so a missing Short storyboard falls back to it.
 */
export function loadSpec(slug: string, format: Format = "main"): VideoSpec | null {
  if (format === "short") {
    const own = readJson<unknown>(paths.shortSpec(slug), null);
    if (own) return migrateSpec(own);
  }
  const raw = readJson<unknown>(paths.spec(slug), null);
  return raw ? migrateSpec(raw) : null;
}

/** The storyboard written for exactly this format, or null (legacy single storyboards count as landscape only). */
export function ownSpec(slug: string, format: Format): VideoSpec | null {
  const spec = loadSpec(slug, format);
  if (!spec) return null;
  if (format === "short") return existsSync(paths.shortSpec(slug)) ? spec : null;
  return spec.format === "short" ? null : spec;
}

/** Distinct storyboards behind the requested cuts (a legacy storyboard serving both cuts appears once). */
export function specsFor(slug: string, formats: Format[]): { format: Format; spec: VideoSpec; formats: Format[]; file: Format }[] {
  const out: { format: Format; spec: VideoSpec; formats: Format[]; path: string; file: Format }[] = [];
  for (const f of formats) {
    const spec = loadSpec(slug, f);
    if (!spec) continue;
    const path = f === "short" && existsSync(paths.shortSpec(slug)) ? paths.shortSpec(slug) : paths.spec(slug);
    const same = out.find((x) => x.path === path);
    if (same) same.formats.push(f);
    else out.push({ format: f, spec, formats: [f], path, file: path === paths.shortSpec(slug) ? "short" : "main" });
  }
  return out;
}

export function saveSpec(slug: string, spec: VideoSpec, reason: string, format: Format = spec.format ?? "main") {
  const problems = validateSpec(spec, { slug });
  if (problems.length) throw new PipelineError(`Refusing to save an invalid storyboard: ${problems.slice(0, 6).join("; ")}`, "invalid");
  const path = format === "short" ? paths.shortSpec(slug) : paths.spec(slug);
  archive(slug, path, reason);
  writeJson(path, spec);
}

/** Where a format's storyboard lives, for messages. */
export const specFile = (slug: string, format: Format) => (format === "short" ? `specs/${slug}.short.json` : `specs/${slug}.json`);

// ---------- fact-check ----------

export type SourceRef = string | { url: string; title?: string; passage?: string };
export type Claim = { shot?: string; format?: Format; claim: string; evidenceIds?: string[]; verificationHash?: string; verdict: "ok" | "fix" | "cut"; correction?: string; note?: string; sources?: SourceRef[] };
/** specs/<slug>.sources.json: verdicts keyed by exact text, shared by both cuts (the same sentence is verified once). */
export type Sources = { claims: Claim[]; checkedAt?: string; researchHash?: string | null; history?: { at: string; flagged: number; revised: boolean }[] };

export const sourceUrl = (s: SourceRef) => (typeof s === "string" ? s : s.url);

export function factItems(spec: VideoSpec) {
  const seen = new Set<string>();
  const items: { shot: string; text: string }[] = [];
  for (const t of textOf(spec)) {
    for (const text of [t.narration, t.lyric, t.headline, ...t.labels]) {
      if (!text || seen.has(text)) continue;
      seen.add(text);
      items.push({ shot: t.shot, text });
    }
  }
  return items;
}

/**
 * Verdicts carry over only while the research they were checked against is
 * the same: a new dossier means every sentence is checked again, so an old
 * claim never survives just because it passed an earlier fact-check.
 */
export function reusableSources(sources: Sources | null, rHash: string | null): Sources | null {
  if (!sources) return null;
  if ((sources.researchHash ?? null) !== (rHash ?? null)) return { ...sources, claims: [] };
  return sources;
}

/** Items that have no "ok" verdict yet. */
export function uncheckedItems(spec: VideoSpec, sources: Sources | null, expectedHashes?: Map<string, string>) {
  const ok = new Set((sources?.claims ?? []).filter((c) => c.verdict === "ok" && (!expectedHashes || c.verificationHash === expectedHashes.get(c.claim))).map((c) => c.claim));
  return factItems(spec).filter((i) => !ok.has(i.text));
}

const factFormats = (slug: string, formats: Format[]) => specsFor(slug, formats);

export async function factcheckStage(ctx: RunCtx): Promise<StageResult> {
  const groups = factFormats(ctx.slug, ctx.formats);
  if (!groups.length) throw new PipelineError("No storyboard yet: run the script stage first", "missing");
  const { factcheckItemHash, loadEvidence, loadResearch, researchHash } = await import("./editorial");
  const research = loadResearch(ctx.slug);
  const rHash = researchHash(research);
  const evidence = loadEvidence(ctx.slug);
  if (research && (!evidence || evidence.researchHash !== rHash)) throw new PipelineError("Canonical evidence is missing or out of date: run the research stage to normalize it", "missing");
  const maxRounds = Number(process.env.FACTCHECK_MAX_REVISIONS ?? 2);
  const specs = new Map(groups.map((g) => [g.format, g.spec]));
  let revised = 0;
  for (let round = 0; ; round++) {
    const sources = reusableSources(readJson<Sources | null>(paths.sources(ctx.slug), null), rHash);
    const byText = new Map<string, { shot: string; format: Format; text: string; claimIds: string[] }>();
    for (const [format, spec] of specs) for (const item of factItems(spec)) {
      const claimIds = spec.shots.find((shot) => shot.id === item.shot)?.claims ?? [];
      const prior = byText.get(item.text);
      if (prior) prior.claimIds = [...new Set([...prior.claimIds, ...claimIds])];
      else byText.set(item.text, { ...item, format, claimIds: [...claimIds] });
    }
    const allItems = [...byText.values()];
    const verificationHashes = new Map(allItems.map((item) => [item.text, factcheckItemHash(item.text, item.claimIds, evidence, ctx.settings)]));
    const todo: { shot: string; text: string; format: Format; claimIds: string[] }[] = [];
    for (const item of allItems) {
      const isCurrent = sources?.claims.some((claim) => claim.claim === item.text && claim.verdict === "ok" && claim.verificationHash === verificationHashes.get(item.text));
      if (!isCurrent) todo.push(item);
    }
    if (!todo.length) {
      const all = new Set([...specs.values()].flatMap((s) => factItems(s).map((i) => i.text))).size;
      return { summary: `${all} items ok across ${[...specs.keys()].join(" + ")}${revised ? ` after ${revised} revision(s)` : ""}`, cached: round === 0 && revised === 0 };
    }
    console.log(`  checking ${todo.length} new or flagged item(s) with web search${round ? ` (after revision ${round})` : ""}`);
    const subset = evidence ? evidenceForClaims(evidence, [...new Set(todo.flatMap((item) => item.claimIds))]) : null;
    const evidenceContext = subset ? `\n\nResearch evidence for context only; independently verify each item:\n${JSON.stringify(subset)}` : "";
    const reply = await aiJson<{ claims: Claim[] }>(`${prompt("factcheck")}${evidenceContext}\n\nItems:\n${JSON.stringify(todo.map((t) => ({ shot: t.shot, text: t.text, evidenceIds: t.claimIds })), null, 1)}`, {
      allowedTools: ["WebSearch", "WebFetch"],
      step: "factcheck",
      label: "factcheck",
      check: (r) => {
        if (!Array.isArray(r?.claims) || r.claims.length !== todo.length) return [`return exactly ${todo.length} claims, one per item, in order`];
        return r.claims.flatMap((c, i) => (c.verdict === "ok" && !/no factual claim/i.test(c.note ?? "") && !(c.sources ?? []).length ? [`item ${i + 1}: an "ok" factual item needs a source`] : []));
      },
    });
    // Merge: keep ok verdicts for text still present, replace the rest.
    const present = new Set([...specs.values()].flatMap((s) => factItems(s).map((i) => i.text)));
    const fresh = reply.claims.map((c, i) => ({ ...c, shot: todo[i].shot, format: todo[i].format, claim: todo[i].text, evidenceIds: todo[i].claimIds, verificationHash: verificationHashes.get(todo[i].text) }));
    const kept = (sources?.claims ?? []).filter((c) => c.verdict === "ok" && present.has(c.claim) && c.verificationHash === verificationHashes.get(c.claim) && !fresh.some((x) => x.claim === c.claim));
    const merged: Sources = { claims: [...kept, ...fresh], checkedAt: new Date().toISOString(), researchHash: rHash, history: [...(sources?.history ?? []), { at: new Date().toISOString(), flagged: fresh.filter((c) => c.verdict !== "ok").length, revised: revised > 0 }] };
    archive(ctx.slug, paths.sources(ctx.slug), "factcheck");
    writeJson(paths.sources(ctx.slug), merged);
    const flagged = fresh.filter((c) => c.verdict !== "ok");
    if (!flagged.length) continue;
    console.log(`  fact-check flagged ${flagged.length} claim(s):`);
    for (const c of flagged) console.log(`    - [${c.verdict}] ${c.claim}`);
    if (round >= maxRounds) {
      throw new PipelineError(`Still ${flagged.length} flagged claim(s) after ${maxRounds} revisions; see the Fact-check tab`, "factcheck", "Edit the flagged text in the Storyboard tab, then run the fact-check again.");
    }
    console.log(`  revising (round ${round + 1}/${maxRounds})`);
    for (const [format, before] of specs) {
      const texts = new Set(factItems(before).map((i) => i.text));
      const mine = flagged.filter((c) => texts.has(c.claim));
      if (!mine.length) continue;
      const mineEvidence = evidence ? evidenceForClaims(evidence, [...new Set(mine.flatMap((claim) => claim.evidenceIds ?? []))]) : null;
      const next = await reviseSpec(ctx.slug, before, mine, format, mineEvidence);
      saveSpec(ctx.slug, next, `before-factcheck-revision-${format}`, groups.find((g) => g.format === format)!.file);
      specs.set(format, next);
    }
    revised++;
  }
}

/** Targeted revision: the selected provider returns only changed shots, which are merged and validated. */
export async function reviseSpec(slug: string, before: VideoSpec, flagged: Claim[], format: Format, claims: unknown): Promise<VideoSpec> {
  const limit = format === "short" ? 32 : 45;
  const targetIds = new Set(flagged.map((claim) => claim.shot).filter(Boolean));
  const affected = before.shots.filter((shot) => targetIds.has(shot.id));
  const reply = await aiJson<{ shots: Shot[] }>(
    `${prompt("revise")}\n\nPer-shot narration limit: ${limit} words.\n\nFlagged claims:\n${JSON.stringify(flagged.map((c) => ({ shot: c.shot, evidenceIds: c.evidenceIds, claim: c.claim, verdict: c.verdict, correction: c.correction, note: c.note })), null, 2)}${claims ? `\n\nRelevant evidence and qualifications:\n${JSON.stringify(claims)}` : ""}\n\nAffected segments only:\n${JSON.stringify(affected)}`,
    {
      step: "revise",
      label: "revise",
      check: (r) => {
        if (!Array.isArray(r?.shots) || !r.shots.length) return ["return { shots: [...] } with the changed shots"];
        const p: string[] = [];
        for (const s of r.shots) {
          const b = before.shots.find((x) => x.id === s?.id);
          if (!b) p.push(`unknown shot id ${s?.id}`);
          else if (s.section !== b.section || s.beatId !== b.beatId || s.visual?.type !== b.visual.type) p.push(`${s.id}: keep the same beatId, section and visual type`);
        }
        if (p.length) return p;
        return validateSpec(mergeShots(before, r.shots), { slug });
      },
    }
  );
  return mergeShots(before, reply.shots);
}

export function mergeShots(spec: VideoSpec, changed: Shot[]): VideoSpec {
  const byId = new Map(changed.map((s) => [s.id, s]));
  return { ...spec, direction: { status: "draft", at: new Date().toISOString(), by: "factcheck-revision" }, shots: spec.shots.map((s) => (byId.has(s.id) ? { ...byId.get(s.id)!, id: s.id, beatId: s.beatId, section: s.section } : s)) };
}

// ---------- creative direction ----------

type DirectReply = { world?: VideoSpec["world"]; shots: Partial<Shot>[] };

function directorPrompt(spec: VideoSpec, targets: string[], notes: string | undefined, context: string) {
  const assets = readJson<{ assets?: { id: string; kind: string; license: string }[] }>(paths.assetsManifest, {}).assets ?? [];
  const catalog = prompt("direct")
    .replace("{{ICONS}}", ICONS.join(", "))
    .replace("{{ANCHORS}}", Object.entries(ANCHORS).map(([k, v]) => `${k}: ${Object.keys(v).join(", ")}`).join("; "))
    .replace("{{ASSETS}}", assets.length ? assets.map((a) => `${a.id} (${a.kind})`).join(", ") : "none")
    .replace("{{JOURNEY_SCENES}}", JOURNEY_SCENES.join(", "))
    .replace("{{CAMERA_MOVES}}", CAMERA_MOVES.join(", "))
    .replace("{{TRANSITIONS}}", TRANSITIONS.join(", "))
    .replace("{{SFX}}", SFX.join(", "))
    .replace("{{SCENES_3D}}", Object.entries(SCENES_3D).map(([k, v]) => `${k} (${v})`).join("; "));
  const script = {
    title: spec.title, format: spec.format ?? "main", brief: spec.brief, world: spec.world, bpm: spec.music.bpm,
    shots: spec.shots.map((s) => ({ id: s.id, section: s.section, purpose: s.purpose, narration: s.narration, lyric: s.lyric, headline: s.headline, short: s.short, claims: s.claims })),
  };
  const all = targets.length === spec.shots.length;
  return [
    catalog,
    context,
    `\n## The script\n${JSON.stringify(script, null, 1)}`,
    all ? "" : `\n## Current storyboard (keep continuity with the shots you are not changing)\n${JSON.stringify(spec.shots.map((s) => ({ id: s.id, visual: s.visual, camera: s.camera, mascot: s.mascot })), null, 1)}`,
    `\n## Direct these shots\n${targets.join(", ")}`,
    notes ? `\n## Review notes to address\n${notes}` : "",
  ].join("\n");
}

/** Outline beats and the research claims the shots state, so visuals show the real mechanism. */
async function directionContext(slug: string, spec: VideoSpec, format: Format) {
  const { loadEvidence, loadOutlines, loadResearch } = await import("./editorial");
  const research = loadResearch(slug);
  const evidence = loadEvidence(slug);
  const outline = loadOutlines(slug).formats[format];
  if (!research && !outline) return "";
  const used = new Set(spec.shots.flatMap((s) => s.claims ?? []));
  return [
    outline ? `\n## Approved outline (show this progression)\n${JSON.stringify({ openingQuestion: outline.openingQuestion, structure: outline.structure, beats: outline.beats.map((b) => ({ id: b.id, role: b.role, point: b.point, visual: b.visual })), keyExample: outline.keyExample, complication: outline.complication, conclusion: outline.conclusion }, null, 1)}` : "",
    research && evidence ? `\n## Evidence stated in the script (visuals must agree, including qualifications)\n${JSON.stringify(evidenceForClaims(evidence, [...used]), null, 1)}\n\n## Relevant demonstrations\n${JSON.stringify(research.examples.filter((example) => (example.claimIds ?? []).some((id) => used.has(id))), null, 1)}` : "",
  ].join("\n");
}

export function mergeDirection(spec: VideoSpec, reply: DirectReply, targets: string[], provider: string = "claude"): VideoSpec {
  const byId = new Map(reply.shots.map((s) => [s.id, s]));
  return {
    ...spec,
    world: reply.world ?? spec.world,
    direction: { status: "directed", at: new Date().toISOString(), by: provider },
    shots: spec.shots.map((s) => {
      const d = byId.get(s.id);
      if (!d || !targets.includes(s.id)) return s;
      const keep = { id: s.id, section: s.section, purpose: s.purpose, narration: s.narration, lyric: s.lyric, short: s.short, claims: s.claims, assets: s.assets };
      return Object.fromEntries(Object.entries({ ...keep, visual: d.visual, headline: d.headline ?? (d.visual?.type === "title" || d.visual?.type === "kinetic" ? undefined : s.headline), camera: d.camera, transition: d.transition, mascot: d.mascot ?? undefined, accents: d.accents, minBars: d.minBars }).filter(([, v]) => v !== undefined)) as Shot;
    }),
  };
}

/** Shots per director call: long scripts are directed in sequential batches with the earlier shots as context. */
const DIRECT_BATCH = Number(process.env.DIRECT_BATCH ?? 12);

export async function directStage(ctx: RunCtx): Promise<StageResult> {
  const groups = specsFor(ctx.slug, ctx.formats);
  if (!groups.length) throw new PipelineError("No storyboard yet: run the script stage first", "missing");
  const { directionInputHash, loadEvidence, loadOutlines, loadResearch } = await import("./editorial");
  const done: string[] = [];
  const warnings: string[] = [];
  let cached = true;
  for (const g of groups) {
    let spec = g.spec;
    const fmtName = g.formats.join("+");
    const evidence = loadEvidence(ctx.slug);
    const outline = loadOutlines(ctx.slug).formats[g.format];
    const research = loadResearch(ctx.slug);
    const inputHash = directionInputHash(spec, outline, evidence, ctx.settings, research);
    const directedFresh = spec.direction?.status === "directed" && spec.direction.inputHash === inputHash;
    const targets = ctx.shots?.length ? ctx.shots.filter((t) => spec.shots.some((s) => s.id === t)) : directedFresh && !ctx.force ? [] : spec.shots.map((s) => s.id);
    if (ctx.shots?.length && groups.length === 1) {
      const unknown = ctx.shots.filter((t) => !spec.shots.some((s) => s.id === t));
      if (unknown.length) throw new PipelineError(`Unknown shot id(s): ${unknown.join(", ")}`, "invalid");
    }
    if (!targets.length) {
      done.push(`${fmtName}: already directed`);
      continue;
    }
    cached = false;
    const context = await directionContext(ctx.slug, spec, g.format);
    for (let i = 0; i < targets.length; i += DIRECT_BATCH) {
      const batch = targets.slice(i, i + DIRECT_BATCH);
      console.log(`  directing ${fmtName} shots ${i + 1}-${i + batch.length} of ${targets.length} with ${ctx.settings.provider}`);
      const current = spec;
      // Later batches see earlier directed shots as "current storyboard" for continuity.
      const reply = await aiJson<DirectReply>(directorPrompt(current, batch, ctx.notes, context), {
        step: "direct",
        label: `direct ${fmtName}`,
        check: (r) => {
          if (!Array.isArray(r?.shots)) return ["shots must be a list"];
          const missing = batch.filter((t) => !r.shots.some((s) => s.id === t));
          const merged = mergeDirection(current, r, batch, ctx.settings.provider);
          return [...missing.map((m) => `missing shot ${m}`), ...validateSpec(merged, { slug: ctx.slug }).filter((x) => batch.some((t) => x.includes(`(${t})`)) || !x.startsWith("shot "))];
        },
      });
      spec = mergeDirection(current, reply, batch, ctx.settings.provider);
      // Unfinished batches keep the storyboard a draft, so an interrupted run resumes.
      if (i + DIRECT_BATCH < targets.length && !ctx.shots?.length) spec = { ...spec, direction: { ...spec.direction!, status: "draft", by: `${ctx.settings.provider} (partial)` } };
      if (i + DIRECT_BATCH >= targets.length && !ctx.shots?.length) spec = { ...spec, direction: { ...spec.direction!, status: "directed", inputHash, promptVersion: PROMPT_VERSIONS.direct } };
      saveSpec(ctx.slug, spec, `before-direction-${g.format}`, g.file);
    }
    const types = targets.map((t) => spec.shots.find((s) => s.id === t)!.visual.type);
    warnings.push(...lintSpec(spec).map((w) => `${fmtName}: ${w}`));
    done.push(`${fmtName}: directed ${targets.length} shot(s): ${[...new Set(types)].join(", ")}`);
  }
  return { summary: done.join("; "), warnings, cached };
}

export const specExists = (slug: string) => existsSync(paths.spec(slug));
