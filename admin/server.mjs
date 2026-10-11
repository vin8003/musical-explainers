// Local admin panel for the musical-explainers pipeline.
//
//   npm run admin            -> http://localhost:4321
//
// Plain Node (18+), no dependencies. Serves admin/public and a small JSON API.
// Pipeline runs shell out to `npm run pipeline` (scripts/pipeline.ts), which
// runs Claude through the local `claude -p` CLI (subscription, no API key).
// Jobs run one at a time, so a batch can't blow through usage limits.
// Stage status is computed by the pipeline itself (scripts/status.ts), so the
// panel never re-implements its rules.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { lintSpec, migrateSpec, SCENES_3D, SECTIONS, validateSpec, VISUALS, ICONS } from "../src/schema/storyboard.mjs";
import { DEFAULT_SETTINGS, FORMAT_LABEL, normalizeSettings, resolveSettings, validateSettings } from "../src/schema/settings.mjs";
import { PASS_RULES, RUBRIC } from "../src/schema/editorial.mjs";
import { parseLedger, summarize } from "../src/schema/usage.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// Data (backlog, specs, settings, outputs) can live elsewhere: tests point DATA_ROOT at a temp dir.
const DATA = process.env.DATA_ROOT ? resolve(process.env.DATA_ROOT) : ROOT;
const PUBLIC = join(ROOT, "admin/public");
const BACKLOG = join(DATA, "topics/backlog.json");
const SETTINGS = join(DATA, "config/settings.json");
const SPECS = join(DATA, "specs");
const OUT = join(DATA, "out");
const LOGS = join(OUT, "logs");
const PORT = Number(process.env.ADMIN_PORT ?? 4321);
const HOST = process.env.ADMIN_HOST ?? "127.0.0.1";

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CAND_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{2}-[0-9]{2}-[0-9]{2}(?:-preview)?$/;
const STATUSES = ["queued", "scripting", "review", "approved", "scheduled", "published", "rejected"];
const STAGES = ["research", "outline", "script", "review", "factcheck", "direct", "assets", "audio", "render", "qa", "package"];
const FORMATS = ["main", "short"];
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// ---------- files ----------

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

// Write to a temp file and rename, so a crash never leaves half a JSON file.
function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, path);
}

const mtime = (path) => (existsSync(path) ? statSync(path).mtimeMs : null);
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);

function loadBacklog() {
  const b = readJson(BACKLOG, { version: 1, topics: [] });
  if (!Array.isArray(b.topics)) b.topics = [];
  return b;
}

function saveBacklog(b) {
  b.topics.forEach((t, i) => (t.priority = i + 1));
  writeJson(BACKLOG, b);
}

function updateTopic(slug, fn) {
  const b = loadBacklog();
  const t = b.topics.find((x) => x.slug === slug);
  if (!t) return null;
  fn(t);
  saveBacklog(b);
  return t;
}

const statePath = (slug) => join(OUT, slug, "state.json");
const loadState = (slug) => readJson(statePath(slug), { slug, stages: {}, candidates: [] });
function updateState(slug, fn) {
  const s = loadState(slug);
  s.stages ??= {};
  s.candidates ??= [];
  fn(s);
  s.updatedAt = new Date().toISOString();
  writeJson(statePath(slug), s);
  return s;
}

// ---------- settings (config/settings.json) ----------

/** Effective settings plus what is on disk, so the panel can show both honestly. */
function loadSettings() {
  let raw = null;
  let unreadable = null;
  if (existsSync(SETTINGS)) {
    try {
      raw = JSON.parse(readFileSync(SETTINGS, "utf8"));
    } catch (e) {
      unreadable = `config/settings.json can't be parsed (${e.message}); using the defaults`;
    }
  }
  const r = resolveSettings(unreadable ? null : raw);
  return { ...r, warnings: unreadable ? [unreadable, ...r.warnings] : r.warnings, saved: raw, defaults: DEFAULT_SETTINGS, path: "config/settings.json", labels: FORMAT_LABEL, at: mtime(SETTINGS) };
}

function saveSettings(body) {
  const s = normalizeSettings(body);
  const problems = validateSettings(s);
  if (problems.length) throw httpError(400, problems.join("; "));
  writeJson(SETTINGS, s);
  return loadSettings();
}

function validateTopic(t, { partial = false } = {}) {
  const out = {};
  if (!partial || "title" in t) {
    if (typeof t.title !== "string" || !t.title.trim()) throw httpError(400, "Title is required");
    out.title = t.title.trim();
  }
  if (!partial || "slug" in t) {
    const slug = (t.slug || slugify(out.title ?? "")).trim();
    if (!SLUG_RE.test(slug)) throw httpError(400, "Slug must be lowercase letters, digits and dashes");
    out.slug = slug;
  }
  for (const key of ["category", "angle", "chorusIdea", "notes"]) {
    if (key in t) out[key] = String(t[key] ?? "").trim();
  }
  if ("status" in t) {
    if (!STATUSES.includes(t.status)) throw httpError(400, `Status must be one of ${STATUSES.join(", ")}`);
    out.status = t.status;
  }
  return out;
}

// ---------- environment checks ----------

const TSX = join(ROOT, "node_modules/tsx/dist/cli.mjs");

// The usual way this breaks: node_modules installed under one CPU arch
// (native arm64 vs Rosetta x64) and the panel started with the other node.
function checkEnvironment() {
  const warnings = [];
  const want = `${process.platform}-${process.arch}`;
  const esbuildDir = join(ROOT, "node_modules/@esbuild");
  const have = existsSync(esbuildDir) ? readdirSync(esbuildDir) : [];
  if (!existsSync(join(ROOT, "node_modules"))) warnings.push("node_modules is missing: run npm install first.");
  else if (have.length && !have.includes(want))
    warnings.push(`This admin server runs on ${want} Node (${process.execPath}) but node_modules was installed for ${have.join(", ")}. Pipeline runs will fail. Start it with the matching Node, e.g. /opt/homebrew/bin/npm run admin, or reinstall node_modules.`);
  const claude = spawnSync(process.env.CLAUDE_BIN ?? "claude", ["--version"], { encoding: "utf8", timeout: 15000 });
  const claudeVersion = claude.status === 0 ? claude.stdout.trim() : null;
  if (!claudeVersion) warnings.push("The claude CLI was not found. Install Claude Code and log in once, or set CLAUDE_BIN to its path. Script, fact-check and direction need it.");
  if (process.env.ANTHROPIC_API_KEY) warnings.push("ANTHROPIC_API_KEY is set in this shell. The pipeline removes it for claude runs so they use your subscription.");
  const ffmpeg = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" }).status === 0;
  if (!ffmpeg) warnings.push("ffmpeg was not found on PATH. Audio mixing and QA need it.");
  return { node: `${process.version} ${process.arch}`, claude: claudeVersion, ffmpeg, warnings, tools: null };
}
const ENV = checkEnvironment();

// ---------- computed status (from the pipeline's own rules) ----------

const statusCache = new Map(); // slug -> { key, value }
let statusRunning = null;

function statusKey(slug) {
  const files = [join(SPECS, `${slug}.json`), join(SPECS, `${slug}.short.json`), join(SPECS, `${slug}.sources.json`), join(SPECS, `${slug}.research.json`), join(SPECS, `${slug}.outline.json`), join(SPECS, `${slug}.review.json`), statePath(slug), join(OUT, slug, "audio/manifest.json"), join(OUT, slug, "assets.json"), join(ROOT, "assets/manifest.json"), SETTINGS, BACKLOG];
  return files.map(mtime).join("|");
}

/** Runs scripts/status.ts for stale entries in one process; resolves when done. */
function refreshStatus(slugs, withEnv = false) {
  const stale = slugs.filter((s) => statusCache.get(s)?.key !== statusKey(s));
  if (!stale.length && !withEnv) return Promise.resolve(false);
  if (statusRunning) return statusRunning.then(() => refreshStatus(slugs, withEnv));
  const keys = Object.fromEntries(stale.map((s) => [s, statusKey(s)]));
  statusRunning = new Promise((resolve) => {
    const child = spawn(process.execPath, [TSX, "scripts/status.ts", ...stale, ...(withEnv ? ["--env"] : [])], { cwd: ROOT, env: { ...process.env, DATA_ROOT: DATA, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` } });
    let out = "";
    child.stdout.on("data", (b) => (out += b));
    child.on("close", () => {
      try {
        const parsed = JSON.parse(out.trim().split("\n").pop());
        for (const s of stale) if (parsed[s]) statusCache.set(s, { key: keys[s], value: parsed[s] });
        if (parsed.__env) ENV.tools = parsed.__env;
      } catch {}
      statusRunning = null;
      resolve(true);
    });
    child.on("error", () => { statusRunning = null; resolve(false); });
  });
  return statusRunning;
}

const cachedStatus = (slug) => statusCache.get(slug)?.value ?? null;

// ---------- per-video info ----------

function candidatesOf(slug) {
  const state = loadState(slug);
  return [...(state.candidates ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((c) => {
    const dir = join(OUT, slug, "candidates", c.id);
    return {
      ...c,
      files: Object.fromEntries(["main", "short"].map((f) => [f, existsSync(join(dir, `${f}.mp4`))])),
      qaReport: existsSync(join(dir, "qa/report.json")),
      thumbnail: existsSync(join(dir, "package/thumbnail.png")),
      approved: state.approved === c.id,
    };
  });
}

function videoInfo(slug, topic) {
  const specPath = join(SPECS, `${slug}.json`);
  const sourcesPath = join(SPECS, `${slug}.sources.json`);
  const raw = readJson(specPath, null);
  const spec = raw ? migrateSpec(raw) : null;
  const sources = readJson(sourcesPath, null);
  const claims = Array.isArray(sources?.claims) ? sources.claims : [];
  const state = loadState(slug);
  const cands = candidatesOf(slug);
  const latest = cands.find((c) => c.files.main || c.files.short) ?? null;
  const legacy = !latest && (existsSync(join(OUT, `${slug}.mp4`)) || existsSync(join(OUT, `${slug}-short.mp4`)));
  const job = jobs.find((j) => j.slug === slug && (j.state === "running" || j.state === "queued"));
  const lastJob = [...jobs].reverse().find((j) => j.slug === slug);
  const audio = readJson(join(OUT, slug, "audio/manifest.json"), null);
  const computed = cachedStatus(slug);
  const tl = readJson(join(OUT, slug, "audio/timeline-main.json"), null);
  const seconds = tl ? tl.totalFrames / tl.fps : spec ? spec.shots.reduce((n, s) => n + (s.minBars ?? 2) * 4 * (60 / (spec.music?.bpm ?? 120)), 0) : null;
  return {
    slug,
    title: topic?.title ?? spec?.title ?? slug,
    inBacklog: Boolean(topic),
    status: topic?.status ?? (spec ? "untracked" : "queued"),
    review: topic?.review ?? null,
    spec: spec ? { at: mtime(specPath), shots: spec.shots.length, scenes: spec.shots.length, bpm: spec.music?.bpm, seconds, version: raw.schemaVersion ?? 1, directed: spec.direction?.status === "directed" } : null,
    factcheck: sources ? { at: mtime(sourcesPath), claims: claims.length, flagged: claims.filter((c) => c.verdict !== "ok").length, stale: computed?.stages?.factcheck?.status === "stale" } : null,
    audio: audio ? Object.fromEntries(Object.entries(audio.formats ?? {}).map(([f, t]) => [f, t.status])) : null,
    render: latest
      ? { main: latest.files.main, short: latest.files.short, at: Date.parse(latest.createdAt), candidate: latest.id, preview: latest.preview, stale: computed?.stages?.render?.status === "stale", qa: latest.qa ?? null }
      : legacy ? { main: existsSync(join(OUT, `${slug}.mp4`)), short: existsSync(join(OUT, `${slug}-short.mp4`)), at: mtime(join(OUT, `${slug}.mp4`)), candidate: null, legacy: true, stale: true } : null,
    stages: computed?.stages ?? null,
    formats: computed?.formats ?? null,
    hasShort: existsSync(join(SPECS, `${slug}.short.json`)),
    lastRunSettings: state.run?.settings ?? null,
    stageRuns: state.stages ?? {},
    checkpoint: state.checkpoint ?? null,
    approved: state.approved ?? null,
    job: job ? jobSummary(job) : null,
    lastJob: lastJob ? jobSummary(lastJob) : null,
  };
}

function allSlugs() {
  const { topics } = loadBacklog();
  const slugs = new Set(topics.map((t) => t.slug));
  for (const f of existsSync(SPECS) ? readdirSync(SPECS) : []) {
    const m = f.match(/^(.+)\.json$/);
    if (m && !m[1].endsWith(".sources") && SLUG_RE.test(m[1])) slugs.add(m[1]);
  }
  return [...slugs];
}

function allVideos() {
  const { topics } = loadBacklog();
  const bySlug = new Map(topics.map((t) => [t.slug, t]));
  return allSlugs().map((s) => videoInfo(s, bySlug.get(s)));
}

// ---------- jobs ----------

// Every job runs scripts/pipeline.ts; these presets map onto its flags.
const MODES = {
  continue: { label: "Continue: run every missing or stale stage", args: () => [] },
  full: { label: "Full pipeline (continue to the end)", args: () => [] },
  spec: { label: "Research, scripts, editorial review + fact-check only", args: () => ["--to", "factcheck"] },
  direct: { label: "Research through storyboard (no audio/render)", args: () => ["--to", "direct"] },
  render: { label: "Render a new candidate", args: () => ["--stage", "render"] },
  stage: { label: "Run one stage", args: (o) => ["--stage", o.stage] },
};

const jobs = [];
let nextId = 1;
const clients = new Set();

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

// What kind of failure, in the words the panel shows.
const FAILURE = { budget: "usage budget", editorial: "content quality", factcheck: "factual verification", config: "configuration", duration: "media duration", quality: "rendered-media QA" };
const failureCategory = (kind) => (kind ? FAILURE[kind] ?? kind : null);

const jobSummary = (j) => ({
  id: j.id, slug: j.slug, title: j.title, mode: j.mode, modeLabel: j.label, fresh: j.fresh, options: j.options,
  state: j.state, stage: j.stage, stages: j.stages, progress: j.progress, flagged: j.flagged, error: j.error, hint: j.hint, errorKind: j.errorKind ?? null, failure: failureCategory(j.errorKind), settings: j.settings ?? null, durations: j.durations ?? null, usage: j.usage ?? null,
  createdAt: j.createdAt, startedAt: j.startedAt, endedAt: j.endedAt, exitCode: j.exitCode, logFile: j.logFile,
});

function emitJob(j) {
  broadcast("job", jobSummary(j));
}

function jobLabel(mode, o) {
  if (mode === "stage") return `${o.stage}${o.shots?.length ? ` (${o.shots.join(", ")})` : ""}${o.preview ? " · preview" : ""}`;
  return MODES[mode].label + (o.preview ? " · preview render" : "");
}

function enqueue({ slug, mode = "continue", fresh = false, stage, shots, notes, preview, formats, visualReview }) {
  if (!SLUG_RE.test(slug)) throw httpError(400, "Bad slug");
  if (!MODES[mode]) throw httpError(400, "Unknown mode");
  if (mode === "stage" && !STAGES.includes(stage)) throw httpError(400, `stage must be one of ${STAGES.join(", ")}`);
  if (jobs.some((j) => j.slug === slug && (j.state === "queued" || j.state === "running")))
    throw httpError(409, "This video already has a job queued or running");
  if (["render"].includes(mode) && !existsSync(join(SPECS, `${slug}.json`))) throw httpError(400, "No storyboard yet: run the script stage first");
  const options = {
    stage: mode === "stage" ? stage : undefined,
    shots: Array.isArray(shots) ? shots.filter((s) => SLUG_RE.test(s)).slice(0, 20) : [],
    notes: typeof notes === "string" ? notes.slice(0, 4000) : "",
    preview: Boolean(preview),
    formats: Array.isArray(formats) ? formats.filter((f) => f === "main" || f === "short") : [],
    visualReview: Boolean(visualReview),
  };
  const job = {
    id: nextId++, slug, title: generateTitle(slug), mode, label: jobLabel(mode, options), fresh: Boolean(fresh), options, state: "queued",
    stage: "queued", stages: {}, progress: null, flagged: [], log: "", error: null, hint: null, errorKind: null, settings: null, durations: null,
    createdAt: Date.now(), startedAt: null, endedAt: null, exitCode: null, logFile: null, proc: null,
  };
  jobs.push(job);
  if (jobs.length > 200) jobs.splice(0, jobs.length - 200);
  emitJob(job);
  pump();
  return job;
}

// pipeline.ts finds the backlog entry by title or slug.
function generateTitle(slug) {
  const topic = loadBacklog().topics.find((t) => t.slug === slug);
  if (topic) return topic.title;
  const spec = readJson(join(SPECS, `${slug}.json`), null);
  if (spec?.title && slugify(spec.title) === slug) return spec.title;
  return slug.replace(/-/g, " ");
}

function appendLog(job, text) {
  job.log += text;
  if (job.log.length > 2_000_000) job.log = job.log.slice(-1_500_000);
  if (job.logFile) appendFileSync(job.logFile, text);
  broadcast("log", { id: job.id, text });
}

// The pipeline prints machine-readable lines: @@ {"event": ...}.
function parseLine(job, line) {
  const m = line.match(/^@@ (\{.*\})\s*$/);
  if (m) {
    let ev;
    try { ev = JSON.parse(m[1]); } catch { return; }
    if (ev.event === "stage") {
      job.stages[ev.stage] = { status: ev.status, summary: ev.summary, error: ev.error, cached: ev.cached };
      if (ev.status === "running") { job.stage = ev.stage; job.progress = null; }
      if (ev.status === "failed") { job.error = ev.error; job.hint = ev.hint ?? null; job.errorKind = ev.kind ?? null; if (ev.durations) job.durations = ev.durations; }
      emitJob(job);
      if (ev.status !== "running") broadcast("videos", { slug: job.slug });
    } else if (ev.event === "usage") {
      // Live totals come from the pipeline's own ledger aggregate; the same file backs /api/videos/:slug/usage.
      if (ev.totals) job.usage = { runId: ev.runId, totals: ev.totals, stages: ev.stages, limits: ev.limits };
      if (ev.type === "budget_exceeded") job.usage = { ...(job.usage ?? {}), stop: { stage: ev.stage, blocks: ev.blocks } };
      broadcast("usage", { slug: job.slug, jobId: job.id, ...ev });
      if (ev.type === "usage_updated" || ev.type === "budget_exceeded") emitJob(job);
    } else if (ev.event === "progress") {
      job.progress = { what: ev.what, done: ev.done, total: ev.total };
      emitJob(job);
    }
    return;
  }
  const f = line.match(/^\s+- \[(\w+)\] (.*)/);
  if (f && job.stage === "factcheck") job.flagged.push({ verdict: f[1], claim: f[2] });
}

function pump() {
  if (jobs.some((j) => j.state === "running")) return;
  const job = jobs.find((j) => j.state === "queued");
  if (!job) return;
  start(job);
}

function start(job) {
  mkdirSync(LOGS, { recursive: true });
  job.logFile = join(LOGS, `${job.slug}-${stamp()}-${job.mode}.log`);
  writeFileSync(job.logFile, "");
  // Snapshot the settings when the job starts; the pipeline uses exactly these
  // for the whole run, so saving new settings meanwhile only affects later jobs.
  const eff = loadSettings();
  if (validateSettings(eff.settings).length) {
    job.state = "failed";
    job.errorKind = "config";
    job.error = "The duration settings are invalid";
    job.endedAt = Date.now();
    emitJob(job);
    return pump();
  }
  job.settings = { settings: eff.settings, source: eff.source, at: new Date().toISOString() };
  job.state = "running";
  job.stage = "starting";
  job.startedAt = Date.now();
  updateTopic(job.slug, (t) => { if (t.status === "queued" || t.status === "rejected") t.status = "scripting"; });

  const o = job.options;
  const args = ["run", "pipeline", "--", job.slug, ...MODES[job.mode].args(o)];
  if (job.fresh) args.push("--fresh");
  if (o.shots.length) args.push("--shots", o.shots.join(","));
  if (o.notes) args.push("--notes", o.notes);
  if (o.preview) args.push("--preview");
  if (o.formats.length) args.push("--formats", o.formats.join(","));
  if (o.visualReview) args.push("--visual-review");
  appendLog(job, `$ npm ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}\n`);
  const proc = spawn(process.platform === "win32" ? "npm.cmd" : "npm", args, {
    cwd: ROOT,
    detached: process.platform !== "win32", // own process group, so Cancel stops claude/remotion/blender too
    // Put this server's own node first on PATH so the child uses the same arch.
    env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`, FORCE_COLOR: "0", NO_COLOR: "1", CI: "1", PIPELINE_SETTINGS: JSON.stringify(job.settings) },
  });
  job.proc = proc;
  emitJob(job);

  let partial = "";
  const onData = (buf) => {
    const text = buf.toString("utf8");
    appendLog(job, text);
    partial += text;
    const lines = partial.split(/\r\n|\r|\n/);
    partial = lines.pop();
    for (const line of lines) parseLine(job, line);
  };
  proc.stdout.on("data", onData);
  proc.stderr.on("data", onData);
  proc.on("error", (err) => appendLog(job, `\n[admin] could not start npm: ${err.message}\n`));
  proc.on("close", (code, signal) => {
    if (partial) parseLine(job, partial);
    job.proc = null;
    job.exitCode = code;
    job.endedAt = Date.now();
    if (job.state === "cancelled") {
      appendLog(job, `\n[admin] cancelled\n`);
      // A cancelled stage must not look like it is still running.
      updateState(job.slug, (s) => { for (const st of Object.values(s.stages)) if (st.status === "running") Object.assign(st, { status: "cancelled", endedAt: new Date().toISOString(), error: { message: "cancelled from the admin panel", kind: "cancelled" } }); });
    } else if (code === 0) {
      job.state = "done";
      job.stage = "done";
      job.progress = null;
      const s = loadState(job.slug);
      if (s.candidates?.length) updateTopic(job.slug, (t) => { if (["queued", "scripting", "rejected"].includes(t.status) && job.stages.render?.status === "done") t.status = "review"; });
      appendLog(job, `\n[admin] finished\n`);
    } else {
      job.state = "failed";
      if (!job.error) {
        const lastErr = job.log.trim().split("\n").reverse().find((l) => /\[pipeline\]|error|failed/i.test(l));
        job.error = (lastErr ?? `exited with ${signal ?? code}`).replace(/^\[pipeline\]\s*/, "").slice(0, 400);
      }
      const kind = job.log.match(/\[pipeline\] (\w+): /);
      if (!job.errorKind && kind && FAILURE[kind[1]]) job.errorKind = kind[1];
      const hint = job.log.match(/\[pipeline\] hint: (.*)/);
      if (hint) job.hint = hint[1];
      appendLog(job, `\n[admin] failed (exit ${signal ?? code})\n`);
    }
    emitJob(job);
    statusCache.delete(job.slug);
    refreshStatus([job.slug]).then(() => broadcast("videos", { slug: job.slug }));
    pump();
  });
}

function cancel(id) {
  const job = jobs.find((j) => j.id === id);
  if (!job) throw httpError(404, "No such job");
  if (job.state === "queued") {
    job.state = "cancelled";
    job.endedAt = Date.now();
    emitJob(job);
  } else if (job.state === "running" && job.proc) {
    job.state = "cancelled";
    try {
      process.kill(process.platform === "win32" ? job.proc.pid : -job.proc.pid, "SIGTERM");
    } catch {
      job.proc.kill("SIGTERM");
    }
    emitJob(job);
  }
  return job;
}

// Stages left "running" by a crashed or killed server are marked interrupted.
function recoverInterrupted() {
  for (const slug of allSlugs()) {
    const s = readJson(statePath(slug), null);
    if (!s?.stages) continue;
    const running = Object.entries(s.stages).filter(([, v]) => v.status === "running");
    if (!running.length) continue;
    const lock = readJson(join(OUT, slug, ".pipeline.lock"), null);
    let alive = false;
    if (lock?.pid) try { process.kill(lock.pid, 0); alive = true; } catch {}
    if (alive) continue;
    updateState(slug, (st) => { for (const [k] of running) Object.assign(st.stages[k], { status: "cancelled", endedAt: new Date().toISOString(), error: { message: "interrupted (the process stopped before this stage finished)", kind: "cancelled" } }); });
    console.log(`Marked interrupted stage(s) ${running.map(([k]) => k).join(", ")} for ${slug}`);
  }
}

function shutdown() {
  for (const j of jobs) if (j.proc) try { process.kill(-j.proc.pid, "SIGTERM"); } catch {}
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ---------- http ----------

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(data);
}

async function readBody(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 5_000_000) throw httpError(413, "Body too large");
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw httpError(400, "Body is not valid JSON");
  }
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".mp4": "video/mp4", ".wav": "audio/wav", ".log": "text/plain; charset=utf-8", ".json": "application/json; charset=utf-8" };

// Static files and media, with Range support so the players can seek.
function sendFile(req, res, path) {
  if (!existsSync(path)) return send(res, 404, { error: "Not found" });
  const size = statSync(path).size;
  const type = TYPES[extname(path)] ?? "application/octet-stream";
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    let start = range[1] ? Number(range[1]) : size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : size - 1;
    if (start >= size || start > end) {
      res.writeHead(416, { "content-range": `bytes */${size}` });
      return res.end();
    }
    end = Math.min(end, size - 1);
    res.writeHead(206, { "content-type": type, "content-length": end - start + 1, "content-range": `bytes ${start}-${end}/${size}`, "accept-ranges": "bytes", "cache-control": "no-cache" });
    return createReadStream(path, { start, end }).pipe(res);
  }
  res.writeHead(200, { "content-type": type, "content-length": size, "accept-ranges": "bytes", "cache-control": "no-cache" });
  createReadStream(path).pipe(res);
}

function slugParam(s) {
  if (!SLUG_RE.test(s)) throw httpError(400, "Bad slug");
  return s;
}
function candParam(c) {
  if (!CAND_RE.test(c)) throw httpError(400, "Bad candidate id");
  return c;
}

// The panel can start processes, so only answer requests from itself:
// a localhost Host header (blocks DNS rebinding) and, for writes, a same-origin Origin.
function allowed(req) {
  const host = (req.headers.host ?? "").replace(/:\d+$/, "");
  if (!["localhost", "127.0.0.1", "[::1]"].includes(host)) return false;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const origin = req.headers.origin;
    if (origin && origin !== `http://${req.headers.host}`) return false;
  }
  return true;
}

function detail(slug) {
  const topic = loadBacklog().topics.find((t) => t.slug === slug);
  const raw = readJson(join(SPECS, `${slug}.json`), null);
  const spec = raw ? migrateSpec(raw) : null;
  const cands = candidatesOf(slug);
  const qa = Object.fromEntries(cands.filter((c) => c.qaReport).map((c) => [c.id, readJson(join(OUT, slug, "candidates", c.id, "qa/report.json"), null)]));
  const pkg = Object.fromEntries(cands.filter((c) => c.thumbnail).map((c) => [c.id, readJson(join(OUT, slug, "candidates", c.id, "package/metadata.json"), null)]));
  return {
    ...videoInfo(slug, topic),
    topic: topic ?? null,
    specJson: spec,
    specRawVersion: raw?.schemaVersion ?? (raw ? 1 : null),
    lint: spec ? lintSpec(spec) : [],
    problems: cachedStatus(slug)?.problems ?? [],
    sourcesJson: readJson(join(SPECS, `${slug}.sources.json`), null),
    shortSpecJson: (() => { const r = readJson(join(SPECS, `${slug}.short.json`), null); return r ? migrateSpec(r) : null; })(),
    research: readJson(join(SPECS, `${slug}.research.json`), null),
    outline: readJson(join(SPECS, `${slug}.outline.json`), null),
    editorialReview: readJson(join(SPECS, `${slug}.review.json`), null),
    timelineShort: readJson(join(OUT, slug, "audio/timeline-short.json"), null),
    assets: readJson(join(OUT, slug, "assets.json"), null),
    audioManifest: readJson(join(OUT, slug, "audio/manifest.json"), null),
    timeline: readJson(join(OUT, slug, "audio/timeline-main.json"), null),
    candidates: cands,
    qa,
    package: pkg,
    benchmark: readJson(join(OUT, slug, "benchmark.json"), null),
    jobs: jobs.filter((j) => j.slug === slug).map(jobSummary).reverse(),
  };
}

// ---------- usage (out/<slug>/usage.jsonl, written by the pipeline) ----------

/** The ledger for one video, its budgets and why the last run stopped. Old videos have no ledger: `available: false`, never zeros. */
function usageFor(slug, runParam) {
  const file = join(OUT, slug, "usage.jsonl");
  const state = loadState(slug);
  const budgets = state.run?.settings?.budgets ?? loadSettings().settings.budgets;
  if (!existsSync(file)) return { available: false, slug, note: "Usage was not recorded for this video (it predates usage tracking, or no Claude call has been made yet).", budgets };
  const all = parseLedger(readFileSync(file, "utf8"));
  const runs = [...new Set(all.map((r) => r.runId))];
  const runId = runParam && runParam !== "all" ? runParam : runParam === "all" ? "all" : state.usage?.runId && runs.includes(state.usage.runId) ? state.usage.runId : runs.at(-1);
  const rows = runId === "all" ? all : all.filter((r) => r.runId === runId);
  const s = summarize(rows, budgets);
  return {
    available: true, slug, runId, runs, budgets,
    totals: s.run, stages: s.stages, limits: s.limits,
    stop: state.usage?.runId === runId ? state.usage?.stop ?? null : null,
    // Metadata only (the ledger holds no prompts); newest last, bounded.
    calls: rows.slice(-1000),
    cost: "Estimated cost is the Claude CLI's own estimate at API list prices, not a bill. Token usage, estimated cost and the 5-hour usage-window percentage are different measurements; the window percentage is not available here.",
  };
}

async function route(req, res) {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  const m = (re) => p.match(re);
  let r;

  if (req.method === "GET" && p === "/api/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    res.write(`event: hello\ndata: {}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 25000);
    req.on("close", () => { clearInterval(ping); clients.delete(res); });
    return;
  }

  if (req.method === "GET" && p === "/api/meta")
    return send(res, 200, {
      env: ENV, statuses: STATUSES, stages: STAGES, formats: FORMATS, formatLabels: FORMAT_LABEL, rubric: RUBRIC, passRules: PASS_RULES, sections: SECTIONS, visuals: VISUALS, icons: ICONS, scenes3d: SCENES_3D, sceneKinds: SECTIONS,
      modes: Object.fromEntries(Object.entries(MODES).filter(([k]) => k !== "stage" && k !== "full").map(([k, v]) => [k, v.label])),
    });

  // Settings: video formats and durations
  if (req.method === "GET" && p === "/api/settings") return send(res, 200, loadSettings());
  if (req.method === "PUT" && p === "/api/settings") {
    const saved = saveSettings(await readBody(req));
    statusCache.clear();
    broadcast("settings", {});
    broadcast("status", {});
    return send(res, 200, saved);
  }
  // The shared validator, so the form checks exactly what the server checks.
  if (req.method === "GET" && (r = m(/^\/schema\/(settings|usage)\.mjs$/))) {
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" });
    return res.end(readFileSync(join(ROOT, `src/schema/${r[1]}.mjs`)));
  }

  // Topics (backlog)
  if (req.method === "GET" && p === "/api/topics") return send(res, 200, loadBacklog());
  if (req.method === "POST" && p === "/api/topics") {
    const t = validateTopic(await readBody(req));
    const b = loadBacklog();
    if (b.topics.some((x) => x.slug === t.slug)) throw httpError(409, `A topic with slug "${t.slug}" already exists`);
    b.topics.push({ slug: t.slug, title: t.title, category: t.category ?? "", angle: t.angle ?? "", chorusIdea: t.chorusIdea ?? "", status: t.status ?? "queued", priority: b.topics.length + 1 });
    saveBacklog(b);
    broadcast("videos", {});
    return send(res, 201, b);
  }
  if (req.method === "POST" && p === "/api/topics/reorder") {
    const { slugs } = await readBody(req);
    const b = loadBacklog();
    if (!Array.isArray(slugs) || slugs.length !== b.topics.length || !b.topics.every((t) => slugs.includes(t.slug)))
      throw httpError(400, "Reorder must list every topic exactly once");
    b.topics.sort((a, z) => slugs.indexOf(a.slug) - slugs.indexOf(z.slug));
    saveBacklog(b);
    return send(res, 200, b);
  }
  if ((r = m(/^\/api\/topics\/([^/]+)$/))) {
    const slug = slugParam(r[1]);
    const b = loadBacklog();
    const i = b.topics.findIndex((t) => t.slug === slug);
    if (i < 0) throw httpError(404, "No such topic");
    if (req.method === "PUT") {
      const patch = validateTopic(await readBody(req), { partial: true });
      if (patch.slug && patch.slug !== slug) {
        if (b.topics.some((t) => t.slug === patch.slug)) throw httpError(409, "That slug is taken");
        if (existsSync(join(SPECS, `${slug}.json`))) throw httpError(400, "This topic already has a spec; its slug can't change");
      }
      Object.assign(b.topics[i], patch);
      saveBacklog(b);
      broadcast("videos", {});
      return send(res, 200, b);
    }
    if (req.method === "DELETE") {
      b.topics.splice(i, 1);
      saveBacklog(b);
      broadcast("videos", {});
      return send(res, 200, b);
    }
  }

  // Videos
  if (req.method === "GET" && p === "/api/videos") {
    const slugs = allSlugs();
    // Answer at once with what we know; push an update when status is computed.
    refreshStatus(slugs).then((changed) => changed && broadcast("status", {}));
    return send(res, 200, allVideos());
  }
  if ((r = m(/^\/api\/videos\/([^/]+)$/)) && req.method === "GET") {
    const slug = slugParam(r[1]);
    if (url.searchParams.has("fresh") || !cachedStatus(slug)) await refreshStatus([slug]);
    else refreshStatus([slug]).then((changed) => changed && broadcast("status", { slug }));
    return send(res, 200, detail(slug));
  }
  if ((r = m(/^\/api\/videos\/([^/]+)\/usage$/)) && req.method === "GET") return send(res, 200, usageFor(slugParam(r[1]), url.searchParams.get("run")));
  if ((r = m(/^\/api\/videos\/([^/]+)\/spec$/)) && req.method === "PUT") {
    const slug = slugParam(r[1]);
    if (jobs.some((j) => j.slug === slug && j.state === "running")) throw httpError(409, "A job is running for this video; wait for it or cancel it first");
    const spec = await readBody(req);
    const format = url.searchParams.get("format") === "short" ? "short" : "main";
    const problems = validateSpec(spec, { slug });
    if (problems.length) throw httpError(400, problems.join("; "));
    if (format === "short" && spec.format !== "short") throw httpError(400, "The Short storyboard must have format \"short\"");
    const path = join(SPECS, format === "short" ? `${slug}.short.json` : `${slug}.json`);
    if (existsSync(path)) {
      // Keep the previous version: edits are recoverable from out/<slug>/archive/.
      mkdirSync(join(OUT, slug, "archive"), { recursive: true });
      writeFileSync(join(OUT, slug, "archive", `${stamp()}-admin-edit-${slug}${format === "short" ? ".short" : ""}.json`), readFileSync(path));
    }
    writeJson(path, spec);
    statusCache.delete(slug);
    broadcast("videos", { slug });
    return send(res, 200, { ok: true, lint: lintSpec(spec) });
  }
  if ((r = m(/^\/api\/videos\/([^/]+)\/validate$/)) && req.method === "POST") {
    const slug = slugParam(r[1]);
    const spec = await readBody(req);
    const problems = validateSpec(spec, { slug });
    return send(res, 200, { ok: !problems.length, problems, lint: problems.length ? [] : lintSpec(spec) });
  }
  if ((r = m(/^\/api\/videos\/([^/]+)\/review$/)) && req.method === "POST") {
    const slug = slugParam(r[1]);
    const { decision, notes = "", candidate } = await readBody(req);
    if (!["approved", "rejected", "review"].includes(decision)) throw httpError(400, "decision must be approved, rejected or review");
    if (candidate != null) candParam(candidate);
    const cands = candidatesOf(slug);
    if (candidate && !cands.some((c) => c.id === candidate)) throw httpError(404, "No such candidate");
    if (decision === "approved" && candidate) {
      const c = cands.find((x) => x.id === candidate);
      if (c.preview) throw httpError(400, "A preview render can't be approved; render a full candidate first");
    }
    const at = new Date().toISOString();
    if (candidate)
      updateState(slug, (s) => {
        const c = s.candidates.find((x) => x.id === candidate);
        if (decision === "review") delete c.review;
        else c.review = { decision, notes: String(notes).trim(), at };
        if (decision === "approved") s.approved = candidate;
        else if (s.approved === candidate) s.approved = null;
      });
    const b = loadBacklog();
    let t = b.topics.find((x) => x.slug === slug);
    if (!t) {
      const spec = readJson(join(SPECS, `${slug}.json`), null);
      t = { slug, title: spec?.title ?? slug, category: "", angle: "", chorusIdea: "", status: "review", priority: b.topics.length + 1 };
      b.topics.push(t);
    }
    t.status = decision;
    t.review = decision === "review" ? undefined : { decision, notes: String(notes).trim(), at, candidate: candidate ?? null };
    saveBacklog(b);
    broadcast("videos", { slug });
    return send(res, 200, { ok: true });
  }
  if ((r = m(/^\/api\/videos\/([^/]+)\/run$/)) && req.method === "POST") {
    const slug = slugParam(r[1]);
    const body = await readBody(req);
    return send(res, 202, jobSummary(enqueue({ slug, ...body, mode: body.mode === "full" ? "continue" : body.mode ?? "continue" })));
  }

  // Media: candidate files, QA frames and sheets, thumbnails, audio mixes.
  if ((r = m(/^\/media\/([^/]+)\/c\/([^/]+)\/((?:main|short)\.mp4|qa\/sheet-(?:main|short)\.jpg|qa\/frames\/[\w.-]+\.jpg|package\/thumbnail\.png)$/)) && req.method === "GET") {
    const slug = slugParam(r[1]);
    const cand = candParam(r[2]);
    if (r[3].includes("..")) throw httpError(400, "Bad path");
    return sendFile(req, res, join(OUT, slug, "candidates", cand, r[3]));
  }
  if ((r = m(/^\/media\/([^/]+)\/audio\/((?:music|mix)-(?:main|short)(?:\.raw)?\.wav)$/)) && req.method === "GET") {
    const slug = slugParam(r[1]);
    return sendFile(req, res, join(OUT, slug, "audio", r[2]));
  }
  if ((r = m(/^\/media\/([^/]+)\/gen\/(mix-(?:main|short)-[a-f0-9]+\.wav)$/)) && req.method === "GET") {
    const slug = slugParam(r[1]);
    return sendFile(req, res, join(ROOT, "public/generated", slug, r[2]));
  }
  if ((r = m(/^\/media\/([^/]+)\/gen\/(mix-(?:main|short)-[a-f0-9]+\.wav)$/)) && req.method === "GET") {
    const slug = slugParam(r[1]);
    return sendFile(req, res, join(ROOT, "public/generated", slug, r[2]));
  }
  if ((r = m(/^\/media\/([^/]+)\/3d\/([\w.-]+\.mp4)$/)) && req.method === "GET") {
    const slug = slugParam(r[1]);
    return sendFile(req, res, join(ROOT, "public/generated", slug, "3d", r[2]));
  }
  // Legacy: out/<slug>.mp4 from before candidates existed.
  if ((r = m(/^\/media\/([^/]+?)(-short)?\.mp4$/)) && req.method === "GET") {
    const slug = slugParam(r[1]);
    return sendFile(req, res, join(OUT, `${slug}${r[2] ?? ""}.mp4`));
  }

  // Jobs
  if (req.method === "GET" && p === "/api/jobs") return send(res, 200, jobs.map(jobSummary).reverse());
  if ((r = m(/^\/api\/jobs\/(\d+)$/)) && req.method === "GET") {
    const job = jobs.find((j) => j.id === Number(r[1]));
    if (!job) throw httpError(404, "No such job");
    return send(res, 200, { ...jobSummary(job), log: job.log });
  }
  if ((r = m(/^\/api\/jobs\/(\d+)\/cancel$/)) && req.method === "POST") return send(res, 200, jobSummary(cancel(Number(r[1]))));

  // Static UI
  if (req.method === "GET" && !p.startsWith("/api/")) {
    const file = p === "/" ? "index.html" : p.slice(1);
    if (!/^[\w.-]+$/.test(file)) return send(res, 404, { error: "Not found" });
    return sendFile(req, res, join(PUBLIC, file));
  }
  throw httpError(404, "Not found");
}

const server = createServer(async (req, res) => {
  if (!allowed(req)) return send(res, 403, { error: "Forbidden" });
  try {
    await route(req, res);
  } catch (err) {
    if (!res.headersSent) send(res, err.status ?? 500, { error: err.message });
    if (!err.status) console.error(err);
  }
});

recoverInterrupted();
server.listen(PORT, HOST, () => {
  console.log(`Musical Explainers admin: http://localhost:${PORT}`);
  console.log(`Node ${ENV.node} · claude CLI: ${ENV.claude ?? "not found"} · ffmpeg: ${ENV.ffmpeg ? "yes" : "no"}`);
  for (const w of ENV.warnings) console.log(`WARNING: ${w}`);
  refreshStatus(allSlugs(), true).then(() => broadcast("status", {}));
});
