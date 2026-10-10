// Computes each stage's real status from files on disk (not from what the
// last job claimed): missing, fresh, stale or failed, with a one-line reason.
// Used by the pipeline to decide what to run and by the admin panel.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { lintSpec, validateSpec } from "../../src/schema/storyboard.mjs";
import { assetReport, assetsInputHash, describeClips, loadAssetReport } from "../stages/assets";
import { audioInputHash, describe, loadAudioManifest } from "../stages/audio";
import { codeHash, latestCandidate, specHash } from "../stages/render";
import { factItems, loadSpec } from "../stages/text";
import { paths, readJson } from "./files";
import { loadState, Stage, STAGES } from "./state";

export type StageStatus = { status: "missing" | "fresh" | "stale" | "failed"; reason: string };

export function computeStatus(slug: string) {
  const out = {} as Record<Stage, StageStatus>;
  const raw = readJson<Record<string, unknown> | null>(paths.spec(slug), null);
  const spec = loadSpec(slug);
  const state = loadState(slug);
  const sources = readJson<{ claims?: { claim: string; verdict: string }[] } | null>(paths.sources(slug), null);

  out.script = !raw ? { status: "missing", reason: "no script yet" } : raw.schemaVersion !== 2 ? { status: "stale", reason: "v1 spec: will be migrated to a storyboard" } : { status: "fresh", reason: `${spec!.shots.length} shots` };
  const problems = spec && raw?.schemaVersion === 2 ? validateSpec(spec, { slug }) : [];

  if (!spec) {
    for (const s of STAGES.slice(1)) out[s] = { status: "missing", reason: "needs a script" };
    return { stages: out, problems, lint: [], state, spec: null };
  }
  const items = factItems(spec);
  const verdict = new Map((sources?.claims ?? []).map((c) => [c.claim, c.verdict]));
  const flagged = items.filter((i) => verdict.get(i.text) && verdict.get(i.text) !== "ok").length;
  const unchecked = items.filter((i) => !verdict.has(i.text)).length;
  out.factcheck = !sources
    ? { status: "missing", reason: "not checked" }
    : flagged
      ? { status: "failed", reason: `${flagged} flagged claim(s)` }
      : unchecked
        ? { status: "stale", reason: `${unchecked} new or edited text item(s) not checked yet` }
        : { status: "fresh", reason: `${items.length} items ok` };

  out.direct = spec.direction?.status === "directed" ? { status: "fresh", reason: `${new Set(spec.shots.map((s) => s.visual.type)).size} visual systems across ${spec.shots.length} shots` } : { status: "missing", reason: "draft: shots still use placeholder typography" };

  const assets = assetReport(spec);
  const saved = loadAssetReport(slug);
  out.assets = assets.missingRequired
    ? { status: "failed", reason: `${assets.missingRequired} required asset(s) missing` }
    : !saved || saved.inputHash !== assetsInputHash(spec)
      ? { status: saved ? "stale" : "missing", reason: saved ? "visuals or asset settings changed" : "not resolved yet" }
      : { status: "fresh", reason: `${assets.builtins.length} built-in, ${assets.items.length} external, 3D clips: ${describeClips(saved)}` };

  const manifest = loadAudioManifest(slug);
  const audioHash = audioInputHash(spec);
  out.audio = !manifest ? { status: "missing", reason: "no audio yet" } : manifest.inputHash !== audioHash ? { status: "stale", reason: "storyboard text, timing or audio settings changed" } : { status: "fresh", reason: describe(manifest) };

  const cand = latestCandidate(slug);
  const code = codeHash();
  out.render = !cand
    ? { status: "missing", reason: "not rendered" }
    : cand.specHash !== specHash(spec) || (manifest && cand.audioHash !== manifest.inputHash)
      ? { status: "stale", reason: "storyboard or audio changed since the last render" }
      : cand.codeHash !== code
        ? { status: "stale", reason: "renderer code changed since the last render" }
        : { status: "fresh", reason: `candidate ${cand.id}${cand.preview ? " (preview)" : ""}` };

  const qaPath = cand ? join(paths.candidate(slug, cand.id), "qa", "report.json") : null;
  const qa = qaPath ? readJson<{ status: string; summary: string } | null>(qaPath, null) : null;
  out.qa = !qa ? { status: "missing", reason: cand ? "latest candidate not checked" : "nothing rendered" } : qa.status === "fail" ? { status: "failed", reason: qa.summary } : { status: "fresh", reason: qa.summary };
  out.package = cand && existsSync(join(paths.candidate(slug, cand.id), "package", "metadata.json")) ? { status: "fresh", reason: "thumbnail + metadata ready" } : { status: "missing", reason: "not packaged" };

  return { stages: out, problems, lint: lintSpec(spec), state, spec, candidate: cand };
}
