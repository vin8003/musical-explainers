// Render stage: writes the render props (storyboard + timelines + audio) and
// renders each cut with the Remotion CLI into a new candidate directory.
// Candidates are never overwritten: every render is a new version, so an
// approved video can't be clobbered. One render at a time across all jobs.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { hashDir, hashOf, lock, paths, PipelineError, ROOT, stamp, writeJson } from "../core/files";
import { emit, loadState, updateState } from "../core/state";
import type { Candidate } from "../core/state";
import type { RenderProps } from "../../src/types";
import { assetsInputHash, loadAssetReport } from "./assets";
import { audioInputHash, loadAudioManifest, timelinesFor } from "./audio";
import { loadSpec } from "./text";
import type { RunCtx, StageResult } from "./types";

export const COMPOSITION = { main: "Explainer", short: "Short" } as const;

export const codeHash = () => hashDir(join(ROOT, "src"));
export const specHash = (spec: unknown) => hashOf(spec);

/** Runs the Remotion CLI, forwarding progress as @@ events. */
export function remotion(args: string[], label: string): Promise<void> {
  const bin = join(ROOT, "node_modules/.bin/remotion");
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: ROOT, env: { ...process.env, FORCE_COLOR: "0" } });
    let tail = "";
    let lastPct = -1;
    const onData = (b: Buffer) => {
      const text = b.toString();
      tail = (tail + text).slice(-4000);
      for (const line of text.split(/\r|\n/)) {
        const m = line.match(/(Rendered|Encoded|Stitched)\s+(\d+)\/(\d+)/i);
        if (m) {
          const pct = Math.floor((Number(m[2]) / Number(m[3])) * 100);
          if (pct !== lastPct && (pct % 5 === 0 || pct === 100)) {
            lastPct = pct;
            emit({ event: "progress", what: `${label} ${m[1].toLowerCase()}`, done: Number(m[2]), total: Number(m[3]) });
          }
        } else if (line.trim() && !/^\s*[▸>]/.test(line) && /error|warn|fail/i.test(line)) console.log(`  [remotion] ${line.trim().slice(0, 300)}`);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const kill = () => child.kill("SIGTERM");
    process.once("SIGTERM", kill);
    child.on("error", (e) => reject(new PipelineError(`Could not start Remotion: ${e.message}`, "missing")));
    child.on("close", (code) => {
      process.removeListener("SIGTERM", kill);
      if (code === 0) resolve();
      else reject(new PipelineError(`Remotion ${label} failed (exit ${code}): ${tail.split("\n").filter((l) => /error/i.test(l)).slice(-3).join(" | ").slice(0, 500) || tail.slice(-500)}`, "external"));
    });
  });
}

export function buildProps(slug: string) {
  const spec = loadSpec(slug);
  if (!spec) throw new PipelineError("No storyboard yet", "missing");
  const manifest = loadAudioManifest(slug);
  const audioFresh = manifest?.inputHash === audioInputHash(spec);
  const timelines = timelinesFor(spec, audioFresh ? manifest : null);
  const audio = audioFresh && manifest ? Object.fromEntries(Object.entries(manifest.formats).map(([f, t]) => [f, { src: t!.src, status: t!.status, has: t!.has }])) : {};
  const assets = loadAssetReport(slug);
  const clips: RenderProps["clips"] = {};
  if (assets?.inputHash === assetsInputHash(spec))
    for (const [id, c] of Object.entries(assets.clips ?? {})) clips[id] = Object.fromEntries(Object.entries(c).filter(([, x]) => x?.src).map(([f, x]) => [f, { src: x!.src!, seconds: x!.seconds ?? 10 }]));
  const props: RenderProps = { spec, timelines, audio, clips };
  return { spec, props, manifest: audioFresh ? manifest : null, audioFresh };
}

export async function renderStage(ctx: RunCtx): Promise<StageResult> {
  const { spec, props, manifest, audioFresh } = buildProps(ctx.slug);
  if (!audioFresh && !process.env.ALLOW_SILENT_RENDER) {
    throw new PipelineError("The audio is missing or out of date for this storyboard", "missing", "Run the audio stage first (or set ALLOW_SILENT_RENDER=1 for a silent preview).");
  }
  const release = lock(paths.renderLock, `render ${ctx.slug}`);
  try {
    if (ctx.shots?.length) return await renderShotPreviews(ctx, props);
    const id = `${stamp()}${ctx.preview ? "-preview" : ""}`;
    const dir = paths.candidate(ctx.slug, id);
    mkdirSync(dir, { recursive: true });
    const propsPath = join(dir, "props.json");
    writeJson(propsPath, props);
    for (const format of ctx.formats) {
      const tmp = join(dir, `${format}.partial.mp4`);
      console.log(`  rendering ${COMPOSITION[format]} (${format}${ctx.preview ? ", half resolution" : ""})`);
      emit({ event: "render", format, candidate: id });
      const started = Date.now();
      try {
        await remotion(["render", "src/index.ts", COMPOSITION[format], tmp, `--props=${propsPath}`, "--log=info", ...(ctx.preview ? ["--scale=0.5", "--crf=28"] : ["--crf=18"])], format);
      } catch (e) {
        rmSync(tmp, { force: true });
        throw e;
      }
      renameSync(tmp, join(dir, `${format}.mp4`));
      console.log(`  ${format} rendered in ${Math.round((Date.now() - started) / 1000)}s`);
    }
    const cand: Candidate = {
      id,
      createdAt: new Date().toISOString(),
      preview: ctx.preview,
      formats: ctx.formats,
      specHash: specHash(spec),
      audioHash: manifest?.inputHash ?? null,
      codeHash: codeHash(),
      audio: Object.fromEntries(Object.entries(props.audio ?? {}).map(([f, t]) => [f, t!.status])),
    };
    writeJson(join(dir, "candidate.json"), cand);
    updateState(ctx.slug, (s) => {
      s.candidates.push(cand);
    });
    pruneCandidates(ctx.slug);
    return { summary: `candidate ${id}: ${ctx.formats.join(" + ")}${ctx.preview ? " (preview)" : ""}, audio ${Object.values(cand.audio).join("/") || "silent"}`, cached: false };
  } finally {
    release();
  }
}

/** Renders only the frame ranges of selected shots, for fast targeted iteration. */
async function renderShotPreviews(ctx: RunCtx, props: RenderProps): Promise<StageResult> {
  const dir = join(paths.work(ctx.slug), "shot-previews");
  mkdirSync(dir, { recursive: true });
  const propsPath = join(dir, "props.json");
  writeJson(propsPath, props);
  const done: string[] = [];
  for (const format of ctx.formats) {
    const tl = props.timelines![format]!;
    for (const id of ctx.shots!) {
      const t = tl.shots.find((s) => s.id === id);
      if (!t) continue;
      const out = join(dir, `${id}-${format}.mp4`);
      console.log(`  previewing shot ${id} (${format})`);
      await remotion(["render", "src/index.ts", COMPOSITION[format], out, `--props=${propsPath}`, `--frames=${Math.max(0, t.startFrame - 12)}-${t.startFrame + t.durationFrames - 1}`, "--scale=0.5", "--crf=28", "--muted"], `${id} ${format}`);
      done.push(`${id}-${format}`);
    }
  }
  return { summary: `shot previews: ${done.join(", ") || "none (ids not in this cut)"}`, cached: false };
}

/** Keeps the approved candidate and the newest few; archives nothing else (renders are reproducible). */
export function pruneCandidates(slug: string, keep = Number(process.env.KEEP_CANDIDATES ?? 6)) {
  updateState(slug, (s) => {
    const sorted = [...s.candidates].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const keepIds = new Set([...sorted.slice(0, keep).map((c) => c.id), ...(s.approved ? [s.approved] : []), ...s.candidates.filter((c) => c.review).slice(-2).map((c) => c.id)]);
    for (const c of s.candidates) if (!keepIds.has(c.id)) rmSync(paths.candidate(slug, c.id), { recursive: true, force: true });
    s.candidates = s.candidates.filter((c) => keepIds.has(c.id));
  });
}

export function latestCandidate(slug: string) {
  const s = loadState(slug);
  return [...s.candidates].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).find((c) => c.formats.every((f) => existsSync(join(paths.candidate(slug, c.id), `${f}.mp4`)))) ?? null;
}
