// Asset planning and resolution. Built-in illustrations always resolve.
// External files must have a manifest entry with licence and source, and the
// file must exist under public/. Missing required assets stop the pipeline
// instead of rendering a misleading video.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ICONS } from "../../src/schema/storyboard.mjs";
import type { VideoSpec } from "../../src/schema/storyboard.mjs";
import { hashOf, paths, PipelineError, readJson, ROOT, writeJson } from "../core/files";
import { blenderInfo, renderClip } from "../blender";
import { shotsFor } from "../../src/schema/timeline.mjs";
import { cutSpecs } from "./audio";
import type { CutSpecs } from "./audio";
import type { Format, RunCtx, StageResult } from "./types";

type Entry = { id: string; file: string; kind: string; license?: string; source?: string; attribution?: string };
export type AssetReport = {
  at: string;
  builtins: string[];
  items: { id: string; required: boolean; shots: string[]; status: "ok" | "missing-file" | "no-entry" | "no-license"; file?: string; license?: string; source?: string }[];
  songSrc?: { path: string; ok: boolean } | null;
  missingRequired: number;
  missingOptional: number;
  /** Optional Blender clips: rendered, cached, or falling back to the 2D visual. */
  clips?: Record<string, Partial<Record<"main" | "short", { status: "rendered" | "cached" | "fallback"; src?: string; seconds?: number; renderSeconds?: number; reason?: string }>>>;
  blender?: { available: boolean; enabled: boolean; version: string | null };
  inputHash?: string;
};

function iconRefs(v: unknown, out: Set<string>) {
  if (Array.isArray(v)) v.forEach((x) => iconRefs(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) {
    if (typeof x === "string" && ["icon", "subject", "prop"].includes(k)) out.add(x);
    else iconRefs(x, out);
  }
}

export function assetReport(spec: VideoSpec): AssetReport {
  const manifest = readJson<{ assets?: Entry[] }>(paths.assetsManifest, {}).assets ?? [];
  const builtins = new Set<string>();
  const refs = new Map<string, { required: boolean; shots: Set<string> }>();
  for (const s of spec.shots) {
    const used = new Set<string>();
    iconRefs(s.visual, used);
    for (const u of used) {
      if (u.startsWith("file:")) {
        const r = refs.get(u.slice(5)) ?? { required: true, shots: new Set() };
        r.shots.add(s.id);
        refs.set(u.slice(5), r);
      } else if (ICONS.includes(u)) builtins.add(u);
    }
    for (const a of s.assets ?? []) {
      const r = refs.get(a.id) ?? { required: a.required, shots: new Set() };
      r.required ||= a.required;
      r.shots.add(s.id);
      refs.set(a.id, r);
    }
  }
  const items = [...refs.entries()].map(([id, r]) => {
    const e = manifest.find((m) => m.id === id);
    const status: AssetReport["items"][number]["status"] = !e ? "no-entry" : !e.license?.trim() || !e.source?.trim() ? "no-license" : !existsSync(join(ROOT, "public", e.file)) ? "missing-file" : "ok";
    return { id, required: r.required, shots: [...r.shots], status, file: e?.file, license: e?.license, source: e?.source };
  });
  const songSrc = spec.music.songSrc ? { path: spec.music.songSrc, ok: existsSync(join(ROOT, "public", spec.music.songSrc)) } : null;
  const bad = (i: (typeof items)[number]) => i.status !== "ok";
  return {
    at: new Date().toISOString(),
    builtins: [...builtins].sort(),
    items,
    songSrc,
    missingRequired: items.filter((i) => i.required && bad(i)).length + (songSrc && !songSrc.ok ? 1 : 0),
    missingOptional: items.filter((i) => !i.required && bad(i)).length,
  };
}

/** Every shot of every cut, for asset resolution (a cut's own storyboard decides which shots it uses). */
const union = (specs: CutSpecs): VideoSpec => {
  const base = (specs.main ?? specs.short)!;
  const shots = (Object.keys(specs) as Format[]).flatMap((f) => shotsFor(specs[f]!, f));
  return { ...base, shots: shots.filter((s, i) => shots.indexOf(s) === i) };
};

export const assetsInputHash = (specs: CutSpecs) =>
  hashOf({
    cuts: Object.fromEntries((Object.keys(specs) as Format[]).sort().map((f) => [f, { shots: shotsFor(specs[f]!, f).map((s) => ({ id: s.id, v: s.visual, a: s.assets })), world: specs[f]!.world, song: specs[f]!.music.songSrc }])),
    manifest: readJson(paths.assetsManifest, {}), blender: process.env.BLENDER !== "off" && blenderInfo().available, q: process.env.BLENDER_QUALITY ?? "final",
  });

export const loadAssetReport = (slug: string) => readJson<AssetReport | null>(join(paths.work(slug), "assets.json"), null);

export async function assetsStage(ctx: RunCtx): Promise<StageResult> {
  const specs = cutSpecs(ctx.slug);
  if (!specs.main && !specs.short) throw new PipelineError("No storyboard yet", "missing");
  const report = assetReport(union(specs));
  report.inputHash = assetsInputHash(specs);
  const prev = loadAssetReport(ctx.slug);
  if (prev?.inputHash === report.inputHash && !ctx.force && !report.missingRequired) return { summary: `cached: ${prev.builtins.length} built-in illustrations, clips ${describeClips(prev)}`, cached: true, inputHash: report.inputHash };
  // Optional 3D clips. A failure here never blocks the video: the shot's
  // fallback visual is used and the report says so.
  const b = blenderInfo();
  report.blender = { available: b.available, enabled: b.enabled, version: b.version };
  report.clips = {};
  for (const format of ctx.formats) {
    const spec = specs[format];
    if (!spec) continue;
    for (const s of shotsFor(spec, format)) {
      if (s.visual.type !== "scene3d") continue;
      const scene = s.visual.scene;
      report.clips[s.id] ??= {};
      if (!b.available || !b.enabled) {
        report.clips[s.id][format] = { status: "fallback", reason: b.reason ?? "Blender disabled (BLENDER=off)" };
        continue;
      }
      try {
        const r = await renderClip(spec, s.id, scene, format);
        report.clips[s.id][format] = { status: r.cached ? "cached" : "rendered", src: r.src, seconds: r.seconds, renderSeconds: r.renderSeconds };
      } catch (e) {
        console.log(`  blender clip for ${s.id} (${format}) failed; using the 2D fallback: ${(e as Error).message}`);
        report.clips[s.id][format] = { status: "fallback", reason: (e as Error).message.slice(0, 300) };
      }
    }
  }
  writeJson(join(paths.work(ctx.slug), "assets.json"), report);
  const summary = `${report.builtins.length} built-in illustrations, ${report.items.length} external file(s), clips ${describeClips(report)}${report.missingRequired ? `, ${report.missingRequired} REQUIRED missing` : ""}${report.missingOptional ? `, ${report.missingOptional} optional missing` : ""}`;
  for (const i of report.items.filter((x) => x.status !== "ok")) console.log(`  ${i.required ? "required" : "optional"} asset ${i.id}: ${i.status} (shots ${i.shots.join(", ")})`);
  if (report.missingRequired && !ctx.allowMissingAssets)
    throw new PipelineError(`${report.missingRequired} required asset(s) missing or unlicensed`, "missing", "Add the file under public/ and an entry with license and source to assets/manifest.json, or change the storyboard to a built-in illustration.");
  const fallbacks = Object.entries(report.clips ?? {}).flatMap(([id, c]) => Object.entries(c).filter(([, x]) => x?.status === "fallback").map(([f, x]) => `3D clip for ${id} (${f}) uses its 2D fallback: ${x!.reason}`));
  return { summary, cached: false, inputHash: report.inputHash, warnings: [...(report.missingOptional ? [`${report.missingOptional} optional asset(s) missing`] : []), ...fallbacks] };
}

export function describeClips(r: AssetReport) {
  const all = Object.values(r.clips ?? {}).flatMap((c) => Object.values(c));
  if (!all.length) return "none";
  const n = (st: string) => all.filter((x) => x?.status === st).length;
  return [n("rendered") && `${n("rendered")} rendered`, n("cached") && `${n("cached")} cached`, n("fallback") && `${n("fallback")} 2D fallback`].filter(Boolean).join(", ");
}
