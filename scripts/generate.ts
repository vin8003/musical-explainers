// Script-to-video generator.
//
//   npm run generate -- "How does the internet work?"           -> specs/<slug>.json
//   npm run generate -- "How does the internet work?" --render  -> also out/<slug>.mp4
//
// Claude stages run through the local `claude` CLI (subscription, no API key).
// Music/voice go through a swappable provider that defaults to a free stub.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { VideoSpec } from "../src/types";
import { claudeJson } from "./claude";
import { getAudioProvider } from "./providers";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

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

// Stage 2: script + lyrics, written by Claude Code (`claude -p`, subscription).
async function writeScript(title: string, topic?: BacklogTopic): Promise<VideoSpec> {
  const brief = [
    readFileSync(join(ROOT, "prompts/script.md"), "utf8"),
    `Topic: ${title}`,
    topic?.angle ? `Hook idea: ${topic.angle}` : "",
    topic?.chorusIdea ? `Chorus idea: ${topic.chorusIdea}` : "",
    `Use slug: ${topic?.slug ?? slugify(title)}`,
  ].filter(Boolean).join("\n");
  const spec = claudeJson<VideoSpec>(brief);
  if (!spec.scenes?.length || !spec.bpm) throw new Error("Script stage returned an incomplete spec");
  return spec;
}

// Stage 3: fact-check with a second, independent `claude -p` run (web search).
// Writes specs/<slug>.sources.json and stops if any claim needs a fix or cut.
async function factCheck(spec: VideoSpec): Promise<void> {
  const prompt = `${readFileSync(join(ROOT, "prompts/factcheck.md"), "utf8")}\n\n${JSON.stringify(spec)}`;
  const result = claudeJson<{ claims: { claim: string; verdict: string }[] }>(prompt, {
    allowedTools: ["WebSearch", "WebFetch"],
  });
  writeFileSync(join(ROOT, "specs", `${spec.slug}.sources.json`), JSON.stringify(result, null, 2) + "\n");
  const bad = result.claims.filter((c) => c.verdict !== "ok");
  if (bad.length) {
    throw new Error(`Fact-check flagged ${bad.length} claim(s); see specs/${spec.slug}.sources.json`);
  }
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

  if (!args.includes("--skip-factcheck")) await factCheck(spec);
  spec = await getAudioProvider().addAudio(spec);
  writeFileSync(join(ROOT, specPath), JSON.stringify(spec, null, 2) + "\n");
  console.log(`Spec saved to ${specPath}`);

  if (doRender) render(specPath, slug);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
