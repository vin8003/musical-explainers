#!/usr/bin/env node
// A stand-in for `claude -p --output-format json` used by the pipeline tests.
// It recognises which stage is calling from the prompt, returns a canned,
// deterministic reply, and appends {kind, format, ...} to $FAKE_LOG so tests
// can assert call order and what each prompt contained. No network, no model.
//
// FAKE_MODE (comma-separated):
//   weak-review-once     the first landscape review scores low; later ones pass
//   weak-review-always   every landscape review scores low
//   unsupported-thesis   the dossier's thesis rests on an "insufficient" claim
//   fail-script-short    the Short script call fails (exit 1), to simulate an interruption
//   overlong-short       the Short script is always far over its range (the length retry cannot fix it)
//   bad-claim            the first dossier has one invalid field (claims[2] source url); a field repair fixes it
//   bad-claim-always     the field repair is also wrong (it keeps the bad url)
//   no-usage             the CLI result carries no usage metadata
//   partial-usage        only input/output tokens are reported
//   research-v2          the dossier text differs (a research change)
// FAKE_MUTATE_SETTINGS=<path> + FAKE_MUTATE_JSON: overwrite the settings file during the first outline call.
import { appendFileSync, existsSync, writeFileSync } from "node:fs";

const modes = new Set((process.env.FAKE_MODE ?? "").split(",").filter(Boolean));
let input = "";
for await (const c of process.stdin) input += c;

const log = (entry) => process.env.FAKE_LOG && appendFileSync(process.env.FAKE_LOG, JSON.stringify(entry) + "\n");
const envelope = (result) => {
  const e = { type: "result", subtype: "success", is_error: false, result, num_turns: 1 };
  if (modes.has("no-usage")) return e;
  e.usage = modes.has("partial-usage") ? { input_tokens: 10, output_tokens: 20 } : { input_tokens: 10, cache_creation_input_tokens: 50, cache_read_input_tokens: 100, output_tokens: 20, service_tier: "standard" };
  if (!modes.has("partial-usage")) { e.total_cost_usd = 0.01; e.modelUsage = { "claude-sonnet-fake": { inputTokens: 10, outputTokens: 20 } }; }
  return e;
};
const reply = (obj) => {
  // Exit only after stdout is flushed: a pipe may take large replies in pieces.
  process.stdout.write(JSON.stringify(envelope(typeof obj === "string" ? obj : JSON.stringify(obj))), () => process.exit(0));
  return new Promise(() => {});
};
const format = /## Format: Short/.test(input) ? "short" : /## Format: Landscape/.test(input) ? "main" : null;

const src = (n) => [{ url: `https://example.org/source-${n}`, title: `Source ${n}`, passage: `Finding ${n}`, supports: `claim ${n}`, kind: "authoritative", accessed: "fetched" }];

if (input.includes("Some fields of a JSON object you produced failed validation")) {
  log({ kind: "repair-fields", chars: input.length, hasOriginalPrompt: input.includes("You are the researcher") });
  const patch = {};
  for (const m of input.slice(input.indexOf("Current values:")).matchAll(/^([\w]+(?:\[\d+\])?): (.*)$/gm)) {
    patch[m[1]] = JSON.parse(m[2].replace(/not-a-url/g, modes.has("bad-claim-always") ? "not-a-url" : "https://example.org/fixed"));
  }
  await reply({ patch });
}

if (input.includes("You are the researcher")) {
  log({ kind: "research" });
  const v2 = modes.has("research-v2");
  const claims = Array.from({ length: 8 }, (_, i) => ({ id: `c${i + 1}`, text: `Fact number ${i + 1}${v2 ? " (revised)" : ""}`, status: "supported", importance: 3, sources: src(i + 1) }));
  if (modes.has("bad-claim")) claims[2].sources[0].url = "not-a-url";
  claims.push({ id: "weak", text: "A rumour", status: "insufficient", note: "no source found", sources: [] });
  await reply({
    qualification: { verdict: "proceed", centralQuestion: "How does it work?", angles: [{ angle: "The mechanism", question: "How?", strengths: "clear", weaknesses: "none", evidence: "strong" }], selectedAngle: "The mechanism", reason: "best evidence", scores: { curiosity: 4, depth: 4, evidence: 5, misconceptions: 3, demonstrations: 4, musical: 3 }, supportedMinutes: { min: 1, max: 12 }, shortInsight: "The one key idea" },
    audience: "curious people", mechanism: "A causes B, which causes C.",
    thesis: { statement: "A leads to C through B", mentalModel: "a relay", claimIds: modes.has("unsupported-thesis") ? ["weak"] : ["c1", "c2"] },
    prerequisites: [{ term: "A", definition: "the start" }], claims,
    misconceptions: [{ misconception: "A causes C directly", correction: "B is in between", claimIds: ["c3"] }],
    examples: [{ kind: "example", description: "a concrete case", claimIds: ["c4"] }, { kind: "analogy", description: "like a relay race", claimIds: ["c5"], caveat: "runners don't copy" }],
    insights: [{ insight: "B matters", claimIds: ["c2"] }, { insight: "order matters", claimIds: ["c6"] }, { insight: "C is the result", claimIds: ["c7"] }],
    uncertainties: [], exclusions: [{ claim: "A rumour", reason: "unverified" }], sourceQuality: "good",
  });
}

const seconds = (re) => Number(input.match(re)?.[1] ?? 0);
const target = seconds(/Target duration: [\d:]+ \((\d+) s\)/);
const wpm = seconds(/Narration delivery rate: (\d+) words per minute/) || 156;

if (input.includes("plan ONE video in the requested format")) {
  log({ kind: "outline", format, target });
  if (process.env.FAKE_MUTATE_SETTINGS && !existsSync(`${process.env.FAKE_MUTATE_SETTINGS}.mutated`)) {
    writeFileSync(process.env.FAKE_MUTATE_SETTINGS, process.env.FAKE_MUTATE_JSON);
    writeFileSync(`${process.env.FAKE_MUTATE_SETTINGS}.mutated`, "1");
  }
  const n = format === "short" ? 3 : 6;
  const roles = format === "short" ? ["hook", "mechanism", "resolution"] : ["hook", "setup", "mechanism", "example", "complication", "resolution"];
  await reply({
    openingQuestion: "How?", understandingChange: "from magic to mechanism", structure: "causal-chain", prerequisites: ["A"],
    beats: roles.slice(0, n).map((role, i) => ({ id: `b${i + 1}`, role, point: `point ${i + 1}`, claimIds: role === "hook" || role === "resolution" ? [] : [`c${i + 1}`], seconds: target / n, visual: "diagram" })),
    keyExample: { description: "a case", claimIds: ["c4"] }, complication: { description: "a twist", claimIds: ["c3"] }, conclusion: "A to C via B",
    longFormOnly: format === "main" ? ["history"] : [], coreInsight: "B is in between", chorus: { line: "A to B to C", reinforces: "the chain" }, fit: { verdict: "fits", note: "ok" },
  });
}

if (input.includes("You write the script for ONE format")) {
  log({ kind: "script", format, target, revision: input.includes("## Revise the previous version") });
  if (format === "short" && modes.has("fail-script-short")) {
    process.stderr.write("simulated interruption");
    process.exit(1);
  }
  // Enough narration to land near the target at the given rate (bars and chorus add a little).
  const perShot = format === "short" ? 25 : 40;
  const words = Math.round(((target * wpm) / 60) * 0.85) * (format === "short" && modes.has("overlong-short") ? 3 : 1);
  const n = Math.max(format === "short" ? 3 : 8, Math.round(words / perShot));
  const tag = format === "short" ? "short" : "long";
  const shots = Array.from({ length: n }, (_, i) => ({
    id: `${tag}-shot-${i + 1}`, section: i === 0 ? "intro" : i === n - 1 ? "outro" : "verse", purpose: `beat ${i + 1}`, beat: `b${Math.min(i + 1, 3)}`,
    narration: Array.from({ length: perShot }, (_, w) => (w === 0 ? `${tag[0].toUpperCase()}${tag.slice(1)}${i}` : "word")).join(" ") + ".",
    claims: [`c${(i % 8) + 1}`],
  }));
  shots.splice(2, 0, { id: `${tag}-chorus`, section: "chorus", lyric: "A to B to C", purpose: "chorus", claims: [] });
  await reply({ slug: "x", title: "Test topic", brief: { audience: "all", learningGoal: "explain A to C", hook: "How?" }, world: "night", music: { bpm: 120, key: "C", mode: "major", mood: "bright" }, shots });
}

if (input.includes("independent editor reviewing ONE script")) {
  const isMain = format === "main";
  const marker = `${process.env.FAKE_LOG}.weak-reviewed`;
  const weak = isMain && (modes.has("weak-review-always") || (modes.has("weak-review-once") && !existsSync(marker)));
  if (weak) writeFileSync(marker, "1");
  log({ kind: "review", format, weak });
  const ids = [...input.matchAll(/"id": "([a-z0-9-]+)"/g)].map((m) => m[1]);
  const shot = ids.find((i) => /shot/.test(i)) ?? ids[0];
  const scores = weak
    ? { accuracy: 5, clarity: 3, progression: 5, specificity: 5, examples: 5, engagement: 5, memorability: 5, formatFit: 5, music: 5, redundancy: 5 }
    : { accuracy: 5, clarity: 4, progression: 4, specificity: 4, examples: 4, engagement: 4, memorability: 4, formatFit: 4, music: 4, redundancy: 4 };
  await reply({ scores, blocking: [], findings: weak ? [{ shot, criterion: "clarity", severity: "major", problem: "jargon", fix: "explain it" }] : [], summary: weak ? "high average but unclear" : "teaches the chain" });
}

if (input.includes("strict fact-checker")) {
  const items = JSON.parse(input.slice(input.lastIndexOf("Items:") + 6));
  log({ kind: "factcheck", n: items.length });
  await reply({ claims: items.map((i) => ({ shot: i.shot, claim: i.text, verdict: "ok", sources: [{ url: "https://example.org/x", title: "X", passage: "y" }] })) });
}

if (input.includes("creative director and storyboard artist")) {
  const ids = input.slice(input.lastIndexOf("## Direct these shots")).split("\n")[1].split(",").map((s) => s.trim()).filter(Boolean);
  log({ kind: "direct", n: ids.length, hasOutline: input.includes("## Approved outline"), hasClaims: input.includes("## Research claims stated in the script") });
  await reply({ shots: ids.map((id, i) => ({ id, visual: i % 2 ? { type: "steps", steps: [{ icon: "check", label: "A" }, { icon: "star", label: "B" }] } : { type: "kinetic", style: "stack", lines: ["A to C"] } })) });
}

log({ kind: "unknown", head: input.slice(0, 200) });
process.stdout.write(JSON.stringify({ is_error: true, result: "unknown prompt" }));
process.exit(1);
