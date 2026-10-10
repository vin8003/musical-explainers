// Back-compat wrapper: `npm run generate -- "Topic" [--render] [--skip-factcheck]`
// now runs the staged pipeline (scripts/pipeline.ts). Without --render it
// stops after the audio stage, as before it stopped before rendering.
export {};
process.argv.push("--legacy");
await import("./pipeline");
