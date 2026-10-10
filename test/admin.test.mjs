// Admin server: local-only access, validation without writes, and refusal of
// bad ids and paths. Starts the real server on a spare port.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { request } from "node:http";
import { after, before, test } from "node:test";

const PORT = 4450 + Math.floor(Math.random() * 40);
const url = (p) => `http://127.0.0.1:${PORT}${p}`;
let proc;

before(async () => {
  proc = spawn(process.execPath, ["admin/server.mjs"], { env: { ...process.env, ADMIN_PORT: String(PORT) }, stdio: "pipe" });
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(url("/api/meta"));
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("server did not start");
});
after(() => proc.kill());

test("meta exposes stages and visual systems", async () => {
  const m = await (await fetch(url("/api/meta"))).json();
  assert.deepEqual(m.stages, ["research", "outline", "script", "review", "factcheck", "direct", "assets", "audio", "render", "qa", "package"]);
  assert.ok("network" in m.visuals);
});

test("requests with a foreign Host header are refused (DNS rebinding)", async () => {
  // fetch() can't override Host, so use node:http directly.
  const status = await new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: PORT, path: "/api/meta", headers: { host: "evil.example" } }, (res) => resolve(res.statusCode));
    req.on("error", reject);
    req.end();
  });
  assert.equal(status, 403);
});

test("cross-origin writes are refused", async () => {
  const r = await fetch(url("/api/videos/how-does-the-internet-work/run"), { method: "POST", headers: { origin: "http://evil.example", "content-type": "application/json" }, body: "{}" });
  assert.equal(r.status, 403);
});

test("validate reports problems without writing", async () => {
  const r = await (await fetch(url("/api/videos/how-does-the-internet-work/validate"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ schemaVersion: 2, slug: "how-does-the-internet-work", title: "x", music: { bpm: 500 }, shots: [] }) })).json();
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.includes("bpm")));
});

test("bad slugs, candidate ids, stages and media paths are rejected", async () => {
  assert.equal((await fetch(url("/api/videos/..%2Fetc"))).status, 400);
  assert.equal((await fetch(url("/media/how-does-the-internet-work/c/../../package.json"))).status, 404);
  const run = await fetch(url("/api/videos/how-does-the-internet-work/run"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "stage", stage: "rm -rf" }) });
  assert.equal(run.status, 400);
  const rev = await fetch(url("/api/videos/how-does-the-internet-work/review"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "approved", candidate: "../../x" }) });
  assert.equal(rev.status, 400);
});
