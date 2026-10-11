// Packaging: thumbnail still from the same components, plus YouTube metadata
// (title, description with sources and credits, chapters from the real
// timeline, tags, and the disclosure flags to set deliberately on upload).
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Timeline } from "../../src/schema/timeline.mjs";
import { paths, PipelineError, readJson, writeJson } from "../core/files";
import { loadAudioManifest } from "./audio";
import { loadResearch } from "./editorial";
import { latestCandidate, remotion } from "./render";
import { loadSpec, sourceUrl } from "./text";
import type { Sources } from "./text";
import type { RunCtx, StageResult } from "./types";

const ts = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export async function packageStage(ctx: RunCtx): Promise<StageResult> {
  const spec = loadSpec(ctx.slug);
  const cand = latestCandidate(ctx.slug);
  if (!spec || !cand) throw new PipelineError("Render a candidate first", "missing");
  const qa = readJson<{ status?: string; summary?: string } | null>(join(paths.candidate(ctx.slug, cand.id), "qa", "report.json"), null);
  if (!qa) throw new PipelineError("The latest candidate has not passed QA yet", "quality", "Run the qa stage first.");
  if (qa.status === "fail") throw new PipelineError(`Not packaging a candidate that failed QA: ${qa.summary}`, "quality", "Fix the flagged problems and re-render.");
  const dir = join(paths.candidate(ctx.slug, cand.id), "package");
  const dir0 = paths.candidate(ctx.slug, cand.id);
  const props = existsSync(join(dir0, "props-main.json")) ? join(dir0, "props-main.json") : join(dir0, "props.json");
  await remotion(["still", "src/index.ts", "Thumbnail", join(dir, "thumbnail.png"), `--props=${props}`], "thumbnail");

  const tl = readJson<{ timelines?: { main?: Timeline } }>(props, {}).timelines?.main;
  const chapters: { at: string; title: string }[] = [];
  if (tl) {
    let lastAt = -999;
    for (const t of tl.shots) {
      const s = spec.shots.find((x) => x.id === t.id)!;
      const title = s.headline ?? (s.visual.type === "title" ? s.visual.title : s.section === "chorus" ? null : null);
      const at = t.startFrame / tl.fps;
      if (!title || (chapters.length && at - lastAt < 10)) continue;
      chapters.push({ at: ts(chapters.length ? at : 0), title });
      lastAt = at;
    }
  }
  // Sources: the research dossier's fetched sources for claims the video states, then the fact-check's.
  const research = loadResearch(ctx.slug);
  const stated = new Set([...(spec.shots ?? []), ...(loadSpec(ctx.slug, "short")?.shots ?? [])].flatMap((s) => s.claims ?? []));
  const fromResearch = (research?.claims ?? []).filter((c) => stated.has(c.id)).flatMap((c) => c.sources.filter((s) => s.accessed === "fetched").map((s) => s.url));
  const sources = readJson<Sources>(paths.sources(ctx.slug), { claims: [] }).claims ?? [];
  const urls = [...new Set([...fromResearch, ...sources.flatMap((c) => (c.sources ?? []).map(sourceUrl))])].slice(0, 20);
  const audio = loadAudioManifest(ctx.slug);
  const description = [
    spec.brief?.learningGoal ?? spec.title,
    "",
    chapters.length >= 3 ? ["Chapters", ...chapters.map((c) => `${c.at} ${c.title}`), ""].join("\n") : "",
    urls.length ? ["Sources", ...urls.map((u) => `- ${u}`), ""].join("\n") : "",
    "Made with code-driven animation (Remotion) and a fact-checked script.",
    ...(audio?.licenses ?? []).map((l) => `Audio: ${l}`),
  ].filter((x) => x !== "").join("\n");
  const meta = {
    candidate: cand.id,
    title: spec.title,
    description,
    tags: [...new Set(spec.title.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(" ").filter((w) => w.length > 3)), "explainer", "science", "education"],
    chapters,
    upload: {
      selfDeclaredMadeForKids: null,
      containsSyntheticMedia: null,
      note: "Set madeForKids and the altered/synthetic content disclosure deliberately at upload time; they are left null on purpose.",
    },
    durations: cand.durations ?? null,
    audio: audio ? Object.fromEntries(Object.entries(audio.formats).map(([f, t]) => [f, t!.status])) : null,
  };
  writeJson(join(dir, "metadata.json"), meta);
  return { summary: `thumbnail + metadata (${chapters.length} chapters, ${urls.length} sources)`, cached: false };
}
