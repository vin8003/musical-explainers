// Used by duration.test.mjs: builds a throwaway data dir with a too-short audio manifest and prints the audio stage status.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
process.env.DATA_ROOT = mkdtempSync(join(tmpdir(), "me-dur-"));
const { computeStatus } = await import("../../scripts/core/status");
const { audioInputHash, cutSpecs } = await import("../../scripts/stages/audio");
const { DEFAULT_SETTINGS } = await import("../../src/schema/settings.mjs");
const root = process.env.DATA_ROOT!;
mkdirSync(join(root, "specs"), { recursive: true });
mkdirSync(join(root, "out/t/audio"), { recursive: true });
const spec = { schemaVersion: 2, slug: "t", title: "T", format: "main", music: { bpm: 120 }, direction: { status: "directed" }, shots: [{ id: "a", section: "intro", narration: "hello there", visual: { type: "title", title: "Hi" } }] };
writeFileSync(join(root, "specs/t.json"), JSON.stringify(spec));
const specs = cutSpecs("t", ["main"]);
const verdict = { narrationSeconds: 5, seconds: 20, spokenWords: 2, measuredWpm: 100, narrationShare: .2, targetSeconds: 420, minSeconds: 300, maxSeconds: 600, verdict: "short", message: "0:20 is shorter than the minimum 5:00" };
writeFileSync(join(root, "out/t/audio/manifest.json"), JSON.stringify({ inputHash: audioInputHash(specs, DEFAULT_SETTINGS as any), formats: {}, durations: { main: verdict }, providers: {}, licenses: [], warnings: [] }));
const s = computeStatus("t", { settings: DEFAULT_SETTINGS as any, formats: ["main"] });
console.log(JSON.stringify(s.stages.audio));
  
