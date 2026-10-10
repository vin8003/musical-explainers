// Script-to-video generator.
//
//   npm run generate -- "How does the internet work?"           -> specs/<slug>.json
//   npm run generate -- "How does the internet work?" --render  -> also out/<slug>.mp4
//
// Each stage is a function below. Stages that call external services are stubs
// for now; they return placeholder data so the whole chain runs end to end.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { VideoSpec } from "../src/types";

const ROOT = join(import.meta.dirname, "..");

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

type BacklogTopic = { slug: string; title: string; angle?: string; chorusIdea?: string; status: string };

function findTopic(title: string): BacklogTopic | undefined {
  const backlog = JSON.parse(readFileSync(join(ROOT, "topics/backlog.json"), "utf8")) as {
    topics: BacklogTopic[];
  };
  const slug = slugify(title);
  return backlog.topics.find((t) => t.slug === slug || t.title.toLowerCase() === title.toLowerCase());
}

// Stage 2: script + lyrics.
// TODO: call the Claude API with the channel's script prompt (hook in 5s,
// 3-4 beats, chorus that carries the key idea, recap) and parse a VideoSpec.
async function writeScript(title: string, topic?: BacklogTopic): Promise<VideoSpec> {
  const chorus = topic?.chorusIdea ?? `${title.replace(/\?$/, "")}, here we go!`;
  return {
    slug: topic?.slug ?? slugify(title),
    title,
    bpm: 120,
    scenes: [
      { kind: "hook", text: topic?.angle ?? title, durationBeats: 8 },
      { kind: "beat", text: "Idea one", caption: "TODO: written by Claude", durationBeats: 8 },
      { kind: "beat", text: "Idea two", caption: "TODO: written by Claude", durationBeats: 8 },
      { kind: "chorus", text: chorus, durationBeats: 8 },
      { kind: "beat", text: "Idea three", caption: "TODO: written by Claude", durationBeats: 8 },
      { kind: "chorus", text: chorus, durationBeats: 8 },
      { kind: "recap", text: "Recap", caption: "TODO: written by Claude", durationBeats: 8 },
    ],
  };
}

// Stage 3: fact-check. TODO: second Claude pass with web search; write
// specs/<slug>.sources.json and fail if any claim is marked fix/cut.
async function factCheck(spec: VideoSpec): Promise<void> {
  console.log(`  [stub] fact-check skipped for ${spec.slug}`);
}

// Stages 4-5: music + narration. TODO: ElevenLabs Music + TTS, save under
// public/assets/<slug>/, set spec.songSrc, spec.bpm, spec.beatOffsetMs.
async function addAudio(spec: VideoSpec): Promise<VideoSpec> {
  console.log(`  [stub] music and voiceover skipped for ${spec.slug}`);
  return spec;
}

function render(specPath: string, slug: string) {
  mkdirSync(join(ROOT, "out"), { recursive: true });
  for (const [id, suffix] of [["Explainer", ""], ["Short", "-short"]] as const) {
    const out = join("out", `${slug}${suffix}.mp4`);
    console.log(`  rendering ${id} -> ${out}`);
    execFileSync("npx", ["remotion", "render", "src/index.ts", id, out, `--props=${specPath}`], {
      cwd: ROOT,
      stdio: "inherit",
    });
  }
}

async function main() {
  const args = process.argv.slice(2);
  const doRender = args.includes("--render");
  const title = args.filter((a) => !a.startsWith("--")).join(" ").trim();
  if (!title) {
    console.error('Usage: npm run generate -- "Topic title" [--render]');
    process.exit(1);
  }

  const topic = findTopic(title);
  const slug = topic?.slug ?? slugify(title);
  const specPath = join("specs", `${slug}.json`);

  let spec: VideoSpec;
  if (existsSync(join(ROOT, specPath))) {
    console.log(`Using existing ${specPath}`);
    spec = JSON.parse(readFileSync(join(ROOT, specPath), "utf8"));
  } else {
    console.log(`Writing script for "${title}"`);
    spec = await writeScript(title, topic);
  }

  await factCheck(spec);
  spec = await addAudio(spec);
  writeFileSync(join(ROOT, specPath), JSON.stringify(spec, null, 2) + "\n");
  console.log(`Spec saved to ${specPath}`);

  if (doRender) render(specPath, slug);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
