// Beat-synced transition: a colour flash plus a zoom punch on every beat,
// stronger on the first beat of each bar. Wrap any scene content in it.
import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { beatAt } from "../beat";
import { theme } from "../theme";

export const BeatFlash: React.FC<{
  bpm: number;
  color?: string;
  beatsPerBar?: number;
  /** 0 turns the effect off, 1 is the default punch. */
  intensity?: number;
  children: React.ReactNode;
}> = ({ bpm, color = theme.palette.primary, beatsPerBar = 4, intensity = 1, children }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const beat = beatAt(frame, bpm, fps);
  const phase = beat - Math.floor(beat);
  const isDownbeat = Math.floor(beat) % beatsPerBar === 0;
  const strength = (isDownbeat ? 1 : 0.45) * intensity;

  // Fast attack, eased decay over the first 40% of each beat.
  const decay = interpolate(phase, [0, 0.4], [1, 0], {
    extrapolateRight: "clamp",
    easing: theme.easing.smooth,
  });
  const scale = 1 + 0.04 * strength * decay;

  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ transform: `scale(${scale})` }}>{children}</AbsoluteFill>
      <AbsoluteFill
        style={{ backgroundColor: color, opacity: 0.35 * strength * decay, mixBlendMode: "screen" }}
      />
    </AbsoluteFill>
  );
};
