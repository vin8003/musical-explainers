// Used by duration.test.mjs: a candidate whose QA report failed must not package, and probeSeconds reads a real file.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.DATA_ROOT = mkdtempSync(join(tmpdir(), "me-qa-"));
const root = process.env.DATA_ROOT!;
const { paths } = await import("../../scripts/core/files");
const { updateState } = await import("../../scripts/core/state");
const { probeSeconds } = await import("../../scripts/stages/render");
const { packageStage } = await import("../../scripts/stages/package");
const { computeStatus } = await import("../../scripts/core/status");
const { DEFAULT_SETTINGS } = await import("../../src/schema/settings.mjs");

mkdirSync(join(root, "specs"), { recursive: true });
const spec = { schemaVersion: 2, slug: "t", title: "T", format: "main", music: { bpm: 120 }, direction: { status: "directed" }, shots: [{ id: "a", section: "intro", narration: "hello there", visual: { type: "title", title: "Hi" } }] };
writeFileSync(join(root, "specs/t.json"), JSON.stringify(spec));
const dir = paths.candidate("t", "c1");
mkdirSync(join(dir, "qa"), { recursive: true });
execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=64x64:d=2.5:r=30", "-pix_fmt", "yuv420p", join(dir, "main.mp4")]);
updateState("t", (s) => { s.candidates.push({ id: "c1", createdAt: new Date().toISOString(), preview: false, formats: ["main"], specHash: "x", audioHash: null, codeHash: "x", audio: { main: "full" } } as any); });
const ctx = { slug: "t", title: "T", formats: ["main"], settings: DEFAULT_SETTINGS } as any;
let noReportError = "", packageError = "";
try { await packageStage(ctx); } catch (e) { noReportError = (e as Error).message; }
writeFileSync(join(dir, "qa", "report.json"), JSON.stringify({ status: "fail", summary: "FAIL: 1 failure(s), 0 warning(s) across main", findings: [{ check: "duration-target", severity: "fail" }] }));
try { await packageStage(ctx); } catch (e) { packageError = (e as Error).message; }
const qaStage = computeStatus("t", { settings: DEFAULT_SETTINGS as any, formats: ["main"] }).stages.qa.status;
console.log(JSON.stringify({ qaStage, packageError, noReportError, probed: probeSeconds(join(dir, "main.mp4")), probeMissing: probeSeconds(join(dir, "nope.mp4")) }));
