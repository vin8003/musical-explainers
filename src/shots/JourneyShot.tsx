// Side-scrolling trip through environments (home -> city -> coast -> ocean
// floor -> data centre...). The world scrolls under a traveller that follows a
// glowing cable through a cut-away of the ground and sea, with parallax layers
// for depth. Stops pause briefly on the beat so each label can be read.
import React from "react";
import { AbsoluteFill, interpolate, random } from "remotion";
import { Icon } from "../assets/icons";
import { appear } from "../components/motion";
import { Label } from "../components/Text";
import type { JourneyScene } from "../schema/storyboard.mjs";
import { alpha, theme } from "../theme";
import { ShotCtx, useShotFrame } from "./context";

type V = Extract<ShotCtx["shot"]["visual"], { type: "journey" }>;

const WATER: JourneyScene[] = ["ocean", "seafloor"];

export const JourneyShot: React.FC<{ ctx: ShotCtx }> = ({ ctx }) => {
  const v = ctx.shot.visual as V;
  const f = useShotFrame(ctx);
  const { p, fmt } = ctx;
  const W = fmt.w, H = fmt.h;
  const PW = W * (fmt.vertical ? 1.1 : 0.72);
  const n = v.stops.length;
  const groundY = H * (fmt.vertical ? 0.5 : 0.56);
  const seabedY = H * (fmt.vertical ? 0.74 : 0.86);
  const landCable = groundY + H * 0.06;

  // Camera: ease from stop to stop, holding a beat on each.
  const travelFrames = ctx.dur - ctx.fpb * 2;
  const seg = travelFrames / Math.max(1, n - 1);
  const pos = (() => {
    const t = Math.max(0, f - ctx.fpb) / seg;
    const i = Math.min(n - 1, Math.floor(t));
    const local = Math.min(1, (t - i) * 1.35);
    const e = theme.easing.inOut(Math.max(0, Math.min(1, local)));
    return Math.min(n - 1, i + e);
  })();
  const centerX = (i: number) => i * PW + PW / 2;
  const worldX = centerX(0) + pos * PW;
  const camX = worldX - W / 2;
  const sceneAt = (x: number) => v.stops[Math.max(0, Math.min(n - 1, Math.floor(x / PW)))].scene;
  const cableY = (x: number) => {
    // Blend between neighbouring panels across the middle 40% of each boundary.
    const depth = (s: JourneyScene) => (WATER.includes(s) ? seabedY - 12 * fmt.u : s === "space" ? groundY - H * 0.32 : landCable);
    const i = Math.floor(x / PW);
    const local = x / PW - i;
    const a = depth(sceneAt(x));
    if (local > 0.7 && i < n - 1) return interpolate(local, [0.7, 1], [a, depth(v.stops[i + 1].scene)], { easing: theme.easing.inOut });
    if (local < 0.3 && i > 0) return interpolate(local, [0, 0.3], [(a + depth(v.stops[i - 1].scene)) / 2, a], { easing: theme.easing.out });
    return a;
  };
  const cablePts: string[] = [];
  for (let x = Math.max(0, camX - 40); x <= Math.min(n * PW, camX + W + 40); x += 12) cablePts.push(`${cablePts.length ? "L" : "M"}${x - camX} ${cableY(x)}`);
  const trail: string[] = [];
  for (let x = Math.max(0, worldX - W * 0.35); x <= worldX; x += 8) trail.push(`${trail.length ? "L" : "M"}${x - camX} ${cableY(x)}`);
  const tY = cableY(worldX);
  const travellerSize = (fmt.vertical ? 130 : 110) * fmt.u;

  return (
    <AbsoluteFill>
      <svg width={W} height={H} style={{ position: "absolute", inset: 0 }}>
        {/* far parallax: hills / skyline silhouettes */}
        <g transform={`translate(${-camX * 0.35} 0)`}>
          {Array.from({ length: Math.ceil((n * PW) / 160) + 6 }).map((_, i) => {
            const h = 40 + random(`${ctx.seed}-far-${i}`) * 90;
            return <rect key={i} x={i * 160 - 200} y={groundY - h * fmt.u} width={150} height={h * fmt.u} rx={30} fill={alpha(p.line, 0.18)} />;
          })}
        </g>
        {v.stops.map((s, i) => (
          <g key={i} transform={`translate(${i * PW - camX} 0)`}>
            <Panel scene={s.scene} p={p} PW={PW} H={H} groundY={groundY} seabedY={seabedY} u={fmt.u} seed={`${ctx.seed}-${i}`} f={f} />
          </g>
        ))}
        <path d={cablePts.join(" ")} stroke={alpha(p.ink, 0.6)} strokeWidth={14 * fmt.u} fill="none" strokeLinecap="round" />
        <path d={cablePts.join(" ")} stroke={alpha(p.accent, 0.5)} strokeWidth={5 * fmt.u} fill="none" strokeLinecap="round" />
        <path d={trail.join(" ")} stroke={p.primary} strokeWidth={8 * fmt.u} fill="none" strokeLinecap="round" opacity={0.9} />
      </svg>
      <div style={{ position: "absolute", left: W / 2, top: tY, transform: "translate(-50%, -50%)" }}>
        <div style={{ position: "absolute", left: "50%", top: "50%", width: travellerSize * 2, height: travellerSize * 2, transform: "translate(-50%,-50%)", background: `radial-gradient(circle, ${alpha(p.primary, 0.5)} 0%, transparent 65%)` }} />
        <Icon id={v.traveller.icon} p={p} size={travellerSize} style={{ position: "relative" }} />
      </div>
      {v.stops.map((s, i) => {
        const near = 1 - Math.min(1, Math.abs(pos - i) * 1.6);
        const x = centerX(i) - camX;
        return near > 0.01 ? (
          <div key={i} style={{ position: "absolute", left: x, top: fmt.safe.y + (fmt.vertical ? 120 : 30) * fmt.u, transform: "translateX(-50%)" }}>
            <Label text={s.label} p={p} fmt={fmt} k={near} size={34} tone="light" />
          </div>
        ) : null;
      })}
      {v.stat ? (
        <div style={{ position: "absolute", right: fmt.w - fmt.safe.x - fmt.safe.w, top: fmt.safe.y + (fmt.vertical ? 260 : 20) * fmt.u, textAlign: "right", opacity: appear(f, ctx.fpb * 2, 14) }}>
          <div style={{ fontFamily: theme.font.body, fontWeight: 700, fontSize: 26 * fmt.u, color: p.textMuted, textTransform: "uppercase", letterSpacing: 3 * fmt.u }}>{v.stat.label}</div>
          <div style={{ fontFamily: theme.font.display, fontWeight: 800, fontSize: 64 * fmt.u, color: p.primary }}>{v.stat.value}</div>
        </div>
      ) : null}
    </AbsoluteFill>
  );
};

const Panel: React.FC<{ scene: JourneyScene; p: ShotCtx["p"]; PW: number; H: number; groundY: number; seabedY: number; u: number; seed: string; f: number }> = ({ scene, p, PW, H, groundY, seabedY, u, seed, f }) => {
  const water = WATER.includes(scene);
  const earth = (
    <>
      <rect x={-1} y={groundY} width={PW + 2} height={H - groundY} fill="#1C1630" />
      <rect x={-1} y={groundY} width={PW + 2} height={10 * u} fill={scene === "coast" ? "#E8C98A" : "#3F7A4A"} />
      {Array.from({ length: 8 }).map((_, i) => (
        <circle key={i} cx={random(`${seed}-r${i}`) * PW} cy={groundY + 60 * u + random(`${seed}-q${i}`) * (H - groundY - 80 * u)} r={(4 + random(`${seed}-s${i}`) * 8) * u} fill={alpha("#ffffff", 0.05)} />
      ))}
    </>
  );
  const sea = (
    <>
      <rect x={-1} y={groundY} width={PW + 2} height={H - groundY} fill={alpha(p.cool, 0.28)} />
      <rect x={-1} y={groundY + (seabedY - groundY) * 0.4} width={PW + 2} height={H} fill={alpha("#020414", 0.35)} />
      <path d={`M0 ${groundY} ${Array.from({ length: 13 }).map((_, i) => `Q ${i * (PW / 12) + PW / 24} ${groundY + Math.sin(f / 10 + i) * 6 * u - 6 * u} ${(i + 1) * (PW / 12)} ${groundY}`).join(" ")}`} stroke={alpha("#ffffff", 0.5)} strokeWidth={3 * u} fill="none" />
      <rect x={-1} y={seabedY} width={PW + 2} height={H - seabedY} fill="#2A2238" />
    </>
  );
  return (
    <g>
      {water ? sea : earth}
      {scene === "home" ? (
        <foreignObject x={PW * 0.3} y={groundY - 220 * u} width={220 * u} height={220 * u}><Icon id="house" p={p} size={220 * u} /></foreignObject>
      ) : null}
      {scene === "city"
        ? [0, 1, 2, 3].map((i) => (
            <foreignObject key={i} x={PW * 0.08 + i * PW * 0.22} y={groundY - (190 + (i % 2) * 60) * u} width={170 * u} height={(190 + (i % 2) * 60) * u}>
              <Icon id="building" p={p} size={(190 + (i % 2) * 60) * u} />
            </foreignObject>
          ))
        : null}
      {scene === "datacenter"
        ? [0, 1, 2].map((i) => (
            <foreignObject key={i} x={PW * 0.15 + i * PW * 0.24} y={groundY - 170 * u} width={170 * u} height={170 * u}><Icon id="server" p={p} size={170 * u} /></foreignObject>
          ))
        : null}
      {scene === "coast" ? (
        <>
          <path d={`M${PW * 0.55} ${groundY} Q ${PW * 0.8} ${groundY + 20 * u} ${PW} ${seabedY - 40 * u} L ${PW} ${H} L ${PW * 0.55} ${H} Z`} fill={alpha(p.cool, 0.25)} />
          <rect x={PW * 0.18} y={groundY - 90 * u} width={130 * u} height={90 * u} rx={10 * u} fill="#D9DCEB" />
          <rect x={PW * 0.18} y={groundY - 90 * u} width={130 * u} height={20 * u} rx={10 * u} fill={p.secondary} />
        </>
      ) : null}
      {scene === "ocean" ? (
        <foreignObject x={PW * 0.35} y={groundY - 110 * u} width={200 * u} height={130 * u}><Icon id="ship" p={p} size={200 * u} /></foreignObject>
      ) : null}
      {water
        ? [0, 1, 2].map((i) => (
            <foreignObject key={i} x={((random(`${seed}-fx${i}`) * PW + f * (1.5 + i)) % PW)} y={groundY + (seabedY - groundY) * (0.3 + 0.2 * i)} width={70 * u} height={70 * u}>
              <Icon id="fish" p={p} size={(50 + i * 10) * u} />
            </foreignObject>
          ))
        : null}
      {scene === "space"
        ? Array.from({ length: 30 }).map((_, i) => <circle key={i} cx={random(`${seed}-x${i}`) * PW} cy={random(`${seed}-y${i}`) * groundY} r={(1 + random(`${seed}-z${i}`) * 2.5) * u} fill="#ffffff" opacity={0.8} />)
        : null}
      {scene === "cell" ? <ellipse cx={PW / 2} cy={groundY + 60 * u} rx={PW * 0.45} ry={H * 0.3} fill={alpha(p.secondary, 0.15)} stroke={alpha(p.secondary, 0.6)} strokeWidth={6 * u} /> : null}
    </g>
  );
};
