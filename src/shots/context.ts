// What every scene system receives. Frames inside a shot are counted from the
// cut (`f = frame - lead`), so f = 0 is the downbeat the shot starts on, and
// negative frames are the incoming transition.
import { useCurrentFrame } from "remotion";
import type { Box, Format } from "../layout";
import type { Shot, VideoSpec } from "../schema/storyboard.mjs";
import type { TimedShot } from "../schema/timeline.mjs";
import type { Palette } from "../theme";

export type ShotCtx = {
  spec: VideoSpec;
  shot: Shot;
  timed: TimedShot;
  p: Palette;
  fmt: Format;
  /** Frames per beat. */
  fpb: number;
  /** Frames of incoming transition before the cut. */
  lead: number;
  /** Nominal length from cut to next cut. */
  dur: number;
  /** Where the visual should draw (stage minus headline). */
  content: Box;
  seed: string;
  /** Pre-rendered 3D clip for this shot and cut, if the Blender backend made one. */
  clip?: { src: string; seconds: number } | null;
};

/** Frames since the cut. */
export const useShotFrame = (ctx: ShotCtx) => useCurrentFrame() - ctx.lead;

/** Frame (since the cut) of beat `b` of this shot. */
export const beatF = (ctx: ShotCtx, b: number) => Math.round(b * ctx.fpb);

/** Content timing: spread n reveals across the first `share` of the shot, landing on beats. */
export function staggerOnBeats(ctx: ShotCtx, n: number, share = 0.55, startBeat = 1) {
  const beats = Math.max(1, Math.floor((ctx.dur * share) / ctx.fpb) - startBeat);
  const step = Math.max(1, Math.floor(beats / Math.max(1, n)));
  return Array.from({ length: n }, (_, i) => beatF(ctx, startBeat + i * step));
}
