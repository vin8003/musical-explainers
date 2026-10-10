// Audio stage: narration -> timeline -> music, chant vocals and SFX on that
// timeline -> ducked, loudness-normalised mix per cut. Narration lengths are
// measured first, so shot lengths (whole bars) fit the words, and the music,
// the sung chorus and the on-screen words all share one set of bar lines.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildTimeline, shotsFor } from "../../src/schema/timeline.mjs";
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
  voiceSeconds: Record<string, number>;
  formats: Partial<Record<Format, AudioTrack & { seconds: number; loudness: { I: number; TP: number; LRA: number } | null; timeline: string }>>;
  warnings: string[];
};

const musicMode = (spec: VideoSpec) => process.env.AUDIO_MUSIC ?? (spec.music.songSrc ? "file" : "synth");
const vocalsMode = (voice: VoiceProvider | null) => (voice?.name === "say" ? process.env.AUDIO_VOCALS ?? "chant" : "none");

export function audioInputHash(spec: VideoSpec) {
  const voice = (() => { try { return getVoiceProvider()?.id ?? "none"; } catch { return "unavailable"; } })();
  return hashOf({
    v: 3,
    music: spec.music,
    shots: spec.shots.map((s) => ({ id: s.id, n: s.narration, l: s.lyric, sec: s.section, b: s.minBars, a: s.accents, t: s.transition, sh: s.short, vt: s.visual?.type })),
    voice,
    musicMode: musicMode(spec),
    vocals: process.env.AUDIO_VOCALS ?? "chant",
  });
}

export function loadAudioManifest(slug: string): AudioManifest | null {
  return readJson<AudioManifest | null>(join(paths.audio(slug), "manifest.json"), null);
}

/** Timelines the renderer should use: measured when audio exists, estimated otherwise. */
export function timelinesFor(spec: VideoSpec, manifest: AudioManifest | null): Record<Format, Timeline> {
  const voice = manifest?.voiceSeconds ?? {};
  return { main: buildTimeline(spec, "main", voice), short: buildTimeline(spec, "short", voice) };
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
  const spec = loadSpec(ctx.slug);
  if (!spec) throw new PipelineError("No storyboard yet", "missing");
  const inputHash = audioInputHash(spec);
  const existing = loadAudioManifest(ctx.slug);
  const wanted = ctx.formats;
  if (existing?.inputHash === inputHash && !ctx.force && wanted.every((f) => existing.formats[f]?.src && existsSync(join(ROOT, "public", existing.formats[f]!.src!))))
    return { summary: `cached: ${describe(existing)}`, cached: true, inputHash };

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
  const voiceSeconds: Record<string, number> = {};
  const clips: Record<string, string> = {};
  const needed = new Set(wanted.flatMap((f) => shotsFor(spec, f).map((s) => s.id)));
  if (voice) {
    licenses.push(voice.license);
    for (const s of spec.shots) {
      if (!s.narration || !needed.has(s.id)) continue;
      const file = join(dir, "voice", `${s.id}-${hashOf([voice.id, s.narration])}.aiff`);
      if (!existsSync(file)) {
        console.log(`  narrating ${s.id}`);
        await voice.speak(s.narration, file);
      }
      clips[s.id] = file;
      voiceSeconds[s.id] = Math.round(durationOf(file) * 1000) / 1000;
    }
  } else if (spec.shots.some((s) => s.narration)) warnings.push("no narration voice available: the video will have music only");

  // 2. Timelines from measured narration.
  const timelines = timelinesFor(spec, { voiceSeconds } as AudioManifest);

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

  const musicKind = musicMode(spec);
  const formats: AudioManifest["formats"] = {};
  // Drop previous mixes (other generated files, e.g. 3D clips, stay).
  mkdirSync(paths.publicGen(ctx.slug), { recursive: true });
  for (const f of readdirSync(paths.publicGen(ctx.slug))) if (/^mix-.*\.wav$/.test(f)) rmSync(join(paths.publicGen(ctx.slug), f));
  for (const format of wanted) {
    const tl = timelines[format];
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
  }

  const manifest: AudioManifest = {
    inputHash,
    at: new Date().toISOString(),
    providers: { voice: voice?.id ?? "none", music: musicKind, vocals },
    licenses: [...new Set(licenses)],
    voiceSeconds,
    formats,
    warnings,
  };
  writeJson(join(dir, "manifest.json"), manifest);
  return { summary: describe(manifest), cached: false, warnings, inputHash };
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
    .map(([f, t]) => `${f}: ${t!.status} (${[t!.has.music && "music", t!.has.narration && "narration", t!.has.vocals && "sung chorus", t!.has.sfx && "sfx"].filter(Boolean).join(" + ")}, ${Math.round(t!.seconds)}s${t!.loudness ? `, ${t!.loudness.I} LUFS` : ""})`)
    .join("; ");
}
