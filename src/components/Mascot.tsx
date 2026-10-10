// The channel mascot: a round, headphone-wearing guide. It breathes and
// blinks, talks while narration plays, and only grooves on the beat when the
// shot asks for it (chorus), instead of bouncing through every scene.
import React from "react";
import { useCurrentFrame } from "remotion";
import type { MascotMood } from "../schema/storyboard.mjs";
import { alpha, Palette } from "../theme";

export type { MascotMood };

export const Mascot: React.FC<{
  p: Palette;
  size: number;
  mood?: MascotMood;
  /** Mouth moves while true. */
  talking?: boolean;
  /** Frames per beat; when set, the mascot nods on each beat. */
  grooveFpb?: number;
  flip?: boolean;
}> = ({ p, size, mood = "happy", talking = false, grooveFpb, flip }) => {
  const frame = useCurrentFrame();
  const breathe = 1 + 0.015 * Math.sin(frame / 18);
  const nod = grooveFpb ? Math.max(0, Math.cos(((frame % grooveFpb) / grooveFpb) * Math.PI * 2)) * 4 : 0;
  const blink = frame % 97 < 4 || frame % 211 < 3;
  const talk = talking ? 0.35 + 0.65 * Math.abs(Math.sin(frame * 0.9) * Math.sin(frame * 0.37 + 1)) : 0;
  const body = p.primary;
  const shade = "#E9A912";
  const ink = p.ink;
  const mouth =
    mood === "wow" ? (
      <ellipse cx={100} cy={128} rx={11} ry={13 + talk * 4} fill={ink} />
    ) : mood === "thinking" ? (
      <path d={`M86 130 Q100 ${124 + talk * 8} 116 132`} stroke={ink} strokeWidth={6} fill="none" strokeLinecap="round" />
    ) : (
      <path d={`M80 122 Q100 ${146 + talk * 8} 120 122 Z`} fill={ink} />
    );
  return (
    <svg width={size} height={size} viewBox="0 0 200 200" style={{ overflow: "visible", transform: `${flip ? "scaleX(-1) " : ""}translateY(${nod}px) scale(${breathe})`, transformOrigin: "50% 100%" }}>
      <ellipse cx={100} cy={194} rx={58} ry={7} fill={alpha("#000000", 0.3)} />
      {mood === "pointing" ? <path d="M160 120 L192 92" stroke={shade} strokeWidth={16} strokeLinecap="round" /> : <path d="M162 128 Q178 140 172 156" stroke={shade} strokeWidth={14} strokeLinecap="round" fill="none" />}
      <path d="M38 128 Q22 140 28 156" stroke={shade} strokeWidth={14} strokeLinecap="round" fill="none" />
      <circle cx={100} cy={110} r={74} fill={body} />
      <path d="M40 132 A74 74 0 0 0 160 132 A70 60 0 0 1 40 132 Z" fill={shade} opacity={0.55} />
      <ellipse cx={74} cy={70} rx={22} ry={12} fill="#ffffff" opacity={0.35} transform="rotate(-25 74 70)" />
      {/* headphones */}
      <path d="M34 104 A66 66 0 0 1 166 104" stroke={ink} strokeWidth={10} fill="none" strokeLinecap="round" />
      <rect x={18} y={92} width={26} height={44} rx={12} fill={p.secondary} />
      <rect x={156} y={92} width={26} height={44} rx={12} fill={p.secondary} />
      {/* face */}
      {blink ? (
        <>
          <path d="M66 100 h16" stroke={ink} strokeWidth={6} strokeLinecap="round" />
          <path d="M118 100 h16" stroke={ink} strokeWidth={6} strokeLinecap="round" />
        </>
      ) : (
        <>
          <ellipse cx={74} cy={100} rx={10} ry={mood === "wow" ? 14 : 12} fill={ink} />
          <ellipse cx={126} cy={100} rx={10} ry={mood === "wow" ? 14 : 12} fill={ink} />
          <circle cx={77} cy={95} r={3.5} fill="#fff" />
          <circle cx={129} cy={95} r={3.5} fill="#fff" />
        </>
      )}
      {mood === "thinking" ? <path d="M62 80 l22 -6 M116 74 l22 6" stroke={ink} strokeWidth={5} strokeLinecap="round" /> : null}
      <circle cx={58} cy={122} r={9} fill={p.secondary} opacity={0.45} />
      <circle cx={142} cy={122} r={9} fill={p.secondary} opacity={0.45} />
      {mouth}
    </svg>
  );
};
