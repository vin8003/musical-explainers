// Minimal PCM helpers. Decoding and loudness go through ffmpeg (already a
// Remotion requirement); everything else is plain Float32 arrays.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PipelineError } from "../core/files";

export const SR = 44100;
export type Stereo = { L: Float32Array; R: Float32Array };

export const stereo = (seconds: number): Stereo => {
  const n = Math.max(1, Math.ceil(seconds * SR));
  return { L: new Float32Array(n), R: new Float32Array(n) };
};

/** 16-bit PCM WAV with a soft clip, so stray peaks never wrap. */
export function writeWav(path: string, buf: Stereo) {
  mkdirSync(dirname(path), { recursive: true });
  const n = buf.L.length;
  const out = Buffer.alloc(44 + n * 4);
  out.write("RIFF", 0);
  out.writeUInt32LE(36 + n * 4, 4);
  out.write("WAVEfmt ", 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(2, 22);
  out.writeUInt32LE(SR, 24);
  out.writeUInt32LE(SR * 4, 28);
  out.writeUInt16LE(4, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36);
  out.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    out.writeInt16LE(Math.round(Math.tanh(buf.L[i]) * 32767), 44 + i * 4);
    out.writeInt16LE(Math.round(Math.tanh(buf.R[i]) * 32767), 46 + i * 4);
  }
  writeFileSync(path, out);
}

/** Decodes any audio file to stereo float at SR, optionally through an ffmpeg filter chain. */
export function decode(path: string, filter?: string): Stereo {
  const args = ["-v", "error", "-i", path, ...(filter ? ["-af", filter] : []), "-f", "f32le", "-ac", "2", "-ar", String(SR), "-"];
  const res = spawnSync("ffmpeg", args, { maxBuffer: 1024 * 1024 * 1024 });
  if (res.status !== 0) throw new PipelineError(`ffmpeg could not decode ${path}: ${res.stderr?.toString().slice(0, 300)}`, "failed");
  const data = new Float32Array(res.stdout.buffer, res.stdout.byteOffset, res.stdout.byteLength / 4);
  const n = data.length / 2;
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    L[i] = data[i * 2];
    R[i] = data[i * 2 + 1];
  }
  return { L, R };
}

export function durationOf(path: string): number {
  const out = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], { encoding: "utf8" });
  return Number(out.trim());
}

/** Adds src into dst at a sample offset with a gain. */
export function mixInto(dst: Stereo, src: Stereo, at: number, gain = 1) {
  const start = Math.max(0, Math.round(at));
  const n = Math.min(src.L.length, dst.L.length - start);
  for (let i = 0; i < n; i++) {
    dst.L[start + i] += src.L[i] * gain;
    dst.R[start + i] += src.R[i] * gain;
  }
}

export function peak(b: Stereo) {
  let m = 0;
  for (let i = 0; i < b.L.length; i++) m = Math.max(m, Math.abs(b.L[i]), Math.abs(b.R[i]));
  return m;
}

export function normalize(b: Stereo, target = 0.7) {
  const p = peak(b);
  if (!p) return b;
  const g = target / p;
  for (let i = 0; i < b.L.length; i++) {
    b.L[i] *= g;
    b.R[i] *= g;
  }
  return b;
}

/** Integrated loudness / true peak of a file, via ffmpeg's ebur128 filter. */
export function loudness(path: string): { I: number; TP: number; LRA: number } | null {
  const res = spawnSync("ffmpeg", ["-v", "info", "-nostats", "-i", path, "-af", "ebur128=peak=true", "-f", "null", "-"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const txt = res.stderr ?? "";
  const summary = txt.slice(txt.lastIndexOf("Summary:"));
  const I = summary.match(/I:\s+(-?[\d.]+) LUFS/);
  const TP = summary.match(/Peak:\s+(-?[\d.]+) dBFS/);
  const LRA = summary.match(/LRA:\s+(-?[\d.]+) LU/);
  return I ? { I: Number(I[1]), TP: TP ? Number(TP[1]) : NaN, LRA: LRA ? Number(LRA[1]) : NaN } : null;
}
