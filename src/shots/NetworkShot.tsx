// Process diagram: devices, routers and servers joined by links, with packets
// hopping along explicit routes. Vertical frames transpose the grid so a
// left-to-right chain reads top-to-bottom.
import React from "react";
import { AbsoluteFill } from "remotion";
import { Icon } from "../assets/icons";
import { IconNode } from "../components/IconNode";
import { accent, along, appear, travel } from "../components/motion";
import { Label } from "../components/Text";
import { alpha, colorOf } from "../theme";
import { beatF, ShotCtx, useShotFrame } from "./context";

type V = Extract<ShotCtx["shot"]["visual"], { type: "network" }>;

export const NetworkShot: React.FC<{ ctx: ShotCtx }> = ({ ctx }) => {
  const v = ctx.shot.visual as V;
  const f = useShotFrame(ctx);
  const { p, fmt, content: box } = ctx;
  const nodeSize = (fmt.vertical ? 150 : 128) * fmt.u * (v.nodes.length > 6 ? 0.85 : 1);
  const pad = nodeSize * 0.75;
  const pos = Object.fromEntries(
    v.nodes.map((n) => {
      const [gx, gy] = fmt.vertical ? [n.y, n.x] : [n.x, n.y];
      return [n.id, { x: box.x + pad + (gx / 100) * (box.w - pad * 2), y: box.y + pad * 0.8 + (gy / 100) * (box.h - pad * 1.9) }];
    })
  );
  const links = v.links ?? [];
  const nodeAt = (i: number) => beatF(ctx, 0) + i * Math.round(ctx.fpb / 2);
  const linkAt = (i: number) => nodeAt(v.nodes.length) + i * Math.round(ctx.fpb / 2);
  const packetsStart = linkAt(links.length) + ctx.fpb;

  // Packet positions and router arrivals.
  const arrivals: Record<string, number[]> = {};
  const packets = (v.packets ?? []).map((k, i) => {
    const per = (k.beatsPerHop ?? 2) * ctx.fpb;
    const start = k.startBeat != null ? beatF(ctx, k.startBeat) : packetsStart + i * ctx.fpb;
    const hops = k.route.length - 1;
    const t = Math.max(0, Math.min(hops, (f - start) / per));
    const hop = Math.min(hops - 1, Math.floor(t));
    const local = travel(t - hop, 0, 1);
    const a = pos[k.route[hop]], b = pos[k.route[hop + 1]];
    for (let h = 1; h <= hops; h++) (arrivals[k.route[h]] ??= []).push(start + h * per);
    return {
      k,
      x: a.x + (b.x - a.x) * local,
      y: a.y + (b.y - a.y) * local,
      visible: f >= start && f <= start + hops * per + ctx.fpb * 2,
      done: f >= start + hops * per,
      color: colorOf(p, k.color),
    };
  });

  return (
    <AbsoluteFill>
      <svg width={fmt.w} height={fmt.h} style={{ position: "absolute", inset: 0 }}>
        {links.map((l, i) => {
          const a = pos[l.from], b = pos[l.to];
          const k = travel(f, linkAt(i), linkAt(i) + ctx.fpb);
          const len = Math.hypot(b.x - a.x, b.y - a.y) * (l.style === "undersea" ? 1.4 : 1);
          const style = l.style ?? "cable";
          const d = style === "undersea" ? wavy(a, b, 18 * fmt.u) : `M${a.x} ${a.y} L${b.x} ${b.y}`;
          const common = { strokeDasharray: style === "wireless" || style === "dashed" ? `${10 * fmt.u} ${12 * fmt.u}` : `${len * 1.2} ${len * 1.2}`, strokeDashoffset: style === "wireless" || style === "dashed" ? -f * 1.5 : len * 1.2 * (1 - k), fill: "none", strokeLinecap: "round" as const };
          return (
            <g key={i} opacity={style === "wireless" || style === "dashed" ? k : 1}>
              <path d={d} stroke={alpha(style === "undersea" ? p.cool : p.line, 0.55)} strokeWidth={(style === "cable" || style === "undersea" ? 14 : 6) * fmt.u} {...common} />
              <path d={d} stroke={style === "undersea" ? p.cool : alpha(p.accent, 0.85)} strokeWidth={(style === "cable" || style === "undersea" ? 4 : 3) * fmt.u} {...common} />
            </g>
          );
        })}
      </svg>
      {v.nodes.map((n, i) => {
        const hits = arrivals[n.id] ?? [];
        const hot = Math.max((v.highlight ?? []).includes(n.id) ? 0.6 + 0.4 * Math.sin(f / 9) ** 2 : 0, ...hits.map((h) => accent(f, h, 14)));
        return <IconNode key={n.id} icon={n.icon} label={n.label} p={p} fmt={fmt} x={pos[n.id].x} y={pos[n.id].y} size={nodeSize} k={appear(f, nodeAt(i), 16)} hot={hot} />;
      })}
      {packets.map(({ k, x, y, visible, done, color }, i) =>
        visible ? (
          <div key={i} style={{ position: "absolute", left: x, top: y, transform: "translate(-50%, -50%)", opacity: done ? 0.9 : 1 }}>
            <div style={{ position: "absolute", left: "50%", top: "50%", width: nodeSize * 0.7, height: nodeSize * 0.7, transform: "translate(-50%,-50%)", borderRadius: "50%", background: `radial-gradient(circle, ${alpha(color, 0.55)} 0%, transparent 70%)` }} />
            <Icon id="packet" p={{ ...p, primary: color }} size={nodeSize * 0.42} style={{ position: "relative" }} />
            {k.label ? (
              <div style={{ position: "absolute", left: "50%", bottom: nodeSize * 0.45, transform: "translateX(-50%)" }}>
                <Label text={k.label} p={p} fmt={fmt} size={22} tone="accent" mono />
              </div>
            ) : null}
          </div>
        ) : null
      )}
    </AbsoluteFill>
  );
};

function wavy(a: { x: number; y: number }, b: { x: number; y: number }, amp: number) {
  const n = 24;
  const pts = Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n;
    const base = along([a, b], t);
    const nx = -(b.y - a.y), ny = b.x - a.x;
    const l = Math.hypot(nx, ny) || 1;
    const w = Math.sin(t * Math.PI * 4) * amp * Math.sin(t * Math.PI);
    return `${i ? "L" : "M"}${base.x + (nx / l) * w} ${base.y + (ny / l) * w}`;
  });
  return pts.join(" ");
}
