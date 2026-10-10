// Placeholder mascot: a round, bouncy character that bobs on every beat.
// Swap the SVG for the final character design; keep the props stable.
import React from "react";
import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { beatAt } from "../beat";
import { theme } from "../theme";

export type MascotMood = "happy" | "wow" | "thinking";

export const Mascot: React.FC<{
  bpm: number;
  size?: number;
  mood?: MascotMood;
  color?: string;
}> = ({ bpm, size = 260, mood = "happy", color = theme.palette.primary }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Squash on the downbeat, stretch halfway between beats.
  const phase = beatAt(frame, bpm, fps) % 1;
  const bounce = Math.sin(phase * Math.PI);
  const squash = interpolate(bounce, [0, 1], [0.92, 1.05]);
  const lift = interpolate(bounce, [0, 1], [0, -size * 0.12]);
  const blink = frame % 90 < 4;

  const mouth =
    mood === "wow" ? (
      <ellipse cx={100} cy={135} rx={14} ry={18} fill="#2b1b3f" />
    ) : mood === "thinking" ? (
      <path d="M85 138 Q100 132 118 140" stroke="#2b1b3f" strokeWidth={6} fill="none" strokeLinecap="round" />
    ) : (
      <path d="M75 128 Q100 158 125 128" stroke="#2b1b3f" strokeWidth={7} fill="none" strokeLinecap="round" />
    );

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 200 200"
      style={{
        transform: `translateY(${lift}px) scale(${1 / squash}, ${squash})`,
        transformOrigin: "50% 100%",
        overflow: "visible",
      }}
    >
      <ellipse cx={100} cy={195} rx={60} ry={8} fill="rgba(0,0,0,0.25)" />
      <circle cx={100} cy={105} r={85} fill={color} />
      <circle cx={70} cy={92} r={blink ? 2 : 13} fill="#2b1b3f" />
      <circle cx={130} cy={92} r={blink ? 2 : 13} fill="#2b1b3f" />
      <circle cx={74} cy={87} r={blink ? 0 : 4} fill="#fff" />
      <circle cx={134} cy={87} r={blink ? 0 : 4} fill="#fff" />
      <circle cx={52} cy={122} r={10} fill={theme.palette.secondary} opacity={0.5} />
      <circle cx={148} cy={122} r={10} fill={theme.palette.secondary} opacity={0.5} />
      {mouth}
    </svg>
  );
};
