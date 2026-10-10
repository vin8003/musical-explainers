// Layered background: gradient, two slow light sources, drifting dust for
// depth, a faint grid or cell texture per world, and a vignette. Everything is
// seeded, so the same spec renders the same frames.
import React from "react";
import { AbsoluteFill, random, useCurrentFrame } from "remotion";
import type { World } from "../schema/storyboard.mjs";
import { alpha, Palette } from "../theme";

export const Backdrop: React.FC<{ p: Palette; world: World; seed: string; intensity?: number; children?: React.ReactNode }> = ({ p, world, seed, intensity = 1, children }) => {
  const frame = useCurrentFrame();
  const t = frame / 30;
  const g1x = 30 + 8 * Math.sin(t * 0.21 + random(seed + "a") * 6);
  const g1y = 30 + 6 * Math.cos(t * 0.17);
  const g2x = 72 + 8 * Math.cos(t * 0.15 + random(seed + "b") * 6);
  const g2y = 70 + 6 * Math.sin(t * 0.19);
  const dust = Array.from({ length: 36 }).map((_, i) => {
    const r = (k: string) => random(`${seed}-dust-${i}-${k}`);
    const depth = 0.3 + r("d") * 0.7;
    return {
      x: (r("x") * 110 - 5 + t * 0.6 * depth) % 110,
      y: r("y") * 100 + Math.sin(t * 0.4 + i) * 1.5,
      s: 2 + depth * 5,
      o: 0.08 + depth * 0.22,
    };
  });
  const light = world === "paper";
  return (
    <AbsoluteFill style={{ background: `linear-gradient(180deg, ${p.bg[0]} 0%, ${p.bg[1]} 100%)`, overflow: "hidden" }}>
      <AbsoluteFill style={{ background: `radial-gradient(circle at ${g1x}% ${g1y}%, ${alpha(p.glow[0], (light ? 0.5 : 0.38) * intensity)} 0%, transparent 45%)` }} />
      <AbsoluteFill style={{ background: `radial-gradient(circle at ${g2x}% ${g2y}%, ${alpha(p.glow[1], (light ? 0.35 : 0.3) * intensity)} 0%, transparent 50%)` }} />
      {world === "night" ? <Grid p={p} /> : world === "cell" ? <Membrane p={p} t={t} /> : null}
      <AbsoluteFill>
        <svg width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none">
          {dust.map((d, i) => (
            <circle key={i} cx={d.x} cy={d.y} r={d.s * 0.06} fill={light ? alpha(p.ink, d.o * 0.5) : alpha("#ffffff", d.o)} />
          ))}
        </svg>
      </AbsoluteFill>
      {children}
      <AbsoluteFill style={{ background: `radial-gradient(ellipse at 50% 50%, transparent 55%, ${alpha(light ? "#8A6A3A" : "#000000", light ? 0.18 : 0.55)} 100%)`, pointerEvents: "none" }} />
    </AbsoluteFill>
  );
};

const Grid: React.FC<{ p: Palette }> = ({ p }) => (
  <AbsoluteFill
    style={{
      backgroundImage: `linear-gradient(${alpha(p.line, 0.12)} 1px, transparent 1px), linear-gradient(90deg, ${alpha(p.line, 0.12)} 1px, transparent 1px)`,
      backgroundSize: "80px 80px",
      maskImage: "radial-gradient(ellipse at 50% 60%, black 20%, transparent 75%)",
      WebkitMaskImage: "radial-gradient(ellipse at 50% 60%, black 20%, transparent 75%)",
    }}
  />
);

const Membrane: React.FC<{ p: Palette; t: number }> = ({ p, t }) => (
  <AbsoluteFill>
    <svg width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none">
      {[0, 1, 2].map((i) => (
        <path
          key={i}
          d={`M -5 ${20 + i * 30 + Math.sin(t * 0.3 + i) * 3} C 30 ${10 + i * 30} 60 ${35 + i * 30 + Math.cos(t * 0.25) * 4} 105 ${18 + i * 30}`}
          stroke={alpha(p.secondary, 0.1)}
          strokeWidth={6}
          fill="none"
        />
      ))}
    </svg>
  </AbsoluteFill>
);
