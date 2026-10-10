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
type Claim = { claim: string; verdict: string; correction?: string; sources?: string[] };

async function checkClaims(spec: VideoSpec): Promise<Claim[]> {
  const prompt = `${readFileSync(join(ROOT, "prompts/factcheck.md"), "utf8")}\n\n${JSON.stringify(spec)}`;
  const result = claudeJson<{ claims: Claim[] }>(prompt, { allowedTools: ["WebSearch", "WebFetch"] });
  writeFileSync(join(ROOT, "specs", `${spec.slug}.sources.json`), JSON.stringify(result, null, 2) + "\n");
  return result.claims;
}

// Rewrites only the flagged claims, keeping structure, timing and style.
async function reviseSpec(spec: VideoSpec, flagged: Claim[]): Promise<VideoSpec> {
  const prompt = `${readFileSync(join(ROOT, "prompts/revise.md"), "utf8")}\n\nFlagged claims:\n${JSON.stringify(flagged, null, 2)}\n\nVideoSpec:\n${JSON.stringify(spec)}`;
  const revised = claudeJson<VideoSpec>(prompt);
  if (!revised.scenes?.length || revised.scenes.length !== spec.scenes.length) {
    throw new Error("Revision changed the scene count or returned an incomplete spec");
  }
  return { ...revised, slug: spec.slug };
}

// Check, revise flagged claims, re-check: up to MAX_REVISIONS rounds.
const MAX_REVISIONS = 2;
async function factCheckLoop(spec: VideoSpec, save: (s: VideoSpec) => void): Promise<VideoSpec> {
  for (let round = 0; ; round++) {
    const flagged = (await checkClaims(spec)).filter((c) => c.verdict !== "ok");
    if (!flagged.length) {
      console.log(round ? `  fact-check passed after ${round} revision(s)` : "  fact-check passed");
      return spec;
    }
    console.log(`  fact-check flagged ${flagged.length} claim(s):`);
    for (const c of flagged) console.log(`    - [${c.verdict}] ${c.claim}`);
    if (round >= MAX_REVISIONS) {
      throw new Error(`Still ${flagged.length} flagged claim(s) after ${MAX_REVISIONS} revisions; see specs/${spec.slug}.sources.json`);
    }
    console.log(`  revising (round ${round + 1}/${MAX_REVISIONS})`);
    spec = await reviseSpec(spec, flagged);
    save(spec);
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

  const save = (s: VideoSpec) => writeFileSync(join(ROOT, specPath), JSON.stringify(s, null, 2) + "\n");
  save(spec); // keep the draft even if a later stage fails
  if (!args.includes("--skip-factcheck")) spec = await factCheckLoop(spec, save);
  spec = await getAudioProvider().addAudio(spec);
  save(spec);
  console.log(`Spec saved to ${specPath}`);

  if (doRender) render(specPath, slug);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
