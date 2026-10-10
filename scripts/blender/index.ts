// Optional Blender backend: renders procedural 3D clips (Eevee, headless) that
// Remotion places into the timeline like any other shot. Off when Blender
// isn't installed or BLENDER=off; storyboards then use each shot's fallback.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { paletteFor } from "../../src/theme";
import type { VideoSpec } from "../../src/schema/storyboard.mjs";
import { hashOf, paths, PipelineError, ROOT, writeJson } from "../core/files";
import { emit } from "../core/state";

const CANDIDATES = [process.env.BLENDER_BIN, "/Applications/Blender.app/Contents/MacOS/Blender", "blender"].filter(Boolean) as string[];

export type BlenderInfo = { available: boolean; bin: string | null; version: string | null; enabled: boolean; reason?: string };

let cached: BlenderInfo | null = null;
export function blenderInfo(): BlenderInfo {
  if (cached) return cached;
  const enabled = process.env.BLENDER !== "off";
  for (const bin of CANDIDATES) {
    const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 30000 });
    if (r.status === 0) {
      cached = { available: true, bin, version: r.stdout.split("\n")[0].trim(), enabled };
      return cached;
    }
  }
  cached = { available: false, bin: null, version: null, enabled, reason: "Blender not found (install it, or set BLENDER_BIN)" };
  return cached;
}

/** Scenes this backend can render, with their script and nominal length. */
export const SCENES: Record<string, { script: string; seconds: number }> = {
  "fiber-packets": { script: "scripts/blender/fiber_packets.py", seconds: 10 },
};

export type ClipResult = { src: string; seconds: number; renderSeconds: number; cached: boolean; frames: number; width: number; height: number };

/** Quality presets. "final" is what ships; "draft" is for fast iteration. */
const QUALITY = {
  final: { scale: 1, samples: 24, motionBlur: true },
  draft: { scale: 0.5, samples: 8, motionBlur: false },
};

export async function renderClip(spec: VideoSpec, shotId: string, scene: string, format: "main" | "short"): Promise<ClipResult> {
  const info = blenderInfo();
  if (!info.available || !info.enabled) throw new PipelineError(info.reason ?? "Blender disabled (BLENDER=off)", "missing");
  const def = SCENES[scene];
  if (!def) throw new PipelineError(`Unknown 3D scene "${scene}"`, "invalid");
  const q = QUALITY[(process.env.BLENDER_QUALITY as keyof typeof QUALITY) ?? "final"] ?? QUALITY.final;
  const p = paletteFor(spec.world);
  const [w, h] = format === "main" ? [1920, 1080] : [1080, 1920];
  const cfg = {
    width: Math.round(w * q.scale), height: Math.round(h * q.scale), fps: 30, seconds: def.seconds, samples: q.samples, motionBlur: q.motionBlur, seed: 7,
    colors: { bg: p.bg[1], primary: p.primary, accent: p.accent, secondary: p.secondary, jacket: p.surface },
  };
  const key = hashOf({ cfg, script: readFileSync(join(ROOT, def.script), "utf8"), version: info.version });
  const rel = `generated/${spec.slug}/3d/${shotId}-${format}-${key.slice(0, 10)}.mp4`;
  const out = join(ROOT, "public", rel);
  if (existsSync(out)) return { src: rel, seconds: def.seconds, renderSeconds: 0, cached: true, frames: def.seconds * 30, width: cfg.width, height: cfg.height };

  const work = join(paths.work(spec.slug), "blender", `${shotId}-${format}-${key.slice(0, 10)}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(join(work, "frames"), { recursive: true });
  const cfgPath = join(work, "config.json");
  writeJson(cfgPath, { ...cfg, out: join(work, "frames") });
  const total = def.seconds * 30;
  const started = Date.now();
  console.log(`  blender: rendering ${scene} for ${shotId} (${format}, ${cfg.width}x${cfg.height}, ${total} frames, ${cfg.samples} samples)`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(info.bin!, ["-b", "--factory-startup", "--python", join(ROOT, def.script), "--", cfgPath], { cwd: ROOT });
    let tail = "";
    const onData = (b: Buffer) => {
      const t = b.toString();
      tail = (tail + t).slice(-3000);
      const m = [...t.matchAll(/frame_(\d+)\.png/g)].pop();
      if (m) emit({ event: "progress", what: `blender ${shotId} ${format}`, done: Number(m[1]), total });
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const kill = () => child.kill("SIGTERM");
    process.once("SIGTERM", kill);
    child.on("error", (e) => reject(new PipelineError(`Could not start Blender: ${e.message}`, "missing")));
    child.on("close", (code) => {
      process.removeListener("SIGTERM", kill);
      if (code === 0 && /RENDER_DONE/.test(tail)) resolve();
      else reject(new PipelineError(`Blender failed (exit ${code}): ${tail.split("\n").filter((l) => /error|Traceback|Exception/i.test(l)).slice(-4).join(" | ").slice(0, 500) || tail.slice(-400)}`, "external"));
    });
  });
  const frames = readdirSync(join(work, "frames")).filter((f) => f.endsWith(".png")).length;
  if (frames < total) throw new PipelineError(`Blender produced ${frames}/${total} frames`, "failed");
  mkdirSync(join(ROOT, "public", "generated", spec.slug, "3d"), { recursive: true });
  const enc = spawnSync("ffmpeg", ["-v", "error", "-y", "-framerate", "30", "-i", join(work, "frames", "frame_%04d.png"), "-vf", `scale=${w}:${h}:flags=lanczos`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "16", "-preset", "medium", out], { encoding: "utf8" });
  if (enc.status !== 0) throw new PipelineError(`ffmpeg could not encode the Blender frames: ${enc.stderr.slice(0, 300)}`, "failed");
  const renderSeconds = Math.round((Date.now() - started) / 1000);
  writeJson(join(work, "result.json"), { renderSeconds, frames, cfg, bytes: statSync(out).size, blender: info.version });
  rmSync(join(work, "frames"), { recursive: true, force: true });
  console.log(`  blender: ${frames} frames in ${renderSeconds}s (${(renderSeconds / frames).toFixed(2)} s/frame)`);
  return { src: rel, seconds: def.seconds, renderSeconds, cached: false, frames, width: cfg.width, height: cfg.height };
}
