// Built-in composer: a deterministic, local, licence-free backing track
// arranged on the video's own timeline. Each shot's section picks the
// arrangement (intro: pad + arp, verse: light groove that leaves room for
// narration, chorus: full band + lead melody, bridge: half-time, outro: wind
// down), chords change on bar lines, risers lead into choruses and impacts
// land on the chorus downbeat. Same spec + timeline -> same samples.
import type { VideoSpec } from "../../src/schema/storyboard.mjs";
import type { Timeline } from "../../src/schema/timeline.mjs";
import { SR, Stereo, stereo } from "./wav";

const KEY: Record<string, number> = { C: 0, "C#": 1, D: 2, Eb: 3, E: 4, F: 5, "F#": 6, G: 7, Ab: 8, A: 9, Bb: 10, B: 11 };
const SCALE = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10] };
const PROG = {
  major: { intro: [5, 3, 0, 4], verse: [0, 5, 3, 4], chorus: [0, 4, 5, 3], bridge: [3, 4, 2, 5], outro: [3, 4, 0, 0] },
  minor: { intro: [0, 5, 2, 6], verse: [0, 5, 2, 6], chorus: [5, 6, 0, 0], bridge: [3, 4, 5, 6], outro: [5, 6, 0, 0] },
};
/** Scale-degree contour of the sung hook, reused on every chorus. */
const HOOK = [4, 4, 5, 4, 2, 2, 1, 0, 2, 4, 4, 5, 7, 5, 4, 2];

export const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

function rng(seed: string) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 3432918353), (h = (h << 13) | (h >>> 19));
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Harmony = { root: number; mode: "major" | "minor"; scale: number[] };
export const harmonyOf = (spec: VideoSpec): Harmony => {
  const mode = spec.music.mode ?? "major";
  return { root: 48 + (KEY[spec.music.key ?? "C"] ?? 0), mode, scale: SCALE[mode] };
};

/** MIDI notes of the triad on scale degree d (0-based), around `base`. */
function triad(h: Harmony, d: number, base: number) {
  return [0, 2, 4].map((k) => {
    const idx = d + k;
    return base + h.scale[idx % 7] + 12 * Math.floor(idx / 7);
  });
}

/** Chord (scale degree) for a given bar of a shot. */
export function chordAt(spec: VideoSpec, section: string, barInShot: number) {
  const h = harmonyOf(spec);
  const prog = (PROG[h.mode] as Record<string, number[]>)[section] ?? PROG[h.mode].verse;
  return prog[barInShot % prog.length];
}

/** Melody notes (MIDI) for the chorus chant: one per lyric word, snapped to the bar's chord on strong beats. */
export function hookNotes(spec: VideoSpec, section: string, words: { beat: number }[], shotStartBeat: number) {
  const h = harmonyOf(spec);
  const base = h.root + 12; // around C4-B4: a comfortable chant range
  return words.map((w, i) => {
    let deg = HOOK[i % HOOK.length];
    const local = w.beat - shotStartBeat;
    const chord = chordAt(spec, section, Math.floor(local / 4));
    if (Number.isInteger(local)) {
      const tones = [chord, chord + 2, chord + 4];
      deg = tones.reduce((best, t) => (Math.abs(t - deg) < Math.abs(best - deg) ? t : best), tones[0]);
    }
    return base + h.scale[((deg % 7) + 7) % 7] + 12 * Math.floor(deg / 7);
  });
}

// ---------- instruments ----------

type Voice = (buf: Stereo, t0: number, dur: number, note: number, vel: number, pan?: number) => void;

function addSamples(buf: Stereo, t0: number, len: number, pan: number, fn: (t: number, i: number) => number) {
  const s0 = Math.round(t0 * SR);
  const n = Math.min(Math.round(len * SR), buf.L.length - s0);
  const gl = Math.cos(((pan + 1) * Math.PI) / 4), gr = Math.sin(((pan + 1) * Math.PI) / 4);
  for (let i = Math.max(0, -s0); i < n; i++) {
    const v = fn(i / SR, i);
    buf.L[s0 + i] += v * gl;
    buf.R[s0 + i] += v * gr;
  }
}

const env = (t: number, dur: number, a: number, r: number) => Math.min(1, t / a) * (t > dur ? Math.max(0, 1 - (t - dur) / r) : 1);

const pad: Voice = (buf, t0, dur, note, vel, pan = 0) => {
  const f = hz(note);
  let lp = 0;
  const cut = 0.08;
  addSamples(buf, t0, dur + 0.6, pan, (t) => {
    const saw = ((t * f * 1.004) % 1) * 2 - 1 + (((t * f * 0.996) % 1) * 2 - 1);
    lp += cut * (saw - lp);
    return lp * 0.5 * vel * env(t, dur, 0.25, 0.6);
  });
};

const bass: Voice = (buf, t0, dur, note, vel) => {
  const f = hz(note);
  addSamples(buf, t0, dur + 0.05, 0, (t) => {
    const e = Math.exp(-t * 3) * 0.7 + 0.3;
    const x = Math.sin(2 * Math.PI * f * t) + 0.25 * Math.sin(4 * Math.PI * f * t);
    return Math.tanh(1.6 * x) * vel * e * env(t, dur, 0.005, 0.05);
  });
};

const pluck: Voice = (buf, t0, dur, note, vel, pan = 0) => {
  const f = hz(note);
  addSamples(buf, t0, Math.min(0.5, dur + 0.25), pan, (t) => {
    const tri = 1 - 4 * Math.abs(((t * f + 0.25) % 1) - 0.5);
    return tri * vel * Math.exp(-t * 9);
  });
};

const lead: Voice = (buf, t0, dur, note, vel, pan = 0) => {
  const f = hz(note);
  addSamples(buf, t0, dur + 0.15, pan, (t) => {
    const vib = 1 + 0.004 * Math.sin(2 * Math.PI * 5.5 * t) * Math.min(1, t * 3);
    const ph = 2 * Math.PI * f * vib * t;
    const sq = Math.sin(ph) + Math.sin(3 * ph) / 3 + Math.sin(5 * ph) / 6;
    return sq * 0.5 * vel * env(t, dur, 0.02, 0.15);
  });
};

function drums(rand: () => number) {
  const noise = () => rand() * 2 - 1;
  const kick = (buf: Stereo, t0: number, vel: number) =>
    addSamples(buf, t0, 0.42, 0, (t) => {
      const f = 45 + 85 * Math.exp(-t * 28);
      return Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 7) * vel + (t < 0.004 ? noise() * 0.3 * vel : 0);
    });
  const snare = (buf: Stereo, t0: number, vel: number) => {
    let hp = 0, prev = 0;
    addSamples(buf, t0, 0.25, 0.05, (t) => {
      const n = noise();
      hp = 0.85 * (hp + n - prev);
      prev = n;
      return (hp * Math.exp(-t * 18) * 0.7 + Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t * 30) * 0.5) * vel;
    });
  };
  const hat = (buf: Stereo, t0: number, vel: number, open = false) => {
    let hp = 0, prev = 0;
    addSamples(buf, t0, open ? 0.3 : 0.06, 0.3, (t) => {
      const n = noise();
      hp = 0.6 * (hp + n - prev);
      prev = n;
      return hp * Math.exp(-t * (open ? 10 : 60)) * vel * 0.5;
    });
  };
  const crash = (buf: Stereo, t0: number, vel: number) => {
    let hp = 0, prev = 0;
    addSamples(buf, t0, 2, -0.2, (t) => {
      const n = noise();
      hp = 0.7 * (hp + n - prev);
      prev = n;
      return hp * Math.exp(-t * 2.2) * vel * 0.45;
    });
  };
  const riser = (buf: Stereo, t0: number, len: number, vel: number) => {
    let lp = 0;
    addSamples(buf, t0, len, 0, (t) => {
      const k = t / len;
      lp += (0.01 + 0.4 * k * k) * (noise() - lp);
      return (lp * 0.8 + Math.sin(2 * Math.PI * (200 + 900 * k * k) * t) * 0.08) * vel * k * k;
    });
  };
  const boom = (buf: Stereo, t0: number, vel: number) =>
    addSamples(buf, t0, 1.2, 0, (t) => Math.sin(2 * Math.PI * (38 + 30 * Math.exp(-t * 6)) * t) * Math.exp(-t * 3) * vel);
  return { kick, snare, hat, crash, riser, boom };
}

// ---------- arrangement ----------

type Layer = { kick: number[]; snare: number[]; hats: number; open: boolean; bass: "none" | "root" | "eighths" | "octaves"; pad: number; arp: number; arpRate: 2 | 4; lead: boolean };

const ARR: Record<string, Layer> = {
  intro: { kick: [], snare: [], hats: 0, open: false, bass: "none", pad: 0.7, arp: 0.32, arpRate: 4, lead: false },
  verse: { kick: [0, 10], snare: [4, 12], hats: 2, open: false, bass: "eighths", pad: 0.5, arp: 0.18, arpRate: 4, lead: false },
  chorus: { kick: [0, 4, 8, 12], snare: [4, 12], hats: 4, open: true, bass: "octaves", pad: 0.75, arp: 0.32, arpRate: 4, lead: true },
  bridge: { kick: [0], snare: [8], hats: 2, open: false, bass: "root", pad: 0.75, arp: 0.25, arpRate: 2, lead: false },
  outro: { kick: [0], snare: [], hats: 2, open: false, bass: "root", pad: 0.7, arp: 0.25, arpRate: 4, lead: false },
};

function layerFor(section: string, mood: string): Layer {
  const base = { ...(ARR[section] ?? ARR.verse) };
  if (mood === "calm") {
    if (section === "verse") Object.assign(base, { kick: [], snare: [], hats: 2, bass: "root" });
    if (section === "chorus") Object.assign(base, { kick: [0, 8], hats: 2, open: false });
  }
  if (mood === "driving" && section === "verse") Object.assign(base, { kick: [0, 4, 8, 12] });
  if (mood === "mysterious") Object.assign(base, { arpRate: 2, hats: Math.min(base.hats, 2) });
  return base;
}

export function compose(spec: VideoSpec, tl: Timeline, opts: { leadNotes?: { at: number; dur: number; note: number }[] } = {}): Stereo {
  const beatS = 60 / tl.bpm;
  const totalS = tl.totalFrames / tl.fps + 1.5;
  const buf = stereo(totalS);
  const h = harmonyOf(spec);
  const rand = rng(`${spec.slug}-${tl.format}`);
  const d = drums(rand);
  const mood = spec.music.mood ?? "bright";
  tl.shots.forEach((shot, si) => {
    const L = layerFor(shot.section, mood);
    const next = tl.shots[si + 1];
    const last = si === tl.shots.length - 1;
    for (let bar = 0; bar < shot.bars; bar++) {
      const barT = (shot.startBeat + bar * 4) * beatS;
      const deg = chordAt(spec, shot.section, bar);
      const chord = triad(h, deg, h.root + 12);
      const finalBar = last && bar === shot.bars - 1;
      // pad
      chord.forEach((n, i) => pad(buf, barT, beatS * 4 - 0.05, n, (L.pad * 0.22) / 3, (i - 1) * 0.5));
      if (finalBar) continue;
      // bass
      const root = h.root - 12 + h.scale[deg % 7];
      if (L.bass === "root") bass(buf, barT, beatS * 3.8, root, 0.32);
      else if (L.bass === "eighths") for (let e = 0; e < 8; e++) bass(buf, barT + e * beatS * 0.5, beatS * 0.42, root, e % 2 ? 0.2 : 0.3);
      else if (L.bass === "octaves") for (let e = 0; e < 8; e++) bass(buf, barT + e * beatS * 0.5, beatS * 0.42, root + (e % 2 ? 12 : 0), 0.3);
      // arp
      if (L.arp) {
        const steps = L.arpRate * 4;
        for (let st = 0; st < steps; st++) {
          const n = chord[[0, 1, 2, 1][st % 4]] + 12 + (st % 8 >= 4 ? 12 : 0);
          pluck(buf, barT + st * (beatS * 4) / steps, (beatS * 4) / steps, n, L.arp * 0.16 * (st % 4 === 0 ? 1 : 0.7), st % 2 ? 0.4 : -0.4);
        }
      }
      // drums
      for (let st = 0; st < 16; st++) {
        const t = barT + st * beatS * 0.25;
        if (L.kick.includes(st)) d.kick(buf, t, 0.85);
        if (L.snare.includes(st)) d.snare(buf, t, shot.section === "verse" ? 0.32 : 0.5);
        if (L.hats && st % (16 / (L.hats * 4)) === 0) d.hat(buf, t, st % 4 === 0 ? 0.22 : 0.14);
        if (L.open && st % 4 === 2) d.hat(buf, t, 0.13, true);
      }
    }
    // Into a chorus: riser over the last bar; impact + crash on its downbeat.
    if (next?.section === "chorus" && shot.section !== "chorus") d.riser(buf, (next.startBeat - 4) * beatS, beatS * 4, 0.35);
    if (shot.section === "chorus" && tl.shots[si - 1]?.section !== "chorus") {
      d.crash(buf, shot.startBeat * beatS, 0.6);
      d.boom(buf, shot.startBeat * beatS, 0.5);
    }
  });
  for (const n of opts.leadNotes ?? []) lead(buf, n.at, n.dur, n.note + 12, 0.08, 0.15);
  // Fade the tail over the last bar.
  const end = (tl.totalFrames / tl.fps) * SR, fade = beatS * 4 * SR;
  for (let i = 0; i < buf.L.length; i++) {
    const g = i < end - fade ? 1 : Math.max(0, (end + SR * 0.8 - i) / (fade + SR * 0.8));
    buf.L[i] *= g;
    buf.R[i] *= g;
  }
  return buf;
}

// ---------- sound effects ----------

export function sfx(kind: string, spec: VideoSpec): Stereo {
  const rand = rng(`${spec.slug}-sfx-${kind}`);
  const h = harmonyOf(spec);
  const len = { pop: 0.15, blip: 0.18, whoosh: 0.55, hit: 0.4, riser: 0.9, chime: 1.4 }[kind] ?? 0.3;
  const b = stereo(len);
  const noise = () => rand() * 2 - 1;
  if (kind === "pop") addSamples(b, 0, len, 0, (t) => Math.sin(2 * Math.PI * (300 + 700 * Math.exp(-t * 40)) * t) * Math.exp(-t * 30) * 0.6);
  if (kind === "blip") [0, 0.07].forEach((at, i) => addSamples(b, at, 0.08, i ? 0.3 : -0.3, (t) => Math.sin(2 * Math.PI * hz(h.root + 36 + (i ? 7 : 0)) * t) * Math.exp(-t * 35) * 0.4));
  if (kind === "whoosh") {
    let lp = 0;
    addSamples(b, 0, len, 0, (t) => {
      const k = t / len;
      lp += (0.02 + 0.25 * Math.sin(Math.PI * k)) * (noise() - lp);
      return lp * Math.sin(Math.PI * k) ** 2 * 0.9;
    });
    // pan sweep
    for (let i = 0; i < b.L.length; i++) {
      const k = i / b.L.length;
      b.L[i] *= 1.2 - k;
      b.R[i] *= 0.2 + k;
    }
  }
  if (kind === "hit") addSamples(b, 0, len, 0, (t) => (Math.sin(2 * Math.PI * (70 + 80 * Math.exp(-t * 20)) * t) * 0.8 + noise() * 0.3 * Math.exp(-t * 40)) * Math.exp(-t * 9));
  if (kind === "riser") {
    let lp = 0;
    addSamples(b, 0, len, 0, (t) => {
      const k = t / len;
      lp += (0.01 + 0.3 * k) * (noise() - lp);
      return lp * k * k * 0.7;
    });
  }
  if (kind === "chime") [0, 4, 7].forEach((iv, i) => addSamples(b, i * 0.06, len - i * 0.06, (i - 1) * 0.4, (t) => (Math.sin(2 * Math.PI * hz(h.root + 36 + h.scale[iv % 7] + (iv >= 7 ? 12 : 0)) * t) + 0.3 * Math.sin(2 * Math.PI * hz(h.root + 36) * 2.76 * t)) * Math.exp(-t * 3.5) * 0.18));
  return b;
}
