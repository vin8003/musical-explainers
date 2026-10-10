// Scene systems built from cards and icons: title, flow, population,
// comparison, timeline, steps and character. Each lays itself out from the
// content box, so the same storyboard composes for 16:9 and 9:16.
import React from "react";
import { AbsoluteFill, interpolate, random } from "remotion";
import { Icon } from "../assets/icons";
import { IconNode } from "../components/IconNode";
import { Mascot } from "../components/Mascot";
import { accent, appear, travel } from "../components/motion";
import { Headline, Kicker, Label } from "../components/Text";
import { fitText } from "../layout";
import { alpha, theme } from "../theme";
import { beatF, ShotCtx, staggerOnBeats, useShotFrame } from "./context";

type VT<T extends string> = Extract<ShotCtx["shot"]["visual"], { type: T }>;

export const TitleShot: React.FC<{ ctx: ShotCtx }> = ({ ctx }) => {
  const v = ctx.shot.visual as VT<"title">;
  const f = useShotFrame(ctx);
  const { p, fmt, content: box } = ctx;
  const iconS = (fmt.vertical ? 420 : 380) * fmt.u;
  const rays = travel(f, -ctx.lead, ctx.dur);
  const iconK = appear(f, 0, 20, theme.easing.back);
  const textW = fmt.vertical ? box.w : box.w * 0.56;
  const ix = fmt.vertical ? box.x + box.w / 2 : box.x + box.w * 0.78;
  const iy = fmt.vertical ? box.y + box.h * 0.3 : box.y + box.h * 0.5;
  return (
    <AbsoluteFill>
      {v.icon ? (
        <>
          <svg width={fmt.w} height={fmt.h} style={{ position: "absolute", inset: 0 }}>
            {Array.from({ length: 14 }).map((_, i) => {
              const a = (i / 14) * Math.PI * 2 + rays * 0.6;
              const r1 = iconS * 0.55, r2 = iconS * (1.6 + 0.2 * Math.sin(i));
              return <path key={i} d={`M${ix + Math.cos(a - 0.06) * r1} ${iy + Math.sin(a - 0.06) * r1} L${ix + Math.cos(a) * r2} ${iy + Math.sin(a) * r2} L${ix + Math.cos(a + 0.06) * r1} ${iy + Math.sin(a + 0.06) * r1} Z`} fill={alpha(p.primary, 0.07 * iconK)} />;
            })}
          </svg>
          <div style={{ position: "absolute", left: ix - iconS / 2, top: iy - iconS / 2, transform: `scale(${iconK}) rotate(${(1 - iconK) * -12}deg) translateY(${Math.sin(f / 20) * 8 * fmt.u}px)` }}>
            <Icon id={v.icon} p={p} size={iconS} />
          </div>
        </>
      ) : null}
      <div style={{ position: "absolute", left: box.x, top: fmt.vertical ? box.y + box.h * 0.58 : box.y, width: textW, height: fmt.vertical ? box.h * 0.42 : box.h, display: "flex", flexDirection: "column", justifyContent: "center", gap: 18 * fmt.u, alignItems: fmt.vertical ? "center" : "flex-start", textAlign: fmt.vertical ? "center" : "left" }}>
        {v.kicker ? <Kicker text={v.kicker} p={p} fmt={fmt} f={f} /> : null}
        <Headline text={v.title} f={f - 4} p={p} fmt={fmt} width={textW} align={fmt.vertical ? "center" : "left"} maxSize={(fmt.vertical ? 120 : 112) * fmt.u} />
        {v.subtitle ? <div style={{ fontFamily: theme.font.body, fontWeight: 600, fontSize: (fmt.vertical ? 44 : 40) * fmt.u, color: p.textMuted, opacity: appear(f, ctx.fpb * 2, 14) }}>{v.subtitle}</div> : null}
      </div>
    </AbsoluteFill>
  );
};

export const FlowShot: React.FC<{ ctx: ShotCtx }> = ({ ctx }) => {
  const v = ctx.shot.visual as VT<"flow">;
  const f = useShotFrame(ctx);
  const { p, fmt, content: box } = ctx;
  const node = (fmt.vertical ? 150 : 140) * fmt.u;
  const machine = node * 1.9;
  const axis = (t: number, k: number, n: number) => {
    // t: 0 inputs, 0.5 machine, 1 outputs. k-th of n items spread across the cross axis.
    const cross = n === 1 ? 0.5 : 0.2 + (0.6 * k) / (n - 1);
    return fmt.vertical ? { x: box.x + box.w * cross, y: box.y + box.h * (0.12 + t * 0.76) } : { x: box.x + box.w * (0.1 + t * 0.8), y: box.y + box.h * cross };
  };
  const m = axis(0.5, 0, 1);
  const inAt = beatF(ctx, 0.5), mAt = beatF(ctx, 1.5), outAt = beatF(ctx, 4);
  const spin = interpolate(f, [mAt, ctx.dur], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const particles = Array.from({ length: 10 }).map((_, i) => {
    const phase = ((f - mAt) / (ctx.fpb * 2) + i / 10) % 1;
    const src = v.inputs[i % v.inputs.length];
    const from = axis(0, i % v.inputs.length, v.inputs.length);
    const to = phase < 0.5 ? m : axis(1, i % v.outputs.length, v.outputs.length);
    const start = phase < 0.5 ? from : m;
    const t = phase < 0.5 ? phase * 2 : (phase - 0.5) * 2;
    return { x: start.x + (to.x - start.x) * t, y: start.y + (to.y - start.y) * t, icon: phase < 0.5 ? src.icon : v.outputs[i % v.outputs.length].icon, on: f > mAt + (i * ctx.fpb) / 5 };
  });
  return (
    <AbsoluteFill>
      <svg width={fmt.w} height={fmt.h} style={{ position: "absolute", inset: 0 }}>
        {[...v.inputs.map((_, i) => axis(0, i, v.inputs.length)), ...v.outputs.map((_, i) => axis(1, i, v.outputs.length))].map((pt, i) => (
          <line key={i} x1={pt.x} y1={pt.y} x2={m.x} y2={m.y} stroke={alpha(p.line, 0.6)} strokeWidth={6 * fmt.u} strokeDasharray={`${14 * fmt.u} ${10 * fmt.u}`} strokeDashoffset={-f * 2} opacity={appear(f, mAt, 12)} />
        ))}
      </svg>
      {particles.map((q, i) => (q.on ? <div key={i} style={{ position: "absolute", left: q.x - node * 0.2, top: q.y - node * 0.2 }}><Icon id={q.icon} p={p} size={node * 0.4} /></div> : null))}
      {v.inputs.map((x, i) => { const pt = axis(0, i, v.inputs.length); return <IconNode key={`i${i}`} icon={x.icon} label={x.label} p={p} fmt={fmt} x={pt.x} y={pt.y} size={node} k={appear(f, inAt + i * 4, 14)} />; })}
      {v.outputs.map((x, i) => { const pt = axis(1, i, v.outputs.length); return <IconNode key={`o${i}`} icon={x.icon} label={x.label} p={p} fmt={fmt} x={pt.x} y={pt.y} size={node} k={appear(f, outAt + i * 4, 14)} hot={accent(f, outAt + i * 4, 18)} />; })}
      <div style={{ position: "absolute", left: m.x - machine / 2, top: m.y - machine / 2, width: machine, height: machine, transform: `scale(${appear(f, mAt, 16, theme.easing.back)})` }}>
        <div style={{ position: "absolute", inset: -machine * 0.12, borderRadius: "50%", border: `${5 * fmt.u}px dashed ${alpha(p.primary, 0.6)}`, transform: `rotate(${spin * 360}deg)` }} />
        <Icon id={v.machine.icon} p={p} size={machine} />
        {v.machine.label ? <div style={{ position: "absolute", left: "50%", top: machine * 1.1, transform: "translateX(-50%)" }}><Label text={v.machine.label} p={p} fmt={fmt} size={30} tone="accent" /></div> : null}
      </div>
    </AbsoluteFill>
  );
};

export const PopulationShot: React.FC<{ ctx: ShotCtx }> = ({ ctx }) => {
  const v = ctx.shot.visual as VT<"population">;
  const f = useShotFrame(ctx);
  const { p, fmt, content: box } = ctx;
  const n = v.groups.length;
  const colW = fmt.vertical ? box.w : box.w / n;
  const colH = fmt.vertical ? box.h / n : box.h;
  return (
    <AbsoluteFill>
      {v.groups.map((g, gi) => {
        const gx = fmt.vertical ? box.x : box.x + gi * colW;
        const gy = fmt.vertical ? box.y + gi * colH : box.y;
        const areaW = colW * 0.86, areaH = colH * (fmt.vertical ? 0.62 : 0.66);
        const ax = gx + (colW - areaW) / 2, ay = gy + colH * 0.06;
        const start = beatF(ctx, 1 + gi * 2);
        const cols = Math.ceil(Math.sqrt((g.count * areaW) / areaH));
        const rows = Math.ceil(g.count / cols);
        const cell = Math.min(areaW / cols, areaH / rows);
        const shown = Math.floor(interpolate(f, [start, start + ctx.fpb * 2.5], [0, g.count], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: theme.easing.out }));
        return (
          <div key={gi}>
            <div style={{ position: "absolute", left: ax - 12 * fmt.u, top: ay - 12 * fmt.u, width: areaW + 24 * fmt.u, height: areaH + 24 * fmt.u, borderRadius: 40 * fmt.u, background: alpha(p.surface, 0.55), border: `${3 * fmt.u}px solid ${alpha(p.line, 0.6)}`, opacity: appear(f, start - 6, 12) }} />
            {Array.from({ length: g.count }).map((_, i) => {
              const c = i % cols, r = Math.floor(i / cols);
              const jx = (random(`${ctx.seed}-${gi}-${i}x`) - 0.5) * cell * 0.25, jy = (random(`${ctx.seed}-${gi}-${i}y`) - 0.5) * cell * 0.25;
              const k = i < shown ? 1 : 0;
              return k ? <div key={i} style={{ position: "absolute", left: ax + c * cell + (areaW - cols * cell) / 2 + jx, top: ay + r * cell + (areaH - rows * cell) / 2 + jy, transform: `rotate(${(random(`${ctx.seed}-${gi}-${i}r`) - 0.5) * 50}deg)` }}><Icon id={g.icon} p={p} size={cell * 0.85} /></div> : null;
            })}
            <div style={{ position: "absolute", left: gx, width: colW, top: ay + areaH + 30 * fmt.u, textAlign: "center", opacity: appear(f, start, 12) }}>
              <div style={{ fontFamily: theme.font.display, fontWeight: 800, fontSize: (fmt.vertical ? 64 : 72) * fmt.u, color: p.primary, lineHeight: 1 }}>{g.value ?? shown}</div>
              <div style={{ fontFamily: theme.font.body, fontWeight: 700, fontSize: 34 * fmt.u, color: p.text, marginTop: 8 * fmt.u }}>{g.label}</div>
            </div>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

export const ComparisonShot: React.FC<{ ctx: ShotCtx }> = ({ ctx }) => {
  const v = ctx.shot.visual as VT<"comparison">;
  const f = useShotFrame(ctx);
  const { p, fmt, content: box } = ctx;
  const sides = [v.left, v.right];
  const gap = 40 * fmt.u;
  const w = fmt.vertical ? box.w : (box.w - gap) / 2;
  const h = fmt.vertical ? (box.h - gap) / 2 : box.h;
  return (
    <AbsoluteFill>
      {sides.map((s, i) => {
        const x = fmt.vertical ? box.x : box.x + i * (w + gap);
        const y = fmt.vertical ? box.y + i * (h + gap) : box.y;
        const at = beatF(ctx, 0.5 + i * 2);
        const k = appear(f, at, 16);
        const fit = fitText(s.title, w * 0.8, { maxSize: 64 * fmt.u, minSize: 40 * fmt.u, maxLines: 2 });
        return (
          <div key={i} style={{ position: "absolute", left: x, top: y, width: w, height: h, borderRadius: theme.radius.lg * fmt.u, background: `linear-gradient(160deg, ${alpha(p.surfaceHi, 0.95)}, ${alpha(p.surface, 0.9)})`, border: `${3 * fmt.u}px solid ${alpha(i ? p.accent : p.secondary, 0.7)}`, opacity: k, transform: `translateY(${(1 - k) * 40 * fmt.u}px)`, padding: 40 * fmt.u, boxSizing: "border-box", display: "flex", flexDirection: fmt.vertical ? "row" : "column", gap: 28 * fmt.u, alignItems: fmt.vertical ? "center" : "flex-start" }}>
            {s.icon ? <Icon id={s.icon} p={p} size={(fmt.vertical ? 200 : 170) * fmt.u} /> : null}
            <div>
              <div style={{ fontFamily: theme.font.display, fontWeight: 800, fontSize: fit.size, color: i ? p.accent : p.secondary, lineHeight: 1.1 }}>{fit.lines.join(" ")}</div>
              {(s.points ?? []).map((pt, j) => (
                <div key={j} style={{ fontFamily: theme.font.body, fontWeight: 600, fontSize: 34 * fmt.u, color: p.text, marginTop: 14 * fmt.u, opacity: appear(f, at + ctx.fpb * (1 + j), 12) }}>• {pt}</div>
              ))}
            </div>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

export const TimelineShot: React.FC<{ ctx: ShotCtx }> = ({ ctx }) => {
  const v = ctx.shot.visual as VT<"timeline">;
  const f = useShotFrame(ctx);
  const { p, fmt, content: box } = ctx;
  const n = v.events.length;
  const draw = travel(f, beatF(ctx, 0.5), beatF(ctx, 0.5 + n * 1.5));
  const pt = (i: number) => (fmt.vertical ? { x: box.x + box.w * 0.18, y: box.y + box.h * (0.08 + (0.84 * i) / (n - 1)) } : { x: box.x + box.w * (0.08 + (0.84 * i) / (n - 1)), y: box.y + box.h * 0.5 });
  const a = pt(0), b = pt(n - 1);
  return (
    <AbsoluteFill>
      <svg width={fmt.w} height={fmt.h} style={{ position: "absolute", inset: 0 }}>
        <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={alpha(p.line, 0.5)} strokeWidth={10 * fmt.u} strokeLinecap="round" />
        <line x1={a.x} y1={a.y} x2={a.x + (b.x - a.x) * draw} y2={a.y + (b.y - a.y) * draw} stroke={p.primary} strokeWidth={10 * fmt.u} strokeLinecap="round" />
      </svg>
      {v.events.map((e, i) => {
        const q = pt(i);
        const k = appear(f, beatF(ctx, 0.5 + i * 1.5), 14);
        const up = i % 2 === 0;
        return (
          <div key={i}>
            <div style={{ position: "absolute", left: q.x - 22 * fmt.u, top: q.y - 22 * fmt.u, width: 44 * fmt.u, height: 44 * fmt.u, borderRadius: "50%", background: p.primary, border: `${6 * fmt.u}px solid ${p.ink}`, transform: `scale(${k})`, boxSizing: "border-box" }} />
            <div style={{ position: "absolute", left: fmt.vertical ? q.x + 60 * fmt.u : q.x, top: fmt.vertical ? q.y : up ? q.y - 60 * fmt.u : q.y + 60 * fmt.u, transform: fmt.vertical ? "translateY(-50%)" : `translate(-50%, ${up ? "-100%" : "0"})`, textAlign: fmt.vertical ? "left" : "center", opacity: k, width: fmt.vertical ? box.w * 0.7 : (box.w / n) * 0.95 }}>
              {e.icon ? <div style={{ display: "flex", justifyContent: fmt.vertical ? "flex-start" : "center" }}><Icon id={e.icon} p={p} size={110 * fmt.u} /></div> : null}
              <div style={{ fontFamily: theme.font.display, fontWeight: 800, fontSize: 44 * fmt.u, color: p.primary }}>{e.when}</div>
              <div style={{ fontFamily: theme.font.body, fontWeight: 600, fontSize: 32 * fmt.u, color: p.text, lineHeight: 1.2 }}>{e.label}</div>
            </div>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

export const StepsShot: React.FC<{ ctx: ShotCtx }> = ({ ctx }) => {
  const v = ctx.shot.visual as VT<"steps">;
  const f = useShotFrame(ctx);
  const { p, fmt, content: box } = ctx;
  const n = v.steps.length;
  const at = staggerOnBeats(ctx, n, 0.45, 0.5);
  const size = (fmt.vertical ? 150 : 170) * fmt.u * (n > 4 ? 0.85 : 1);
  const pos = (i: number) => (fmt.vertical ? { x: box.x + box.w * 0.22, y: box.y + box.h * ((i + 0.5) / n) } : { x: box.x + box.w * ((i + 0.5) / n), y: box.y + box.h * 0.42 });
  const active = at.reduce((acc, a, i) => (f >= a ? i : acc), -1);
  return (
    <AbsoluteFill>
      <svg width={fmt.w} height={fmt.h} style={{ position: "absolute", inset: 0 }}>
        {v.steps.slice(1).map((_, i) => {
          const a = pos(i), b = pos(i + 1);
          const k = travel(f, at[i + 1] - 8, at[i + 1]);
          return <line key={i} x1={a.x} y1={a.y} x2={a.x + (b.x - a.x) * k} y2={a.y + (b.y - a.y) * k} stroke={p.primary} strokeWidth={6 * fmt.u} strokeDasharray={`${4 * fmt.u} ${14 * fmt.u}`} strokeLinecap="round" />;
        })}
      </svg>
      {v.steps.map((s, i) => {
        const q = pos(i);
        const k = appear(f, at[i], 14, theme.easing.back);
        return (
          <div key={i}>
            <IconNode icon={s.icon} p={p} fmt={fmt} x={q.x} y={q.y} size={size} k={k} hot={i === active ? 0.8 : accent(f, at[i], 16)} />
            <div style={{ position: "absolute", left: q.x - size * 0.62, top: q.y - size * 0.62, width: 56 * fmt.u, height: 56 * fmt.u, borderRadius: "50%", background: p.primary, color: p.ink, fontFamily: theme.font.display, fontWeight: 800, fontSize: 32 * fmt.u, display: "flex", alignItems: "center", justifyContent: "center", transform: `scale(${k})` }}>{i + 1}</div>
            <div style={{ position: "absolute", left: fmt.vertical ? q.x + size * 0.8 : q.x, top: fmt.vertical ? q.y : q.y + size * 0.8, transform: fmt.vertical ? "translateY(-50%)" : "translateX(-50%)", width: fmt.vertical ? box.w * 0.6 : (box.w / n) * 0.92, textAlign: fmt.vertical ? "left" : "center", fontFamily: theme.font.display, fontWeight: 800, fontSize: (fmt.vertical ? 52 : 46) * fmt.u, color: i === active ? p.primary : p.text, opacity: appear(f, at[i] + 4, 12) }}>
              {s.label}
            </div>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

export const CharacterShot: React.FC<{ ctx: ShotCtx }> = ({ ctx }) => {
  const v = ctx.shot.visual as VT<"character">;
  const f = useShotFrame(ctx);
  const { p, fmt, content: box, timed } = ctx;
  const size = (fmt.vertical ? 460 : 420) * fmt.u;
  const mx = fmt.vertical ? box.x + box.w * 0.5 : box.x + box.w * 0.2;
  const my = fmt.vertical ? box.y + box.h * 0.72 : box.y + box.h * 0.62;
  const talking = timed.narration ? f >= timed.narration.startFrame - timed.startFrame && f < timed.narration.startFrame - timed.startFrame + timed.narration.durationFrames : false;
  const k = appear(f, 0, 16, theme.easing.back);
  const bk = appear(f, ctx.fpb, 14);
  const bw = fmt.vertical ? box.w * 0.92 : box.w * 0.56;
  const fit = fitText(v.say, bw * 0.86, { maxSize: 64 * fmt.u, minSize: 40 * fmt.u, maxLines: 4, weight: "bold" });
  return (
    <AbsoluteFill>
      <div style={{ position: "absolute", left: mx - size / 2, top: my - size / 2, transform: `scale(${k})` }}>
        <Mascot p={p} size={size} mood={ctx.shot.mascot?.mood ?? "pointing"} talking={talking} />
      </div>
      {v.prop ? (
        <div style={{ position: "absolute", left: mx + size * 0.32, top: my - size * 0.72, transform: `rotate(${Math.sin(f / 15) * 6}deg) scale(${appear(f, ctx.fpb * 0.5, 14, theme.easing.back)})` }}>
          <Icon id={v.prop} p={p} size={size * 0.42} />
        </div>
      ) : null}
      <div style={{ position: "absolute", left: fmt.vertical ? box.x + (box.w - bw) / 2 : box.x + box.w * 0.42, top: fmt.vertical ? box.y + box.h * 0.04 : box.y + box.h * 0.12, width: bw, padding: 44 * fmt.u, boxSizing: "border-box", borderRadius: 48 * fmt.u, background: "#ffffff", color: p.ink, fontFamily: theme.font.body, fontWeight: 700, fontSize: fit.size, lineHeight: 1.22, opacity: bk, transform: `scale(${0.85 + 0.15 * bk})`, transformOrigin: fmt.vertical ? "50% 100%" : "0% 80%", boxShadow: `0 ${20 * fmt.u}px ${50 * fmt.u}px ${alpha("#000", 0.35)}` }}>
        {fit.lines.join(" ")}
      </div>
    </AbsoluteFill>
  );
};
