// Claude stages: script, fact-check (incremental, with bounded revision) and
// creative direction (whole storyboard or selected shots).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ANCHORS, CAMERA_MOVES, ICONS, JOURNEY_SCENES, SCENES_3D, SECTIONS, SFX, TRANSITIONS, lintSpec, migrateSpec, textOf, validateSpec,
} from "../../src/schema/storyboard.mjs";
import type { Shot, VideoSpec } from "../../src/schema/storyboard.mjs";
import { claudeJson } from "../claude";
import { archive, paths, PipelineError, readJson, ROOT, writeJson } from "../core/files";
import type { RunCtx, StageResult } from "./types";

const prompt = (name: string) => readFileSync(join(ROOT, "prompts", `${name}.md`), "utf8");

export function loadSpec(slug: string): VideoSpec | null {
  const raw = readJson<unknown>(paths.spec(slug), null);
  return raw ? migrateSpec(raw) : null;
}

export function saveSpec(slug: string, spec: VideoSpec, reason: string) {
  const problems = validateSpec(spec, { slug });
  if (problems.length) throw new PipelineError(`Refusing to save an invalid storyboard: ${problems.slice(0, 6).join("; ")}`, "invalid");
  archive(slug, paths.spec(slug), reason);
  writeJson(paths.spec(slug), spec);
}

// ---------- script ----------

type ScriptReply = Omit<VideoSpec, "schemaVersion" | "shots"> & { shots: Omit<Shot, "visual">[] };

function checkScript(r: ScriptReply): string[] {
  const p: string[] = [];
  if (!Array.isArray(r?.shots) || r.shots.length < 5) return ["shots must list at least 5 shots"];
  const ids = new Set<string>();
  r.shots.forEach((s, i) => {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s.id ?? "") || ids.has(s.id)) p.push(`shot ${i + 1}: id must be unique kebab-case`);
    ids.add(s.id);
    if (!SECTIONS.includes(s.section)) p.push(`shot ${i + 1}: bad section`);
    if (s.section === "chorus" ? !s.lyric : !s.narration) p.push(`shot ${i + 1}: ${s.section === "chorus" ? "chorus needs a lyric" : "needs narration"}`);
    if (s.narration && s.narration.split(/\s+/).length > 40) p.push(`shot ${i + 1}: narration over 40 words`);
  });
  if (!r.music?.bpm) p.push("music.bpm is required");
  return p;
}

/** A draft storyboard: script text with placeholder kinetic visuals until the director runs. */
function draftFromScript(r: ScriptReply, slug: string): VideoSpec {
  return {
    schemaVersion: 2,
    slug,
    title: r.title,
    brief: r.brief,
    world: r.world ?? "night",
    direction: { status: "draft", at: new Date().toISOString(), by: "script" },
    music: r.music,
    shots: r.shots.map((s) => ({
      ...s,
      visual: s.section === "chorus" ? { type: "kinetic", style: "punch" } : { type: "kinetic", style: "stack", lines: [s.headline ?? s.narration!.split(/\s+/).slice(0, 5).join(" ")] },
    })) as Shot[],
  };
}

export async function scriptStage(ctx: RunCtx): Promise<StageResult> {
  const existing = readJson<Record<string, unknown> | null>(paths.spec(ctx.slug), null);
  if (existing && !ctx.fresh) {
    if (existing.schemaVersion !== 2) {
      const migrated = migrateSpec(existing);
      saveSpec(ctx.slug, { ...migrated, direction: { status: "draft", at: new Date().toISOString(), by: "migrate-v1" } }, "v1-before-migrate");
      return { summary: "migrated the v1 spec to a v2 draft storyboard", cached: false };
    }
    return { summary: "kept the existing script (use a fresh script to rewrite it)", cached: true };
  }
  if (existing) {
    archive(ctx.slug, paths.sources(ctx.slug), "fresh-script");
  }
  const topic = ctx.topic;
  const brief = [
    prompt("script"),
    `Topic: ${ctx.title}`,
    topic?.angle ? `Hook idea: ${topic.angle}` : "",
    topic?.chorusIdea ? `Chorus idea: ${topic.chorusIdea}` : "",
    topic?.notes ? `Producer notes: ${topic.notes}` : "",
    topic?.review?.notes ? `Notes from the last review (address them): ${topic.review.notes}` : "",
    `Use slug: ${ctx.slug}`,
  ].filter(Boolean).join("\n");
  console.log(`  writing the script with claude -p`);
  const reply = await claudeJson<ScriptReply>(brief, { check: checkScript, label: "script" });
  const spec = draftFromScript(reply, ctx.slug);
  saveSpec(ctx.slug, spec, "fresh-script");
  const words = spec.shots.reduce((n, s) => n + (s.narration?.split(/\s+/).length ?? 0), 0);
  return { summary: `${spec.shots.length} shots, ${words} words of narration`, cached: false };
}

// ---------- fact-check ----------

type Claim = { shot?: string; claim: string; verdict: "ok" | "fix" | "cut"; correction?: string; note?: string; sources?: string[] };
type Sources = { claims: Claim[]; checkedAt?: string; history?: { at: string; flagged: number; revised: boolean }[] };

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

/** Items that have no "ok" verdict yet. */
export function uncheckedItems(spec: VideoSpec, sources: Sources | null) {
  const ok = new Set((sources?.claims ?? []).filter((c) => c.verdict === "ok").map((c) => c.claim));
  return factItems(spec).filter((i) => !ok.has(i.text));
}

export async function factcheckStage(ctx: RunCtx): Promise<StageResult> {
  const loaded = loadSpec(ctx.slug);
  if (!loaded) throw new PipelineError("No storyboard yet: run the script stage first", "missing");
  let spec: VideoSpec = loaded;
  const maxRounds = Number(process.env.FACTCHECK_MAX_REVISIONS ?? 2);
  let revised = 0;
  for (let round = 0; ; round++) {
    const sources = readJson<Sources | null>(paths.sources(ctx.slug), null);
    const todo = uncheckedItems(spec, sources);
    if (!todo.length) {
      const all = factItems(spec).length;
      return { summary: `${all} items ok${revised ? ` after ${revised} revision(s)` : ""}`, cached: round === 0 && revised === 0 };
    }
    console.log(`  checking ${todo.length} new or flagged item(s) with web search${round ? ` (after revision ${round})` : ""}`);
    const reply = await claudeJson<{ claims: Claim[] }>(`${prompt("factcheck")}\n\nItems:\n${JSON.stringify(todo.map((t) => ({ shot: t.shot, text: t.text })), null, 1)}`, {
      allowedTools: ["WebSearch", "WebFetch"],
      label: "factcheck",
      check: (r) => (Array.isArray(r?.claims) && r.claims.length === todo.length ? [] : [`return exactly ${todo.length} claims, one per item, in order`]),
    });
    // Merge: keep ok verdicts for text still present, replace the rest.
    const present = new Set(factItems(spec).map((i) => i.text));
    const fresh = reply.claims.map((c, i) => ({ ...c, shot: todo[i].shot, claim: todo[i].text }));
    const kept = (sources?.claims ?? []).filter((c) => c.verdict === "ok" && present.has(c.claim) && !fresh.some((x) => x.claim === c.claim));
    const merged: Sources = { claims: [...kept, ...fresh], checkedAt: new Date().toISOString(), history: [...(sources?.history ?? []), { at: new Date().toISOString(), flagged: fresh.filter((c) => c.verdict !== "ok").length, revised: revised > 0 }] };
    if (sources) archive(ctx.slug, paths.sources(ctx.slug), "factcheck");
    writeJson(paths.sources(ctx.slug), merged);
    const flagged = fresh.filter((c) => c.verdict !== "ok");
    if (!flagged.length) continue;
    console.log(`  fact-check flagged ${flagged.length} claim(s):`);
    for (const c of flagged) console.log(`    - [${c.verdict}] ${c.claim}`);
    if (round >= maxRounds) {
      throw new PipelineError(`Still ${flagged.length} flagged claim(s) after ${maxRounds} revisions; see the Fact-check tab`, "quality", "Edit the flagged text in the Storyboard tab, then run the fact-check again.");
    }
    console.log(`  revising (round ${round + 1}/${maxRounds})`);
    const before: VideoSpec = spec;
    const next: VideoSpec = await claudeJson<VideoSpec>(`${prompt("revise")}\n\nFlagged claims:\n${JSON.stringify(flagged, null, 2)}\n\nVideoSpec:\n${JSON.stringify(spec)}`, {
      label: "revise",
      check: (r) => {
        const p = validateSpec({ ...r, slug: ctx.slug }, { slug: ctx.slug });
        if (r?.shots?.length !== before.shots.length || r.shots.some((s, i) => s.id !== before.shots[i].id || s.visual?.type !== before.shots[i].visual.type)) p.push("keep the same shots, ids and visual types in the same order");
        return p;
      },
    });
    spec = { ...next, slug: ctx.slug, direction: before.direction };
    saveSpec(ctx.slug, spec, "before-factcheck-revision");
    revised++;
  }
}

// ---------- creative direction ----------

type DirectReply = { world?: VideoSpec["world"]; shots: Partial<Shot>[] };

function directorPrompt(spec: VideoSpec, targets: string[], notes?: string) {
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
    title: spec.title, brief: spec.brief, world: spec.world, bpm: spec.music.bpm,
    shots: spec.shots.map((s) => ({ id: s.id, section: s.section, purpose: s.purpose, narration: s.narration, lyric: s.lyric, headline: s.headline, short: s.short })),
  };
  const all = targets.length === spec.shots.length;
  return [
    catalog,
    `\n## The script\n${JSON.stringify(script, null, 1)}`,
    all ? "" : `\n## Current storyboard (keep continuity with the shots you are not changing)\n${JSON.stringify(spec.shots.map((s) => ({ id: s.id, visual: s.visual, camera: s.camera, mascot: s.mascot })), null, 1)}`,
    `\n## Direct these shots\n${targets.join(", ")}`,
    notes ? `\n## Review notes to address\n${notes}` : "",
  ].join("\n");
}

export function mergeDirection(spec: VideoSpec, reply: DirectReply, targets: string[]): VideoSpec {
  const byId = new Map(reply.shots.map((s) => [s.id, s]));
  return {
    ...spec,
    world: reply.world ?? spec.world,
    direction: { status: "directed", at: new Date().toISOString(), by: "claude" },
    shots: spec.shots.map((s) => {
      const d = byId.get(s.id);
      if (!d || !targets.includes(s.id)) return s;
      const keep = { id: s.id, section: s.section, purpose: s.purpose, narration: s.narration, lyric: s.lyric, short: s.short, assets: s.assets };
      return Object.fromEntries(Object.entries({ ...keep, visual: d.visual, headline: d.headline ?? (d.visual?.type === "title" || d.visual?.type === "kinetic" ? undefined : s.headline), camera: d.camera, transition: d.transition, mascot: d.mascot ?? undefined, accents: d.accents, minBars: d.minBars }).filter(([, v]) => v !== undefined)) as Shot;
    }),
  };
}

export async function directStage(ctx: RunCtx): Promise<StageResult> {
  const spec = loadSpec(ctx.slug);
  if (!spec) throw new PipelineError("No storyboard yet: run the script stage first", "missing");
  const targets = ctx.shots?.length ? ctx.shots : spec.direction?.status === "directed" && !ctx.force ? [] : spec.shots.map((s) => s.id);
  if (!targets.length) return { summary: "storyboard already directed (pick shots to redirect)", cached: true };
  const unknown = targets.filter((t) => !spec.shots.some((s) => s.id === t));
  if (unknown.length) throw new PipelineError(`Unknown shot id(s): ${unknown.join(", ")}`, "invalid");
  console.log(`  directing ${targets.length} shot(s) with claude -p`);
  const reply = await claudeJson<DirectReply>(directorPrompt(spec, targets, ctx.notes), {
    label: "direct",
    check: (r) => {
      if (!Array.isArray(r?.shots)) return ["shots must be a list"];
      const missing = targets.filter((t) => !r.shots.some((s) => s.id === t));
      const merged = mergeDirection(spec, r, targets);
      return [...missing.map((m) => `missing shot ${m}`), ...validateSpec(merged, { slug: ctx.slug }).filter((x) => targets.some((t) => x.includes(`(${t})`)) || !x.startsWith("shot "))];
    },
  });
  const next = mergeDirection(spec, reply, targets);
  saveSpec(ctx.slug, next, "before-direction");
  const types = targets.map((t) => next.shots.find((s) => s.id === t)!.visual.type);
  return { summary: `directed ${targets.length} shot(s): ${[...new Set(types)].join(", ")}`, warnings: lintSpec(next), cached: false };
}

export const specExists = (slug: string) => existsSync(paths.spec(slug));
