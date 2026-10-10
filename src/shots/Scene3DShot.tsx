// A pre-rendered Blender clip placed on the timeline. If the clip wasn't
// rendered (Blender missing or disabled), the shot's fallback visual is drawn
// instead, so the video is complete either way. The clip's speed is adjusted
// (within limits) to fill the shot; it holds its last frame beyond that.
import React from "react";
import { AbsoluteFill, OffthreadVideo, staticFile } from "remotion";
import { SYSTEMS } from "../Explainer";
import { alpha } from "../theme";
import { ShotCtx } from "./context";

type V = Extract<ShotCtx["shot"]["visual"], { type: "scene3d" }>;

export const Scene3DShot: React.FC<{ ctx: ShotCtx }> = ({ ctx }) => {
  const v = ctx.shot.visual as V;
  if (!ctx.clip) {
    const Fallback = SYSTEMS[v.fallback.type];
    return <Fallback ctx={{ ...ctx, shot: { ...ctx.shot, visual: v.fallback } }} />;
  }
  const shotSeconds = (ctx.dur + ctx.lead) / 30;
  const rate = Math.max(0.6, Math.min(1.25, ctx.clip.seconds / shotSeconds));
  return (
    <AbsoluteFill>
      <OffthreadVideo src={staticFile(ctx.clip.src)} muted playbackRate={rate} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      <AbsoluteFill style={{ background: `linear-gradient(180deg, ${alpha("#000", 0.45)} 0%, transparent 28%, transparent 70%, ${alpha("#000", 0.5)} 100%)` }} />
    </AbsoluteFill>
  );
};
