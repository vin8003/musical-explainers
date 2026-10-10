// A file literally cut into pieces: each packet carries a slice of the source
// picture plus a numbered header. "reassemble" plays it backwards with packets
// arriving out of order and dropping into their numbered slots.
import React from "react";
import { AbsoluteFill, random } from "remotion";
import { Icon } from "../assets/icons";
import { appear, lerp, travel } from "../components/motion";
import { Label } from "../components/Text";
import { alpha, theme } from "../theme";
import { beatF, ShotCtx, useShotFrame } from "./context";

type V = Extract<ShotCtx["shot"]["visual"], { type: "packetize" }>;

export const PacketizeShot: React.FC<{ ctx: ShotCtx }> = ({ ctx }) => {
  const v = ctx.shot.visual as V;
  const f = useShotFrame(ctx);
  const { p, fmt, content: box } = ctx;
  const n = Math.round(v.count);
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const S = Math.min(fmt.vertical ? box.w * 0.62 : box.h * 0.62, fmt.vertical ? box.h * 0.36 : box.w * 0.34);
  const th = S / rows;
  // The last row stretches its tiles so the picture is always complete.
  const inRow = (r: number) => Math.min(cols, n - r * cols);
  const tileW = (i: number) => S / inRow(Math.floor(i / cols));
  const tw = S / cols;
  // Whole picture position, and where the separated packets spread out.
  const whole = fmt.vertical ? { x: box.x + box.w / 2 - S / 2, y: box.y + box.h * 0.04 } : { x: box.x + box.w * 0.04, y: box.y + box.h / 2 - S / 2 };
  const spreadArea = fmt.vertical
    ? { x: box.x, y: box.y + box.h * 0.48, w: box.w, h: box.h * 0.5 }
    : { x: box.x + box.w * 0.44, y: box.y + box.h * 0.06, w: box.w * 0.56, h: box.h * 0.88 };
  const scols = fmt.vertical ? Math.min(4, n) : Math.min(4, Math.ceil(n / 2));
  const srows = Math.ceil(n / scols);
  const cellW = spreadArea.w / scols, cellH = spreadArea.h / srows;
  const tileScale = Math.min(1.25, (cellW * 0.78) / tw, (cellH * 0.62) / th);

  const split = v.mode === "split";
  // Out-of-order arrival for reassembly, deterministic per shot.
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => random(`${ctx.seed}-o-${a}`) - random(`${ctx.seed}-o-${b}`));
  const moveStart = beatF(ctx, split ? 2 : 1);
  const stagger = Math.max(3, Math.round((ctx.fpb * (split ? 4 : 6)) / n));
  const allIn = moveStart + stagger * (n - 1) + ctx.fpb * 2;

  const tiles = Array.from({ length: n }, (_, i) => {
    const c = i % cols, r = Math.floor(i / cols);
    const w = tileW(i);
    const home = { x: whole.x + c * w, y: whole.y + r * th };
    const sc = i % scols, sr = Math.floor(i / scols);
    const spread = { x: spreadArea.x + sc * cellW + cellW / 2 - (tw * tileScale) / 2, y: spreadArea.y + sr * cellH + cellH / 2 - (th * tileScale) / 2 };
    const rank = split ? i : order.indexOf(i);
    const t = travel(f, moveStart + rank * stagger, moveStart + rank * stagger + ctx.fpb * 1.6);
    const crack = split ? appear(f, beatF(ctx, 1), 10) : 0;
    const [from, to, fromS, toS] = split ? [home, spread, 1, tileScale] : [spread, home, tileScale, 1];
    const x = lerp(from.x, to.x, t) + (split ? (c - (cols - 1) / 2) * crack * 8 * fmt.u * (1 - t) : 0);
    const y = lerp(from.y, to.y, t) - Math.sin(t * Math.PI) * 40 * fmt.u;
    const s = lerp(fromS, toS, t);
    const rot = Math.sin(t * Math.PI) * (random(`${ctx.seed}-r-${i}`) - 0.5) * 24;
    const k = split ? 1 : appear(f, moveStart + rank * stagger - ctx.fpb, ctx.fpb);
    return { i, c, r, w, x, y, s, rot, t, k, tagK: split ? appear(f, moveStart + rank * stagger + ctx.fpb, 10) : 1 - t };
  });
  const done = !split && f > allIn;
  const doneK = appear(f, allIn, 14);
  // Once rebuilt, the finished picture moves to the centre so the frame isn't lopsided.
  const centerK = split ? 0 : appear(f, allIn + ctx.fpb, 24);
  const dx = (box.x + box.w / 2 - (whole.x + S / 2)) * centerK, dy = (box.y + box.h / 2 - (whole.y + S / 2)) * centerK;
  const label = (i: number) => (v.packetLabel === "none" ? null : v.packetLabel === "address" ? `→ ${v.destination?.label ?? "you"}` : `#${i + 1}`);

  return (
    <AbsoluteFill style={{ transform: `translate(${dx}px, ${dy}px) scale(${1 + 0.12 * centerK})`, transformOrigin: `${whole.x + S / 2}px ${whole.y + S / 2}px` }}>
      {/* Slots / outline of the whole picture */}
      <div style={{ position: "absolute", left: whole.x - 14 * fmt.u, top: whole.y - 14 * fmt.u, width: S + 28 * fmt.u, height: S + 28 * fmt.u, borderRadius: theme.radius.md * fmt.u, border: `${3 * fmt.u}px dashed ${alpha(p.line, split ? 0.5 * appear(f, moveStart, 20) : 0.7)}`, boxShadow: done ? `0 0 ${60 * fmt.u * doneK}px ${alpha(p.accent, 0.5)}` : "none" }} />
      {split ? (
        <div style={{ position: "absolute", left: whole.x, top: whole.y, width: S, height: S, opacity: 0.18 * appear(f, moveStart, 20), filter: "grayscale(1)" }}>
          <SourceCard icon={v.source.icon} p={p} S={S} />
        </div>
      ) : null}
      {!split
        ? Array.from({ length: n }, (_, i) => (
            <div key={i} style={{ position: "absolute", left: whole.x + (i % cols) * tileW(i), top: whole.y + Math.floor(i / cols) * th, width: tileW(i), height: th, display: "flex", alignItems: "center", justifyContent: "center", color: alpha(p.textMuted, 0.6), fontFamily: theme.font.mono, fontWeight: 700, fontSize: Math.min(tw, th) * 0.22 }}>
              #{i + 1}
            </div>
          ))
        : null}
      {tiles.map((t) => (
        <div key={t.i} style={{ position: "absolute", left: t.x, top: t.y, width: t.w, height: th, transform: `scale(${t.s}) rotate(${t.rot}deg)`, transformOrigin: "0 0", opacity: t.k }}>
          <div style={{ position: "absolute", inset: 2 * fmt.u, overflow: "hidden", borderRadius: (split ? t.t : 1 - t.t) * 14 * fmt.u, background: alpha(p.surfaceHi, 0.9), boxShadow: `0 ${10 * fmt.u}px ${24 * fmt.u}px ${alpha("#000", 0.35 * Math.max(t.t, split ? 0 : 1 - t.t))}` }}>
            <div style={{ position: "absolute", left: -t.c * t.w, top: -t.r * th, width: S, height: S }}>
              <SourceCard icon={v.source.icon} p={p} S={S} />
            </div>
          </div>
          {label(t.i) ? (
            <div style={{ position: "absolute", left: "50%", top: -th * 0.12, transform: `translate(-50%, -100%) scale(${1 / Math.max(0.6, t.s)})`, transformOrigin: "50% 100%" }}>
              <Label text={label(t.i)!} p={p} fmt={fmt} k={t.tagK} size={24} tone="accent" mono />
            </div>
          ) : null}
        </div>
      ))}
      {v.source.label ? (
        <div style={{ position: "absolute", left: whole.x + S / 2, top: whole.y + S + 34 * fmt.u, transform: "translateX(-50%)" }}>
          <Label text={split ? v.source.label : v.destination?.label ?? v.source.label} p={p} fmt={fmt} k={appear(f, 4, 12)} size={30} />
        </div>
      ) : null}
      {done ? (
        <div style={{ position: "absolute", left: whole.x + S - 40 * fmt.u, top: whole.y - 40 * fmt.u, transform: `scale(${doneK})` }}>
          <Icon id="check" p={p} size={90 * fmt.u} />
        </div>
      ) : null}
    </AbsoluteFill>
  );
};

/** The whole "file" as a full-bleed picture, so every slice has visible content. */
const SourceCard: React.FC<{ icon: string; p: ShotCtx["p"]; S: number }> = ({ icon, p, S }) => (
  <div style={{ position: "absolute", inset: 0, borderRadius: theme.radius.md, background: `linear-gradient(135deg, ${p.secondary} 0%, ${p.warm} 55%, ${p.primary} 100%)`, overflow: "hidden" }}>
    <div style={{ position: "absolute", inset: 0, backgroundImage: `repeating-linear-gradient(45deg, ${alpha("#ffffff", 0.08)} 0 ${S / 16}px, transparent ${S / 16}px ${S / 8}px)` }} />
    <div style={{ position: "absolute", left: S * 0.1, top: S * 0.1 }}>
      <Icon id={icon} p={p} size={S * 0.8} />
    </div>
  </div>
);
