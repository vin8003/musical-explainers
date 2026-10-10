// Composition helpers shared by every scene system: safe areas per format and
// text fitting. The QA stage runs the same fitText to flag text that would
// have to shrink below a readable size on a phone.
import { useVideoConfig } from "remotion";

export type Box = { x: number; y: number; w: number; h: number };

export type Format = {
  w: number;
  h: number;
  vertical: boolean;
  /** 1 at 1080 px on the short side. Multiply pixel sizes by this. */
  u: number;
  /** Area where important content must stay. Vertical leaves room for the YouTube UI. */
  safe: Box;
  /** Main stage for the visual, leaving room for the caption band. */
  stage: Box;
  /** Caption band at the bottom of the safe area. */
  captionBand: Box;
};

export function formatFor(w: number, h: number): Format {
  const vertical = h > w;
  const u = Math.min(w, h) / 1080;
  const safe: Box = vertical
    ? { x: w * 0.07, y: h * 0.09, w: w * 0.86, h: h * 0.72 }
    : { x: w * 0.06, y: h * 0.07, w: w * 0.88, h: h * 0.86 };
  const capH = vertical ? 260 * u : 150 * u;
  const captionBand: Box = { x: safe.x, y: safe.y + safe.h - capH, w: safe.w, h: capH };
  const stage: Box = { x: safe.x, y: safe.y, w: safe.w, h: safe.h - capH - 20 * u };
  return { w, h, vertical, u, safe, stage, captionBand };
}

export const useFormat = (): Format => {
  const { width, height } = useVideoConfig();
  return formatFor(width, height);
};

/** Average glyph width as a share of font size for Avenir Next Heavy/Demi. */
export const CHAR_W = { heavy: 0.6, bold: 0.56, medium: 0.52 } as const;

export type Fit = { size: number; lines: string[]; overflow: boolean };

/**
 * Greedy word wrap at decreasing sizes until the text fits maxLines lines of
 * maxWidth. Returns overflow=true if even minSize doesn't fit.
 */
export function fitText(
  text: string,
  maxWidth: number,
  opts: { maxSize: number; minSize: number; maxLines?: number; weight?: keyof typeof CHAR_W }
): Fit {
  const maxLines = opts.maxLines ?? 2;
  const cw = CHAR_W[opts.weight ?? "heavy"];
  const words = text.split(/\s+/).filter(Boolean);
  for (let size = opts.maxSize; size >= opts.minSize; size = Math.floor(size * 0.94)) {
    const lines = wrap(words, maxWidth / (size * cw));
    if (lines.length <= maxLines && lines.every((l) => l.length * size * cw <= maxWidth)) return { size, lines, overflow: false };
  }
  const lines = wrap(words, maxWidth / (opts.minSize * cw));
  return { size: opts.minSize, lines, overflow: lines.length > maxLines || lines.some((l) => l.length * opts.minSize * cw > maxWidth) };
}

function wrap(words: string[], maxChars: number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length > maxChars && cur) {
      lines.push(cur);
      cur = w;
    } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Maps a 0-100 diagram coordinate into a box. */
export const place = (box: Box, x: number, y: number) => ({ x: box.x + (x / 100) * box.w, y: box.y + (y / 100) * box.h });
