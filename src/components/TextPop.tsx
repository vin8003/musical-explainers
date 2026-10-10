// Big phrase that springs in, with an optional caption underneath.
import React from "react";
import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { theme } from "../theme";

export const TextPop: React.FC<{
  text: string;
  caption?: string;
  color?: string;
  fontSize?: number;
}> = ({ text, caption, color = theme.palette.text, fontSize = 110 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const pop = spring({ frame, fps, config: { damping: 9, stiffness: 160 } });
  const captionIn = interpolate(frame, [8, 20], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: theme.easing.smooth,
  });

  return (
    <div style={{ textAlign: "center", fontFamily: theme.font.family, padding: "0 8%" }}>
      <div
        style={{
          fontSize,
          fontWeight: theme.font.heavy,
          color,
          lineHeight: 1.05,
          transform: `scale(${pop}) rotate(${(1 - pop) * -6}deg)`,
          textShadow: "0 8px 0 rgba(0,0,0,0.25)",
        }}
      >
        {text}
      </div>
      {caption ? (
        <div
          style={{
            marginTop: 28,
            fontSize: fontSize * 0.36,
            fontWeight: theme.font.regular,
            color: theme.palette.textMuted,
            opacity: captionIn,
            transform: `translateY(${(1 - captionIn) * 20}px)`,
          }}
        >
          {caption}
        </div>
      ) : null}
    </div>
  );
};
