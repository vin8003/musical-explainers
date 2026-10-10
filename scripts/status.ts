// Prints computed stage status for one or more videos as JSON. The admin
// server calls this so it never re-implements pipeline logic in the browser
// or in plain JS: `tsx scripts/status.ts slug-a slug-b`.
import { computeStatus } from "./core/status";
import { blenderInfo } from "./blender";
import { voiceStatus } from "./providers/voice";

const out: Record<string, unknown> = {};
for (const slug of process.argv.slice(2)) {
  try {
    const s = computeStatus(slug);
    out[slug] = { stages: s.stages, problems: s.problems, lint: s.lint, candidate: s.candidate?.id ?? null, formats: s.formats };
  } catch (e) {
    out[slug] = { error: (e as Error).message };
  }
}
if (process.argv.includes("--env")) out.__env = { blender: blenderInfo(), voice: voiceStatus() };
console.log(JSON.stringify(out));
