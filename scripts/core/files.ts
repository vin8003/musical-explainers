// Filesystem helpers for the pipeline: atomic writes, archiving before
// destructive changes, content hashes for staleness, and process locks.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, openSync, closeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

export const paths = {
  backlog: join(ROOT, "topics/backlog.json"),
  spec: (slug: string) => join(ROOT, "specs", `${slug}.json`),
  sources: (slug: string) => join(ROOT, "specs", `${slug}.sources.json`),
  work: (slug: string) => join(ROOT, "out", slug),
  state: (slug: string) => join(ROOT, "out", slug, "state.json"),
  audio: (slug: string) => join(ROOT, "out", slug, "audio"),
  candidates: (slug: string) => join(ROOT, "out", slug, "candidates"),
  candidate: (slug: string, id: string) => join(ROOT, "out", slug, "candidates", id),
  archive: (slug: string) => join(ROOT, "out", slug, "archive"),
  publicGen: (slug: string) => join(ROOT, "public", "generated", slug),
  assetsManifest: join(ROOT, "assets/manifest.json"),
  renderLock: join(ROOT, "out", ".render.lock"),
};

export function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Write to a temp file and rename, so a crash or cancel never leaves half a file. */
export function writeJson(path: string, data: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, path);
}

export const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);

/** Copies a file into out/<slug>/archive/ before it is replaced or deleted. */
export function archive(slug: string, path: string, reason: string): string | null {
  if (!existsSync(path)) return null;
  const dir = paths.archive(slug);
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, `${stamp()}-${reason}-${basename(path)}`);
  copyFileSync(path, dest);
  return dest;
}

/** Stable hash of JSON-able data (object keys sorted). */
export function hashOf(data: unknown): string {
  const stable = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(stable) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, stable((v as Record<string, unknown>)[k])])) : v;
  return createHash("sha256").update(JSON.stringify(stable(data) ?? null)).digest("hex").slice(0, 16);
}

/** Hash of every file under a directory (path + content), for "renderer code changed". */
export function hashDir(dir: string, exts = [".ts", ".tsx", ".mjs", ".json"]): string {
  const h = createHash("sha256");
  const walk = (d: string) => {
    for (const f of readdirSync(d).sort()) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (exts.some((e) => f.endsWith(e))) h.update(p.slice(ROOT.length)).update(readFileSync(p));
    }
  };
  walk(dir);
  return h.digest("hex").slice(0, 16);
}

export function hashFile(path: string): string | null {
  if (!existsSync(path)) return null;
  return createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16);
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Exclusive lock file. Stale locks (dead pid) are taken over. Returns a release function. */
export function lock(path: string, label: string): () => void {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx");
      writeFileSync(fd, JSON.stringify({ pid: process.pid, label, at: new Date().toISOString() }));
      closeSync(fd);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        try {
          if (readJson<{ pid?: number }>(path, {}).pid === process.pid) unlinkSync(path);
        } catch {}
      };
      process.once("exit", release);
      return release;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const held = readJson<{ pid?: number; label?: string; at?: string }>(path, {});
      if (held.pid && alive(held.pid)) throw new PipelineError(`Busy: ${held.label ?? "another job"} (pid ${held.pid}, since ${held.at}) holds ${basename(path)}`, "busy");
      rmSync(path, { force: true });
    }
  }
  throw new PipelineError(`Could not take lock ${path}`, "busy");
}

/** An error with a category the admin panel can show and act on. */
export class PipelineError extends Error {
  constructor(message: string, public kind: "busy" | "invalid" | "missing" | "external" | "quality" | "cancelled" | "failed" = "failed", public hint?: string) {
    super(message);
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs fn up to `tries` times with exponential backoff, for transient failures. */
export async function retry<T>(label: string, tries: number, fn: (attempt: number) => Promise<T>): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn(i);
    } catch (err) {
      last = err;
      if (err instanceof PipelineError && err.kind !== "external") throw err;
      if (i < tries - 1) {
        const wait = 2000 * 2 ** i;
        console.log(`  ${label} failed (${(err as Error).message.split("\n")[0].slice(0, 160)}); retrying in ${wait / 1000}s`);
        await sleep(wait);
      }
    }
  }
  throw last;
}
