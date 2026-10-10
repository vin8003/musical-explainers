// Shared types. The storyboard itself (VideoSpec v2) is defined next to its
// validator in schema/storyboard.mjs so the admin server can use it too.
import type { VideoSpec } from "./schema/storyboard.mjs";
import type { Format, Timeline } from "./schema/timeline.mjs";

export type { Shot, Visual, VideoSpec } from "./schema/storyboard.mjs";
export type { Format, Timeline, TimedShot } from "./schema/timeline.mjs";

/** Audio for one cut. status says honestly what the mix contains. */
export type AudioTrack = {
  /** Path under public/. */
  src: string | null;
  status: "full" | "partial" | "silent";
  has: { music: boolean; narration: boolean; vocals: boolean; sfx: boolean };
};

/** What the render stage passes to Remotion (--props). */
export type RenderProps = {
  spec: VideoSpec;
  timelines?: Partial<Record<Format, Timeline>>;
  audio?: Partial<Record<Format, AudioTrack>>;
  /** Pre-rendered 3D clips by shot id and cut (paths under public/). */
  clips?: Record<string, Partial<Record<Format, { src: string; seconds: number }>>>;
};
