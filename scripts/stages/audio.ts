// Audio stage: narration -> timeline -> music, chant vocals and SFX on that
// timeline -> ducked, loudness-normalised mix per cut. Narration lengths are
// measured first, so shot lengths (whole bars) fit the words, and the music,
// the sung chorus and the on-screen words all share one set of bar lines.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { checkDuration, fmt, FORMAT_LABEL, formatKey } from "../../src/schema/settings.mjs";
import type { Settings } from "../../src/schema/settings.mjs";
import { buildTimeline, shotsFor, wordCount } from "../../src/schema/timeline.mjs";
import type { Format, Timeline } from "../../src/schema/timeline.mjs";
import type { VideoSpec } from "../../src/schema/storyboard.mjs";
import type { AudioTrack } from "../../src/types";
import { compose, hookNotes, sfx } from "../audio/compose";
import { decode, durationOf, loudness, mixInto, normalize, SR, Stereo, stereo, writeWav } from "../audio/wav";
import { hashOf, paths, PipelineError, readJson, ROOT, writeJson } from "../core/files";
import { getVoiceProvider, VoiceProvider } from "../providers/voice";
import { loadSpec } from "./text";
import type { RunCtx, StageResult } from "./types";

export type AudioManifest = {
  inputHash: string;
  at: string;
  providers: { voice: string; music: string; vocals: string };
  licenses: string[];
  /** Measured narration length per shot, per cut (each cut has its own script). */
  voice?: Partial<Record<Format, Record<string, number>>>;
  /** Legacy (single storyboard): measured narration per shot id. */
  voiceSeconds: Record<string, number>;
  /** Measured lengths per cut against the job's duration settings. */
  durations?: Partial<Record<Format, DurationReport>>;
  formats: Partial<Record<Format, AudioTrack & { seconds: number; loudness: { I: number; TP: number; LRA: number } | null; timeline: string }>>;
  warnings: string[];
};

export type DurationReport = {
  /** Sum of the measured narration clips in this cut. */
  narrationSeconds: number;
  /** Final soundtrack length = video length (narration, sung chorus, musical bars, transitions, tails). */
  seconds: number;
  spokenWords: number;
  /** Effective spoken rate of the narration clips. */
  measuredWpm: number | null;
  /** Share of the video that is narration; the rest is music, chorus and pauses. */
  narrationShare: number;
  targetSeconds: number;
  minSeconds: number;
  maxSeconds: number;
  verdict: string;
  message: string;
  /** Estimate made from the script before audio, for comparison. */
  estimatedSeconds?: number;
};

/** Measured media outside the configured range, per cut. */
export class DurationError extends PipelineError {
  constructor(message: string, public failing: { format: Format; report: DurationReport }[]) {
    super(message, "duration", "Revise the script for that format (the pipeline does one targeted revision automatically), or change the duration range in Settings > Video formats.");
  }
}

export type CutSpecs = Partial<Record<Format, VideoSpec>>;
/** The storyboard behind each cut (a legacy single storyboard serves both). */
export const cutSpecs = (slug: string, formats: Format[] = ["main", "short"]): CutSpecs => Object.fromEntries(formats.map((f) => [f, loadSpec(slug, f)]).filter(([, s]) => s)) as CutSpecs;

const musicMode = (spec: VideoSpec) => process.env.AUDIO_MUSIC ?? (spec.music.songSrc ? "file" : "synth");
const vocalsMode = (voice: VoiceProvider | null) => (voice?.name === "say" ? process.env.AUDIO_VOCALS ?? "chant" : "none");

const specPart = (spec: VideoSpec, format: Format) => ({
  music: spec.music,
  shots: shotsFor(spec, format).map((s) => ({ id: s.id, n: s.narration, l: s.lyric, sec: s.section, b: s.minBars, a: s.accents, t: s.transition, sh: s.short, vt: s.visual?.type })),
});

/** Inputs of the audio: each cut's script text and timing, voice and music settings, and the cut's duration settings (they decide pass/fail). */
export function audioInputHash(specs: CutSpecs, settings: Settings) {
  const voice = (() => { try { return getVoiceProvider()?.id ?? "none"; } catch { return "unavailable"; } })();
  const any = specs.main ?? specs.short;
  return hashOf({
    v: 4,
    cuts: Object.fromEntries((Object.keys(specs) as Format[]).sort().map((f) => [f, { ...specPart(specs[f]!, f), duration: formatKey(settings, f) }])),
    voice,
    musicMode: any ? musicMode(any) : null,
    vocals: process.env.AUDIO_VOCALS ?? "chant",
  });
}

export function loadAudioManifest(slug: string): AudioManifest | null {
  return readJson<AudioManifest | null>(join(paths.audio(slug), "manifest.json"), null);
}

/** Timelines the renderer should use: measured when audio exists, estimated (at the configured delivery rate) otherwise. */
export function timelinesFor(specs: CutSpecs, manifest: AudioManifest | null, settings?: Settings): Partial<Record<Format, Timeline>> {
  const out: Partial<Record<Format, Timeline>> = {};
  for (const f of Object.keys(specs) as Format[]) {
    const voice = manifest?.voice?.[f] ?? manifest?.voiceSeconds ?? {};
    out[f] = buildTimeline(specs[f]!, f, voice, undefined, { wordsPerMinute: settings?.narration.wordsPerMinute });
  }
  return out;
}

/** Simple autocorrelation pitch estimate (Hz) over the loudest part of a mono signal. */
function estimatePitch(x: Float32Array): number {
  const win = 2048, minLag = Math.floor(SR / 400), maxLag = Math.floor(SR / 70);
  const found: number[] = [];
  for (let start = 0; start + win + maxLag < x.length; start += win / 2) {
    let energy = 0;
    for (let i = 0; i < win; i++) energy += x[start + i] ** 2;
    if (energy / win < 1e-4) continue;
    let best = 0, bestLag = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let s = 0;
      for (let i = 0; i < win; i++) s += x[start + i] * x[start + i + lag];
      if (s > best) (best = s), (bestLag = lag);
    }
    if (bestLag && best / energy > 0.3) found.push(SR / bestLag);
  }
  found.sort((a, b) => a - b);
  return found.length ? found[Math.floor(found.length / 2)] : 180;
}

export async function audioStage(ctx: RunCtx): Promise<StageResult> {
  const specs = cutSpecs(ctx.slug);
  const wanted = ctx.formats.filter((f) => specs[f]);
  if (!wanted.length) throw new PipelineError("No storyboard yet", "missing");
  const inputHash = audioInputHash(specs, ctx.settings);
  const existing = loadAudioManifest(ctx.slug);
  if (existing?.inputHash === inputHash && !ctx.force && wanted.every((f) => existing.formats[f]?.src && existsSync(join(ROOT, "public", existing.formats[f]!.src!)))) {
    durationGate(existing, wanted);
    return { summary: `cached: ${describe(existing)}`, cached: true, inputHash };
  }

  const warnings: string[] = [];
  const licenses: string[] = [];
  const dir = paths.audio(ctx.slug);
  mkdirSync(join(dir, "voice"), { recursive: true });

  // 1. Narration, one clip per shot, cached by text + voice settings.
  let voice: VoiceProvider | null = null;
  try {
    voice = getVoiceProvider();
  } catch (e) {
    warnings.push(`narration disabled: ${(e as Error).message}`);
  }
  // Clips are cached by text + voice, so a sentence shared by both cuts is spoken once.
  const voiceByCut: Partial<Record<Format, Record<string, number>>> = {};
  const clipsByCut: Partial<Record<Format, Record<string, string>>> = {};
  if (voice) licenses.push(voice.license);
  for (const f of wanted) {
    const spec = specs[f]!;
    const secs: Record<string, number> = (voiceByCut[f] = {});
    const clips: Record<string, string> = (clipsByCut[f] = {});
    if (!voice) {
      if (spec.shots.some((s) => s.narration)) warnings.push(`${f}: no narration voice available: the video will have music only`);
      continue;
    }
    for (const s of shotsFor(spec, f)) {
      if (!s.narration) continue;
      const file = join(dir, "voice", `${s.id}-${hashOf([voice.id, s.narration])}.aiff`);
      if (!existsSync(file)) {
        console.log(`  narrating ${f} ${s.id}`);
        await voice.speak(s.narration, file);
      }
      clips[s.id] = file;
      secs[s.id] = Math.round(durationOf(file) * 1000) / 1000;
    }
  }

  // 2. Timelines from measured narration.
  const timelines = timelinesFor(Object.fromEntries(wanted.map((f) => [f, specs[f]])) as CutSpecs, { voice: voiceByCut, voiceSeconds: {} } as AudioManifest, ctx.settings);

  // 3. Chant vocals: each lyric word sung (pitch-shifted speech) on its beat.
  const vocals = vocalsMode(voice);
  const wordCache = new Map<string, { file: string; f0: number }>();
  const chantWord = async (word: string) => {
    if (wordCache.has(word)) return wordCache.get(word)!;
    const file = join(dir, "voice", `word-${word.toLowerCase().replace(/[^a-z0-9]/g, "")}-${hashOf([voice!.id, word])}.aiff`);
    if (!existsSync(file)) await voice!.speak(word, file, { rate: 150 });
    const mono = decode(file, "silenceremove=start_periods=1:start_threshold=-40dB,areverse,silenceremove=start_periods=1:start_threshold=-40dB,areverse").L;
    const v = { file, f0: estimatePitch(mono) };
    wordCache.set(word, v);
    return v;
  };

  const musicKind = musicMode(specs[wanted[0]]!);
  const formats: AudioManifest["formats"] = {};
  // Drop previous mixes (other generated files, e.g. 3D clips, stay).
  mkdirSync(paths.publicGen(ctx.slug), { recursive: true });
  for (const f of readdirSync(paths.publicGen(ctx.slug))) if (/^mix-.*\.wav$/.test(f)) rmSync(join(paths.publicGen(ctx.slug), f));
  const durations: Partial<Record<Format, DurationReport>> = {};
  for (const format of wanted) {
    const spec = specs[format]!;
    const clips = clipsByCut[format] ?? {};
    const tl = timelines[format]!;
    const beatS = 60 / tl.bpm;
    const total = tl.totalFrames / tl.fps;
    const narration = stereo(total + 1);
    const vox = stereo(total + 1);
    const fx = stereo(total + 1);
    const leadNotes: { at: number; dur: number; note: number }[] = [];
    for (const t of tl.shots) {
      const s = spec.shots.find((x) => x.id === t.id)!;
      if (t.narration && clips[s.id]) mixInto(narration, normalize(decode(clips[s.id]), 0.8), (t.narration.startFrame / tl.fps) * SR);
      if (t.lyric.length) {
        const notes = hookNotes(spec, s.section, t.lyric, t.startBeat);
        t.lyric.forEach((w, i) => {
          const nextBeat = t.lyric[i + 1]?.beat ?? w.beat + 1.5;
          leadNotes.push({ at: w.beat * beatS, dur: Math.max(0.15, (nextBeat - w.beat) * beatS * 0.9), note: notes[i] });
        });
        if (vocals === "chant" && voice) {
          for (let i = 0; i < t.lyric.length; i++) {
            const w = t.lyric[i];
            const { file, f0 } = await chantWord(w.word);
            const span = ((t.lyric[i + 1]?.beat ?? w.beat + 1.5) - w.beat) * beatS * 0.92;
            const raw = durationOf(file);
            const ratio = Math.max(0.5, Math.min(2.2, (440 * 2 ** ((notes[i] - 69) / 12)) / f0));
            const tempo = Math.max(0.5, Math.min(2.5, raw / Math.max(0.12, span)));
            const sung = decode(file, `silenceremove=start_periods=1:start_threshold=-40dB,rubberband=pitch=${ratio.toFixed(4)}:tempo=${tempo.toFixed(4)}:formant=preserved:pitchq=quality,afade=t=out:st=${Math.max(0, span - 0.06).toFixed(3)}:d=0.06`);
            mixInto(vox, normalize(sung, 0.7), w.beat * beatS * SR);
          }
        }
      }
      // SFX: transitions that move, plus storyboard accents.
      if (t.index > 0 && (t.transition === "push" || t.transition === "zoom" || t.transition === "wipe")) mixInto(fx, sfx("whoosh", spec), (t.startFrame / tl.fps - 0.35) * SR, 0.35);
      for (const a of t.accents) if (a.sfx) mixInto(fx, sfx(a.sfx, spec), (a.frame / tl.fps) * SR, 0.4);
    }
    // Music.
    let music: Stereo | null = null;
    if (musicKind === "synth") {
      music = compose(spec, tl, { leadNotes });
      licenses.push("Music: built-in procedural composer (scripts/audio/compose.ts), original output of this repository.");
    } else if (musicKind === "file" && spec.music.songSrc) {
      const songPath = join(ROOT, "public", spec.music.songSrc);
      if (!existsSync(songPath)) throw new PipelineError(`music.songSrc ${spec.music.songSrc} not found under public/`, "missing");
      music = decode(songPath);
      licenses.push(`Music: user-supplied file ${spec.music.songSrc} (licence is the producer's responsibility).`);
    } else warnings.push("music disabled (AUDIO_MUSIC=none)");

    // Duck the music under narration (not under the chant: that is the song).
    const mix = stereo(total);
    if (music) {
      const env = envelope(narration);
      for (let i = 0; i < mix.L.length; i++) {
        const g = 0.5 * (1 - 0.6 * Math.min(1, env[i] / 0.08));
        mix.L[i] += (music.L[i] ?? 0) * g;
        mix.R[i] += (music.R[i] ?? 0) * g;
      }
    }
    mixInto(mix, narration, 0, 0.95);
    mixInto(mix, vox, 0, 0.62);
    mixInto(mix, fx, 0, 1);
    const rawPath = join(dir, `mix-${format}.raw.wav`);
    writeWav(rawPath, normalize(mix, 0.85));
    if (music) writeWav(join(dir, `music-${format}.wav`), normalize(music, 0.85));
    const rel = `generated/${ctx.slug}/mix-${format}-${inputHash.slice(0, 8)}.wav`;
    const out = join(ROOT, "public", rel);
    mkdirSync(paths.publicGen(ctx.slug), { recursive: true });
    const ln = spawnSync("ffmpeg", ["-v", "error", "-y", "-i", rawPath, "-af", "loudnorm=I=-14:TP=-1.5:LRA=11", "-ar", String(SR), "-t", total.toFixed(3), out], { encoding: "utf8" });
    if (ln.status !== 0) throw new PipelineError(`ffmpeg loudness normalisation failed: ${ln.stderr.slice(0, 300)}`, "failed");
    const hasNarration = Object.keys(clips).some((id) => tl.shots.some((t) => t.id === id));
    const needsNarration = tl.shots.some((t) => spec.shots.find((s) => s.id === t.id)?.narration);
    const hasLyric = tl.shots.some((t) => t.lyric.length);
    const has = { music: Boolean(music), narration: hasNarration, vocals: vocals === "chant" && Boolean(voice) && hasLyric, sfx: true };
    const complete = has.music && (hasNarration || !needsNarration);
    formats[format] = {
      src: rel,
      status: !has.music && !hasNarration ? "silent" : complete ? "full" : "partial",
      has,
      seconds: total,
      loudness: loudness(out),
      timeline: `timeline-${format}.json`,
    };
    writeJson(join(dir, `timeline-${format}.json`), tl);
    // Measure what was actually produced (ffprobe on the final mix), not the plan.
    const measured = Math.round(durationOf(out) * 100) / 100;
    const narrationSeconds = Object.values(voiceByCut[format] ?? {}).reduce((n, x) => n + x, 0);
    const spokenWords = shotsFor(spec, format).reduce((n, s) => n + (clips[s.id] ? wordCount(s.narration) : 0), 0);
    const check = checkDuration(measured, ctx.settings, format);
    const d = ctx.settings.formats[format];
    durations[format] = {
      narrationSeconds: Math.round(narrationSeconds * 10) / 10,
      seconds: measured,
      spokenWords,
      measuredWpm: narrationSeconds > 0 ? Math.round((spokenWords / narrationSeconds) * 600) / 10 : null,
      narrationShare: measured > 0 ? Math.round((narrationSeconds / measured) * 100) / 100 : 0,
      targetSeconds: d.targetSeconds, minSeconds: d.minSeconds, maxSeconds: d.maxSeconds,
      verdict: check.verdict, message: check.message,
      estimatedSeconds: spec.editorial?.estimate?.seconds,
    };
    if (check.verdict === "off-target") warnings.push(`${FORMAT_LABEL[format]}: ${check.message}`);
  }

  const manifest: AudioManifest = {
    inputHash,
    at: new Date().toISOString(),
    providers: { voice: voice?.id ?? "none", music: musicKind, vocals },
    licenses: [...new Set(licenses)],
    voice: voiceByCut,
    voiceSeconds: {},
    durations,
    formats,
    warnings,
  };
  writeJson(join(dir, "manifest.json"), manifest);
  durationGate(manifest, wanted);
  return { summary: describe(manifest), cached: false, warnings, inputHash };
}

/**
 * Measured length outside the configured range is a failure, reported per
 * cut. Nothing is sped up, trimmed or padded to pass: the fix is a script or
 * arrangement revision (or a deliberate settings change).
 * ALLOW_DURATION_MISMATCH=1 lets an old, short video render as a preview.
 */
export function durationGate(m: AudioManifest, formats: Format[]) {
  const failing = formats.flatMap((f) => (m.durations?.[f] && (m.durations[f]!.verdict === "short" || m.durations[f]!.verdict === "long") ? [{ format: f, report: m.durations[f]! }] : []));
  if (!failing.length || process.env.ALLOW_DURATION_MISMATCH === "1") return;
  throw new DurationError(failing.map((x) => `${FORMAT_LABEL[x.format]} measured ${fmt(x.report.seconds)} (narration ${fmt(x.report.narrationSeconds)}): ${x.report.message}`).join("; "), failing);
}

function envelope(b: Stereo) {
  const out = new Float32Array(b.L.length);
  const atk = Math.exp(-1 / (0.02 * SR)), rel = Math.exp(-1 / (0.35 * SR));
  let e = 0;
  for (let i = 0; i < b.L.length; i++) {
    const x = Math.max(Math.abs(b.L[i]), Math.abs(b.R[i]));
    e = x > e ? atk * e + (1 - atk) * x : rel * e + (1 - rel) * x;
    out[i] = e;
  }
  return out;
}

export function describe(m: AudioManifest) {
  return Object.entries(m.formats)
    .map(([f, t]) => {
      const d = m.durations?.[f as Format];
      return `${f}: ${t!.status} (${[t!.has.music && "music", t!.has.narration && "narration", t!.has.vocals && "sung chorus", t!.has.sfx && "sfx"].filter(Boolean).join(" + ")}, ${d ? `${fmt(d.seconds)} [${d.verdict}; narration ${fmt(d.narrationSeconds)}]` : `${Math.round(t!.seconds)}s`}${t!.loudness ? `, ${t!.loudness.I} LUFS` : ""})`;
    })
    .join("; ");
}
