// Computes each stage's real status from files on disk (not from what the
// last job claimed): missing, fresh, stale or failed, with a one-line reason.
// Used by the pipeline to decide what to run and by the admin panel.
// Per-format stages (outline, script, review) are fresh only when every
// requested cut is.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { durationSupport, outlineBlockers, researchBlockers } from "../../src/schema/editorial.mjs";
import { checkDuration, fmt, formatKey } from "../../src/schema/settings.mjs";
import type { Settings } from "../../src/schema/settings.mjs";
import { lintSpec, validateSpec } from "../../src/schema/storyboard.mjs";
import { estimateRuntime } from "../../src/schema/timeline.mjs";
import { assetReport, assetsInputHash, describeClips, loadAssetReport } from "../stages/assets";
import { audioInputHash, cutSpecs, describe, loadAudioManifest } from "../stages/audio";
import {
  loadOutlines, loadResearch, loadReviews, outlineInputHash, researchHash, researchInputHash, reviewFreshness, scriptFreshness, summarizeResearch,
} from "../stages/editorial";
import { codeHash, latestCandidate, specHash } from "../stages/render";
import { factItems, ownSpec, reusableSources, specsFor } from "../stages/text";
import type { Sources } from "../stages/text";
import type { Format, Topic } from "../stages/types";
import { paths, readJson } from "./files";
import { currentSettings } from "./settings";
import { loadState, Stage, STAGES } from "./state";

export type StageStatus = { status: "missing" | "fresh" | "stale" | "failed"; reason: string };

const worst = (xs: StageStatus[]): StageStatus["status"] => (["failed", "missing", "stale", "fresh"] as const).find((st) => xs.some((x) => x.status === st)) ?? "fresh";
function combine(per: Partial<Record<Format, StageStatus>>): StageStatus {
  const list = Object.values(per) as StageStatus[];
  return { status: worst(list), reason: Object.entries(per).map(([f, x]) => `${f}: ${x!.reason}`).join("; ") };
}

export type FormatSummary = {
  target: number; min: number; max: number;
  estimate: { seconds: number; spokenWords: number; sungWords: number; verdict: string; message: string } | null;
  narrationSeconds: number | null;
  audioSeconds: number | null;
  finalSeconds: number | null;
  audioVerdict: string | null;
  review: { pass: boolean; average: number; reasons: string[]; blocking: string[] } | null;
  ownScript: boolean;
};

export function computeStatus(slug: string, opts: { settings?: Settings; formats?: Format[]; title?: string; topic?: Topic } = {}) {
  const settings = opts.settings ?? currentSettings().settings;
  const formats = opts.formats ?? ["main", "short"];
  const out = {} as Record<Stage, StageStatus>;
  const state = loadState(slug);
  const backlog = readJson<{ topics: Topic[] }>(paths.backlog, { topics: [] });
  const topic = opts.topic ?? backlog.topics.find((t) => t.slug === slug);
  const raw = readJson<Record<string, unknown> | null>(paths.spec(slug), null);
  const title = opts.title ?? topic?.title ?? (raw?.title as string | undefined) ?? slug;

  // research
  const research = loadResearch(slug);
  const rHash = researchHash(research);
  const blockers = research ? researchBlockers(research) : [];
  out.research = !research
    ? { status: "missing", reason: "no research dossier yet" }
    : research.inputHash !== researchInputHash(title, topic)
      ? { status: "stale", reason: "the topic or the research prompt changed" }
      : blockers.length
        ? { status: "failed", reason: blockers.join("; ") }
        : { status: "fresh", reason: summarizeResearch(research) };

  // outline (per format)
  const outlines = loadOutlines(slug);
  const support = research ? durationSupport(research, settings) : null;
  out.outline = combine(Object.fromEntries(formats.map((f) => {
    const o = outlines.formats[f];
    const st: StageStatus = !o
      ? { status: "missing", reason: "no outline" }
      : o.inputHash !== outlineInputHash(rHash, settings, f)
        ? { status: "stale", reason: o.durationKey !== formatKey(settings, f) ? "duration settings changed" : "the research changed" }
        : outlineBlockers(o).length
          ? { status: "failed", reason: outlineBlockers(o)[0] }
          : { status: "fresh", reason: `${o.beats.length} beats, ${o.structure}` };
    if (support && !support[f].ok && st.status !== "fresh") return [f, { status: "failed", reason: support[f].note }];
    return [f, st];
  })));

  // script (per format)
  out.script = combine(Object.fromEntries(formats.map((f) => [f, scriptFreshness(slug, f, settings)])));
  const groups = specsFor(slug, formats);
  const problems = groups.flatMap((g) => validateSpec(g.spec, { slug }).map((p) => (groups.length > 1 ? `${g.format}: ${p}` : p)));
  if (!groups.length) {
    for (const s of STAGES.slice(STAGES.indexOf("review"))) out[s] = { status: "missing", reason: "needs a script" };
    return { stages: out, problems, lint: [], state, spec: null, formats: formatSummaries(slug, settings, formats), settings };
  }

  // editorial review (per format; only cuts with their own script can be reviewed)
  out.review = combine(Object.fromEntries(formats.map((f) => [f, reviewFreshness(slug, f)])));

  // fact-check (shared verdicts over every cut's text)
  const sources = reusableSources(readJson<Sources | null>(paths.sources(slug), null), rHash);
  const items = [...new Set(groups.flatMap((g) => factItems(g.spec).map((i) => i.text)))];
  const verdict = new Map((sources?.claims ?? []).map((c) => [c.claim, c.verdict]));
  const flagged = items.filter((i) => verdict.get(i) && verdict.get(i) !== "ok").length;
  const unchecked = items.filter((i) => !verdict.has(i)).length;
  const rawSources = readJson<Sources | null>(paths.sources(slug), null);
  out.factcheck = !rawSources
    ? { status: "missing", reason: "not checked" }
    : flagged
      ? { status: "failed", reason: `${flagged} flagged claim(s)` }
      : unchecked
        ? { status: "stale", reason: (rawSources.researchHash ?? null) !== (rHash ?? null) && rawSources.claims.length ? "the research changed: every item is checked again" : `${unchecked} new or edited text item(s) not checked yet` }
        : { status: "fresh", reason: `${items.length} items ok` };

  out.direct = combine(Object.fromEntries(groups.map((g) => [g.formats.join("+"), g.spec.direction?.status === "directed" ? { status: "fresh", reason: `${new Set(g.spec.shots.map((s) => s.visual.type)).size} visual systems across ${g.spec.shots.length} shots` } : { status: "missing", reason: "draft: shots still use placeholder typography" }])) as Partial<Record<Format, StageStatus>>);

  const specs = cutSpecs(slug, formats);
  const union = { ...(specs.main ?? specs.short)!, shots: groups.flatMap((g) => g.spec.shots) };
  const assets = assetReport(union);
  const saved = loadAssetReport(slug);
  out.assets = assets.missingRequired
    ? { status: "failed", reason: `${assets.missingRequired} required asset(s) missing` }
    : !saved || saved.inputHash !== assetsInputHash(specs)
      ? { status: saved ? "stale" : "missing", reason: saved ? "visuals or asset settings changed" : "not resolved yet" }
      : { status: "fresh", reason: `${assets.builtins.length} built-in, ${assets.items.length} external, 3D clips: ${describeClips(saved)}` };

  const manifest = loadAudioManifest(slug);
  const audioHash = audioInputHash(specs, settings);
  const badDur = formats.filter((f) => manifest?.durations?.[f] && ["short", "long"].includes(manifest.durations[f]!.verdict));
  out.audio = !manifest
    ? { status: "missing", reason: "no audio yet" }
    : manifest.inputHash !== audioHash
      ? { status: "stale", reason: "script text, timing, audio or duration settings changed" }
      : badDur.length && process.env.ALLOW_DURATION_MISMATCH !== "1"
        ? { status: "failed", reason: `duration: ${badDur.map((f) => `${f} ${manifest.durations![f]!.message}`).join("; ")}` }
        : { status: "fresh", reason: describe(manifest) };

  const cand = latestCandidate(slug);
  const code = codeHash();
  out.render = !cand
    ? { status: "missing", reason: "not rendered" }
    : cand.specHash !== specHash(specs) || (manifest && cand.audioHash !== manifest.inputHash)
      ? { status: "stale", reason: "storyboard or audio changed since the last render" }
      : cand.codeHash !== code
        ? { status: "stale", reason: "renderer code changed since the last render" }
        : { status: "fresh", reason: `candidate ${cand.id}${cand.preview ? " (preview)" : ""}` };

  const qaPath = cand ? join(paths.candidate(slug, cand.id), "qa", "report.json") : null;
  const qa = qaPath ? readJson<{ status: string; summary: string } | null>(qaPath, null) : null;
  out.qa = !qa ? { status: "missing", reason: cand ? "latest candidate not checked" : "nothing rendered" } : qa.status === "fail" ? { status: "failed", reason: qa.summary } : { status: "fresh", reason: qa.summary };
  out.package = cand && existsSync(join(paths.candidate(slug, cand.id), "package", "metadata.json")) ? { status: "fresh", reason: "thumbnail + metadata ready" } : { status: "missing", reason: "not packaged" };

  const lint = groups.flatMap((g) => lintSpec(g.spec).map((w) => (groups.length > 1 ? `${g.format}: ${w}` : w)));
  return { stages: out, problems, lint, state, spec: groups[0].spec, candidate: cand, formats: formatSummaries(slug, settings, formats), settings };
}

/** Target, range, estimate, measured narration and final length, and the editorial verdict, per cut. */
export function formatSummaries(slug: string, settings: Settings, formats: Format[] = ["main", "short"]): Partial<Record<Format, FormatSummary>> {
  const manifest = loadAudioManifest(slug);
  const reviews = loadReviews(slug);
  const cand = latestCandidate(slug);
  const qa = cand ? readJson<{ media?: Record<string, { seconds: number }> } | null>(join(paths.candidate(slug, cand.id), "qa", "report.json"), null) : null;
  const specs = cutSpecs(slug, formats);
  const out: Partial<Record<Format, FormatSummary>> = {};
  for (const f of formats) {
    const d = settings.formats[f];
    const spec = specs[f];
    const own = Boolean(ownSpec(slug, f));
    let estimate: FormatSummary["estimate"] = null;
    if (spec) {
      const e = estimateRuntime(spec, f, settings.narration.wordsPerMinute);
      const c = checkDuration(e.seconds, settings, f);
      estimate = { seconds: Math.round(e.seconds), spokenWords: e.spokenWords, sungWords: e.sungWords, verdict: c.verdict, message: c.message };
    }
    const md = manifest?.durations?.[f];
    const r = reviews.formats[f];
    out[f] = {
      target: d.targetSeconds, min: d.minSeconds, max: d.maxSeconds,
      estimate,
      narrationSeconds: md?.narrationSeconds ?? null,
      audioSeconds: md?.seconds ?? (manifest?.formats[f]?.seconds ?? null),
      finalSeconds: qa?.media?.[f]?.seconds ?? null,
      audioVerdict: md?.verdict ?? null,
      review: r ? { pass: r.verdict.pass, average: r.verdict.average, reasons: r.verdict.reasons, blocking: r.blocking.map((b) => b.problem) } : null,
      ownScript: own,
    };
  }
  return out;
}

export { fmt };
