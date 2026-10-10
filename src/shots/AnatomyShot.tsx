// Close-up: the camera eases in on one subject and labelled callouts point at
// its parts, one per beat. Packets get a dedicated header/payload drawing, so
// "the address is in the header" is shown, not just said.
import React from "react";
import { AbsoluteFill } from "remotion";
import { Icon } from "../assets/icons";
import { appear, travel } from "../components/motion";
import { Label } from "../components/Text";
import { resolveAnchor } from "../schema/storyboard.mjs";
import { alpha, Palette, theme } from "../theme";
import { ShotCtx, staggerOnBeats, useShotFrame } from "./context";

type V = Extract<ShotCtx["shot"]["visual"], { type: "anatomy" }>;

export const AnatomyShot: React.FC<{ ctx: ShotCtx }> = ({ ctx }) => {
  const v = ctx.shot.visual as V;
  const f = useShotFrame(ctx);
  const { p, fmt, content: box } = ctx;
  const S = Math.min(fmt.vertical ? box.w * 0.78 : box.h * 0.86, fmt.vertical ? box.h * 0.5 : box.w * 0.48);
  const cx = fmt.vertical ? box.x + box.w / 2 : box.x + box.w * 0.5;
  const cy = fmt.vertical ? box.y + box.h * 0.42 : box.y + box.h / 2;
  const zoom = 0.55 + 0.45 * travel(f, -ctx.lead, ctx.fpb * 2);
  const at = staggerOnBeats(ctx, v.callouts.length, 0.6, 2);
  const left = cx - S / 2, top = cy - S / 2;

  return (
    <AbsoluteFill>
      <div style={{ position: "absolute", left: cx - S * 0.75, top: cy - S * 0.75, width: S * 1.5, height: S * 1.5, borderRadius: "50%", background: `radial-gradient(circle, ${alpha(p.glow[0], 0.35)} 0%, transparent 65%)` }} />
      <div style={{ position: "absolute", left, top, width: S, height: S, transform: `scale(${zoom})` }}>
        {v.subject === "packet" ? <PacketCard p={p} S={S} f={f} /> : <Icon id={v.subject} p={p} size={S} />}
      </div>
      <svg width={fmt.w} height={fmt.h} style={{ position: "absolute", inset: 0 }}>
        {v.callouts.map((c, i) => {
          const pt = resolveAnchor(v.subject, c);
          const ax = left + pt.x * S, ay = top + pt.y * S;
          const { lx, ly } = labelPos(i, pt, cx, cy, S, fmt.vertical, v.callouts.length);
          const k = travel(f, at[i], at[i] + 10);
          return (
            <g key={i} opacity={k > 0 ? 1 : 0}>
              <circle cx={ax} cy={ay} r={(10 + 6 * (1 - k)) * fmt.u} fill={p.primary} stroke={p.ink} strokeWidth={3 * fmt.u} />
              <line x1={ax} y1={ay} x2={ax + (lx - ax) * k} y2={ay + (ly - ay) * k} stroke={p.primary} strokeWidth={4 * fmt.u} strokeLinecap="round" />
            </g>
          );
        })}
      </svg>
      {v.callouts.map((c, i) => {
        const pt = resolveAnchor(v.subject, c);
        const { lx, ly, side } = labelPos(i, pt, cx, cy, S, fmt.vertical, v.callouts.length);
        const k = appear(f, at[i] + 6, 12);
        return (
          <div key={i} style={{ position: "absolute", left: lx, top: ly, transform: `translate(${side === "left" ? "-100%" : side === "right" ? "0" : "-50%"}, -50%)` }}>
            <Label text={c.label} p={p} fmt={fmt} k={k} size={34} tone={i === 0 ? "accent" : "dark"} maxWidth={(fmt.vertical ? 420 : 460) * fmt.u} />
          </div>
        );
      })}
      {v.label ? (
        <div style={{ position: "absolute", left: cx, top: top + S + 20 * fmt.u, transform: "translateX(-50%)", fontFamily: theme.font.body, fontWeight: 700, color: p.textMuted, fontSize: 28 * fmt.u, letterSpacing: 3 * fmt.u, textTransform: "uppercase", opacity: appear(f, 0, 12) }}>{v.label}</div>
      ) : null}
    </AbsoluteFill>
  );
};

function labelPos(i: number, pt: { x: number; y: number }, cx: number, cy: number, S: number, vertical: boolean, n: number) {
  if (vertical) {
    // Stack labels below/above the subject, alternating, to keep them on screen.
    const below = i % 2 === 0;
    const row = Math.floor(i / 2);
    return { lx: cx + (pt.x - 0.5) * S * 0.6, ly: below ? cy + S * 0.62 + row * S * 0.2 : cy - S * 0.62 - row * S * 0.2, side: "center" as const };
  }
  const side = pt.x < 0.5 ? ("left" as const) : ("right" as const);
  const sameSide = Math.max(1, Math.ceil(n / 2));
  const lx = side === "left" ? cx - S * 0.62 : cx + S * 0.62;
  const ly = cy - S * 0.38 + ((Math.floor(i / 2) + 0.5) / sameSide) * S * 0.76 * (n > 2 ? 1 : 0) + (n <= 2 ? (pt.y - 0.5) * S * 0.6 : 0);
  return { lx, ly, side };
}

const PacketCard: React.FC<{ p: Palette; S: number; f: number }> = ({ p, S, f }) => {
  const r = S * 0.06;
  return (
    <svg width={S} height={S} viewBox="0 0 100 100">
      <rect x={2} y={4} width={96} height={92} rx={6} fill={p.surfaceHi} stroke={alpha(p.line, 0.9)} strokeWidth={1} />
      <rect x={2} y={4} width={96} height={30} rx={6} fill={p.primary} />
      <rect x={2} y={28} width={96} height={6} fill={p.primary} />
      <rect x={6} y={12} width={42} height={16} rx={3} fill={alpha(p.ink, 0.15)} />
      <rect x={52} y={12} width={42} height={16} rx={3} fill={alpha(p.ink, 0.15)} />
      <rect x={9} y={18} width={24} height={4} rx={2} fill={alpha(p.ink, 0.5)} />
      <rect x={55} y={18} width={30} height={4} rx={2} fill={alpha(p.ink, 0.5)} />
      <rect x={80} y={5} width={16} height={6} rx={3} fill={p.ink} />
      {Array.from({ length: 12 }).map((_, i) => (
        <rect key={i} x={8 + (i % 4) * 22} y={42 + Math.floor(i / 4) * 17} width={18} height={13} rx={2} fill={alpha(i % 3 ? p.cool : p.secondary, 0.35 + 0.25 * Math.sin(f / 12 + i) ** 2)} />
      ))}
      <rect x={2} y={4} width={96} height={92} rx={6} fill="none" stroke={alpha("#ffffff", 0.2)} strokeWidth={r * 0} />
    </svg>
  );
};
