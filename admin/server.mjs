// Local admin panel for the musical-explainers pipeline.
//
//   npm run admin            -> http://localhost:4321
//
// Plain Node (18+), no dependencies. Serves admin/public and a small JSON API.
// Pipeline runs shell out to the existing `npm run generate` script, which
// runs Claude through the local `claude -p` CLI (subscription, no API key).
// Jobs run one at a time, so a batch can't blow through usage limits.
import { spawn, spawnSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = join(ROOT, "admin/public");
const BACKLOG = join(ROOT, "topics/backlog.json");
const SPECS = join(ROOT, "specs");
const OUT = join(ROOT, "out");
const LOGS = join(OUT, "logs");
const ARCHIVE = join(OUT, "archive");
const PORT = Number(process.env.ADMIN_PORT ?? 4321);
const HOST = process.env.ADMIN_HOST ?? "127.0.0.1";

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const STATUSES = ["queued", "scripting", "review", "approved", "scheduled", "published", "rejected"];
const SCENE_KINDS = ["hook", "beat", "chorus", "recap"];
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

function validateSpec(spec, slug) {
  const problems = [];
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw httpError(400, "Spec must be a JSON object");
  if (spec.slug !== slug) problems.push(`slug must stay "${slug}"`);
  if (typeof spec.title !== "string" || !spec.title.trim()) problems.push("title is required");
  if (typeof spec.bpm !== "number" || !(spec.bpm >= 40 && spec.bpm <= 240)) problems.push("bpm must be a number between 40 and 240");
  if (!Array.isArray(spec.scenes) || !spec.scenes.length) problems.push("scenes must be a non-empty list");
  else
    spec.scenes.forEach((s, i) => {
      if (!SCENE_KINDS.includes(s?.kind)) problems.push(`scene ${i + 1}: kind must be one of ${SCENE_KINDS.join(", ")}`);
      if (typeof s?.text !== "string" || !s.text.trim()) problems.push(`scene ${i + 1}: text is required`);
      if (s?.caption != null && typeof s.caption !== "string") problems.push(`scene ${i + 1}: caption must be text`);
      if (typeof s?.durationBeats !== "number" || !(s.durationBeats > 0)) problems.push(`scene ${i + 1}: durationBeats must be a positive number`);
    });
  if (problems.length) throw httpError(400, problems.join("; "));
}

// ---------- environment checks ----------

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
  if (!claudeVersion) warnings.push("The claude CLI was not found. Install Claude Code and log in once, or set CLAUDE_BIN to its path. Script and fact-check runs need it.");
  if (process.env.ANTHROPIC_API_KEY) warnings.push("ANTHROPIC_API_KEY is set in this shell. The pipeline removes it for claude runs so they use your subscription.");
  return { node: `${process.version} ${process.arch}`, claude: claudeVersion, warnings };
}
const ENV = checkEnvironment();

// ---------- per-video status ----------

function videoInfo(slug, topic) {
  const specPath = join(SPECS, `${slug}.json`);
  const sourcesPath = join(SPECS, `${slug}.sources.json`);
  const mainPath = join(OUT, `${slug}.mp4`);
  const shortPath = join(OUT, `${slug}-short.mp4`);
  const spec = readJson(specPath, null);
  const sources = readJson(sourcesPath, null);
  const claims = Array.isArray(sources?.claims) ? sources.claims : [];
  const specAt = mtime(specPath);
  const mainAt = mtime(mainPath);
  const shortAt = mtime(shortPath);
  const renderAt = mainAt && shortAt ? Math.min(mainAt, shortAt) : mainAt ?? shortAt;
  const job = jobs.find((j) => j.slug === slug && (j.state === "running" || j.state === "queued"));
  const lastJob = [...jobs].reverse().find((j) => j.slug === slug);
  const seconds = spec?.bpm && Array.isArray(spec.scenes)
    ? spec.scenes.reduce((n, s) => n + (Number(s.durationBeats) || 0), 0) * (60 / spec.bpm)
    : null;
  return {
    slug,
    title: topic?.title ?? spec?.title ?? slug,
    inBacklog: Boolean(topic),
    status: topic?.status ?? (spec ? "untracked" : "queued"),
    review: topic?.review ?? null,
    spec: spec ? { at: specAt, scenes: spec.scenes?.length ?? 0, bpm: spec.bpm, seconds } : null,
    factcheck: sources
      ? { at: mtime(sourcesPath), claims: claims.length, flagged: claims.filter((c) => c.verdict !== "ok").length, stale: specAt > mtime(sourcesPath) + 1000 }
      : null,
    render: mainAt || shortAt
      ? { main: Boolean(mainAt), short: Boolean(shortAt), at: renderAt, stale: Boolean(specAt && renderAt && specAt > renderAt + 1000) }
      : null,
    job: job ? jobSummary(job) : null,
    lastJob: lastJob ? jobSummary(lastJob) : null,
  };
}

function allVideos() {
  const { topics } = loadBacklog();
  const bySlug = new Map(topics.map((t) => [t.slug, t]));
  const slugs = new Set(topics.map((t) => t.slug));
  for (const f of existsSync(SPECS) ? readdirSync(SPECS) : []) {
    const m = f.match(/^(.+)\.json$/);
    if (m && !m[1].endsWith(".sources") && SLUG_RE.test(m[1])) slugs.add(m[1]);
  }
  return [...slugs].map((s) => videoInfo(s, bySlug.get(s)));
}

// ---------- jobs ----------

// Modes map onto existing generate.ts flags; that script is the only pipeline.
const MODES = {
  full: { label: "Full pipeline (script, fact-check, audio, render)", flags: ["--render"] },
  spec: { label: "Script + fact-check (no render)", flags: [] },
  render: { label: "Render only (skip fact-check)", flags: ["--skip-factcheck", "--render"] },
};

const jobs = [];
let nextId = 1;
const clients = new Set();

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

const jobSummary = (j) => ({
  id: j.id, slug: j.slug, title: j.title, mode: j.mode, modeLabel: MODES[j.mode].label, fresh: j.fresh,
  state: j.state, stage: j.stage, progress: j.progress, flagged: j.flagged, error: j.error,
  createdAt: j.createdAt, startedAt: j.startedAt, endedAt: j.endedAt, exitCode: j.exitCode, logFile: j.logFile,
});

function emitJob(j) {
  broadcast("job", jobSummary(j));
}

// generate.ts finds the backlog entry by title or slugified title, and uses the
// title as the topic in the script prompt, so pass the real title when it maps.
function generateTitle(slug) {
  const topic = loadBacklog().topics.find((t) => t.slug === slug);
  if (topic) return topic.title;
  const spec = readJson(join(SPECS, `${slug}.json`), null);
  if (spec?.title && slugify(spec.title) === slug) return spec.title;
  return slug.replace(/-/g, " ");
}

function enqueue({ slug, mode = "full", fresh = false }) {
  if (!SLUG_RE.test(slug)) throw httpError(400, "Bad slug");
  if (!MODES[mode]) throw httpError(400, "Unknown mode");
  if (jobs.some((j) => j.slug === slug && (j.state === "queued" || j.state === "running")))
    throw httpError(409, "This video already has a job queued or running");
  if (mode === "render" && !existsSync(join(SPECS, `${slug}.json`))) throw httpError(400, "No spec yet: run the script stage first");
  const job = {
    id: nextId++, slug, title: generateTitle(slug), mode, fresh: Boolean(fresh), state: "queued",
    stage: "queued", progress: null, flagged: [], log: "", error: null,
    createdAt: Date.now(), startedAt: null, endedAt: null, exitCode: null, logFile: null, proc: null,
  };
  jobs.push(job);
  if (jobs.length > 200) jobs.splice(0, jobs.length - 200);
  emitJob(job);
  pump();
  return job;
}

function appendLog(job, text) {
  job.log += text;
  if (job.log.length > 2_000_000) job.log = job.log.slice(-1_500_000);
  if (job.logFile) appendFileSync(job.logFile, text);
  broadcast("log", { id: job.id, text });
}

// Turn generate.ts / remotion output into a stage name and render progress.
function parseLine(job, line) {
  const before = `${job.stage}|${job.progress?.done}`;
  if (/^Writing script/.test(line)) job.stage = "script";
  else if (/^Using existing/.test(line)) job.stage = "spec";
  else if (/^\s+revising \(round/.test(line)) job.stage = "revise";
  else if (/^\s+fact-check flagged/.test(line)) { job.stage = "factcheck"; job.flagged = []; }
  else if (/^\s+fact-check passed/.test(line)) job.stage = "factcheck-ok";
  else if (/^\s+- \[(\w+)\] (.*)/.test(line)) { const m = line.match(/^\s+- \[(\w+)\] (.*)/); job.flagged.push({ verdict: m[1], claim: m[2] }); }
  else if (/^\s+\[\w+\] no music/.test(line) || /audio/i.test(line) && /provider/i.test(line)) job.stage = "audio";
  else if (/^Spec saved/.test(line)) job.stage = "saved";
  else if (/^\s+rendering Explainer/.test(line)) { job.stage = "render-main"; job.progress = null; }
  else if (/^\s+rendering Short/.test(line)) { job.stage = "render-short"; job.progress = null; }
  if (job.stage.startsWith("render")) {
    const m = line.match(/(?:Rendered|Rendering|Encoded|Stitched)[^\d]*(\d+)\s*\/\s*(\d+)/i);
    if (m) job.progress = { what: line.match(/^\s*(\w+)/)?.[1] ?? "Rendered", done: Number(m[1]), total: Number(m[2]) };
  }
  // The script stage starts implicitly when the job is fresh or has no spec yet.
  if (`${job.stage}|${job.progress?.done}` !== before) emitJob(job);
}

function pump() {
  if (jobs.some((j) => j.state === "running")) return;
  const job = jobs.find((j) => j.state === "queued");
  if (!job) return;
  start(job);
}

function start(job) {
  const specPath = join(SPECS, `${job.slug}.json`);
  if (job.fresh && existsSync(specPath)) {
    // generate.ts reuses an existing spec, so a fresh script means moving it aside.
    mkdirSync(ARCHIVE, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    renameSync(specPath, join(ARCHIVE, `${job.slug}-${stamp}.json`));
  }
  mkdirSync(LOGS, { recursive: true });
  job.logFile = join(LOGS, `${job.slug}-${new Date().toISOString().replace(/[:.]/g, "-")}-${job.mode}.log`);
  writeFileSync(job.logFile, "");
  job.state = "running";
  job.stage = existsSync(specPath) ? "spec" : "script";
  job.startedAt = Date.now();
  updateTopic(job.slug, (t) => { if (t.status === "queued" || t.status === "rejected") t.status = "scripting"; });

  const args = ["run", "generate", "--", job.title, ...MODES[job.mode].flags];
  appendLog(job, `$ npm ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}\n`);
  const proc = spawn(process.platform === "win32" ? "npm.cmd" : "npm", args, {
    cwd: ROOT,
    detached: process.platform !== "win32", // own process group, so Cancel stops claude/remotion too
    // Put this server's own node first on PATH so the child uses the same arch.
    env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`, FORCE_COLOR: "0", NO_COLOR: "1", CI: "1" },
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
  proc.on("error", (err) => {
    appendLog(job, `\n[admin] could not start npm: ${err.message}\n`);
  });
  proc.on("close", (code, signal) => {
    if (partial) parseLine(job, partial);
    job.proc = null;
    job.exitCode = code;
    job.endedAt = Date.now();
    if (job.state === "cancelled") {
      appendLog(job, `\n[admin] cancelled\n`);
    } else if (code === 0) {
      job.state = "done";
      job.stage = "done";
      job.progress = null;
      if (MODES[job.mode].flags.includes("--render"))
        updateTopic(job.slug, (t) => { if (["queued", "scripting", "rejected"].includes(t.status)) t.status = "review"; });
      appendLog(job, `\n[admin] finished\n`);
    } else {
      job.state = "failed";
      const lastErr = job.log.trim().split("\n").reverse().find((l) => /error|failed|still \d+ flagged/i.test(l));
      job.error = (lastErr ?? `exited with ${signal ?? code}`).slice(0, 400);
      appendLog(job, `\n[admin] failed (exit ${signal ?? code})\n`);
    }
    emitJob(job);
    broadcast("videos", {});
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

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".mp4": "video/mp4", ".log": "text/plain; charset=utf-8" };

// Static files and MP4s, with Range support so the video player can seek.
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
    return send(res, 200, { env: ENV, statuses: STATUSES, sceneKinds: SCENE_KINDS, modes: Object.fromEntries(Object.entries(MODES).map(([k, v]) => [k, v.label])) });

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
  if (req.method === "GET" && p === "/api/videos") return send(res, 200, allVideos());
  if ((r = m(/^\/api\/videos\/([^/]+)$/)) && req.method === "GET") {
    const slug = slugParam(r[1]);
    const topic = loadBacklog().topics.find((t) => t.slug === slug);
    return send(res, 200, {
      ...videoInfo(slug, topic),
      topic: topic ?? null,
      specJson: readJson(join(SPECS, `${slug}.json`), null),
      sourcesJson: readJson(join(SPECS, `${slug}.sources.json`), null),
      jobs: jobs.filter((j) => j.slug === slug).map(jobSummary).reverse(),
    });
  }
  if ((r = m(/^\/api\/videos\/([^/]+)\/spec$/)) && req.method === "PUT") {
    const slug = slugParam(r[1]);
    if (jobs.some((j) => j.slug === slug && j.state === "running")) throw httpError(409, "A job is running for this video; wait for it or cancel it first");
    const spec = await readBody(req);
    validateSpec(spec, slug);
    writeJson(join(SPECS, `${slug}.json`), spec);
    broadcast("videos", {});
    return send(res, 200, { ok: true });
  }
  if ((r = m(/^\/api\/videos\/([^/]+)\/review$/)) && req.method === "POST") {
    const slug = slugParam(r[1]);
    const { decision, notes = "" } = await readBody(req);
    if (!["approved", "rejected", "review"].includes(decision)) throw httpError(400, "decision must be approved, rejected or review");
    const b = loadBacklog();
    let t = b.topics.find((x) => x.slug === slug);
    if (!t) {
      const spec = readJson(join(SPECS, `${slug}.json`), null);
      t = { slug, title: spec?.title ?? slug, category: "", angle: "", chorusIdea: "", status: "review", priority: b.topics.length + 1 };
      b.topics.push(t);
    }
    t.status = decision;
    t.review = decision === "review" ? undefined : { decision, notes: String(notes).trim(), at: new Date().toISOString() };
    saveBacklog(b);
    broadcast("videos", {});
    return send(res, 200, { ok: true });
  }
  if ((r = m(/^\/api\/videos\/([^/]+)\/run$/)) && req.method === "POST") {
    const slug = slugParam(r[1]);
    const body = await readBody(req);
    return send(res, 202, jobSummary(enqueue({ slug, mode: body.mode, fresh: body.fresh })));
  }
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

server.listen(PORT, HOST, () => {
  console.log(`Musical Explainers admin: http://localhost:${PORT}`);
  console.log(`Node ${ENV.node} · claude CLI: ${ENV.claude ?? "not found"}`);
  for (const w of ENV.warnings) console.log(`WARNING: ${w}`);
});
