// Kinetic typography. Words land exactly when they are sung: the lyric
// timings come from the shared timeline, the same numbers the audio stage
// used to place the chant. Only chorus shots get the beat rings.
import React from "react";
import { AbsoluteFill, interpolate } from "remotion";
import { accent, appear } from "../components/motion";
import { fitText } from "../layout";
import { lyricWords } from "../schema/timeline.mjs";
import { alpha, theme } from "../theme";
import { ShotCtx, useShotFrame } from "./context";

type V = Extract<ShotCtx["shot"]["visual"], { type: "kinetic" }>;

export const KineticShot: React.FC<{ ctx: ShotCtx }> = ({ ctx }) => {
  const v = ctx.shot.visual as V;
  const f = useShotFrame(ctx);
  const { p, fmt, content: box, timed } = ctx;
  const text = (v.lines?.length ? v.lines.join(" / ") : ctx.shot.lyric ?? ctx.shot.headline ?? "").trim();
  const lines = v.lines?.length ? v.lines : splitLines(text, fmt.vertical ? 3 : 2);
  const words = lines.flatMap((l, li) => lyricWords(l).map((w) => ({ w, li })));
  // Word hit frames: sung timings if the lyric matches, otherwise every beat from beat 1.
  const sung = timed.lyric.length === words.length ? timed.lyric.map((x) => x.frame - timed.startFrame) : null;
  const hits = words.map((_, i) => (sung ? sung[i] : Math.round((1 + i * 0.5) * ctx.fpb)));
  const emph = new Set((v.emphasis ?? []).map((e) => e.toLowerCase()));
  const style = v.style ?? "stack";
  const chorus = ctx.shot.section === "chorus";
  // Repeated choruses shouldn't look frozen: each repeat gets its own colour and ring motion.
  const repeat = ctx.spec.shots.filter((s, i) => s.section === "chorus" && i < ctx.spec.shots.indexOf(ctx.shot)).length;
  const ringColors = [[p.primary, p.secondary], [p.accent, p.primary], [p.secondary, p.accent]][repeat % 3];
  const maxSize = (fmt.vertical ? 150 : 150) * fmt.u;
  const fits = lines.map((l) => fitText(l, box.w * 0.92, { maxSize: style === "punch" ? maxSize : maxSize * 0.8, minSize: 56 * fmt.u, maxLines: 1 }));
  const size = Math.min(...fits.map((x) => x.size));

  // Beat rings on chorus downbeats only.
  const bar = ctx.fpb * 4;
  const sinceBar = ((f % bar) + bar) % bar;
  const ring = chorus ? accent(sinceBar, 0, Math.round(ctx.fpb * 1.5)) : 0;

  let wi = 0;
  return (
    <AbsoluteFill>
      {chorus ? (
        <svg width={fmt.w} height={fmt.h} style={{ position: "absolute", inset: 0 }}>
          {[0, 1, 2].map((i) => (
            <circle key={i} cx={fmt.w / 2 + (repeat % 2 ? 1 : -1) * Math.sin(f / 40 + i) * 30 * fmt.u} cy={box.y + box.h / 2} r={(260 + i * 170 + ring * 40 + repeat * 30) * fmt.u} fill="none" stroke={alpha(i === 1 ? ringColors[1] : ringColors[0], 0.12 + ring * 0.18)} strokeWidth={(10 - i * 2) * fmt.u} strokeDasharray={repeat === 1 ? `${18 * fmt.u} ${14 * fmt.u}` : undefined} />
          ))}
        </svg>
      ) : null}
      <div style={{ position: "absolute", left: box.x, top: box.y, width: box.w, height: box.h, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: style === "stack" && !fmt.vertical ? "flex-start" : "center", gap: size * 0.08 }}>
        {lines.map((line, li) => {
          const lw = lyricWords(line);
          return (
            <div key={li} style={{ display: "flex", gap: size * 0.26, flexWrap: "nowrap", transform: style === "wave" ? `translateY(${Math.sin(f / 14 + li) * 10 * fmt.u}px)` : undefined }}>
              {lw.map((w, i) => {
                const idx = wi++;
                const hit = hits[idx];
                const k = appear(f, hit - 3, style === "punch" ? 6 : 10);
                const pop = style === "punch" ? interpolate(f - hit, [-3, 2, 10], [1.22, 0.97, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 1;
                const on = f >= hit - 2 && (hits[idx + 1] == null || f < hits[idx + 1] + ctx.fpb * 0.5);
                const isEmph = emph.has(w.toLowerCase()) || (chorus && li === 0 && i === 0);
                return (
                  <span
                    key={i}
                    style={{
                      fontFamily: theme.font.display,
                      fontWeight: theme.font.heavy,
                      fontSize: size,
                      lineHeight: 1.05,
                      letterSpacing: -1 * fmt.u,
                      color: isEmph ? ringColors[0] : p.text,
                      opacity: k,
                      transform: `translateY(${(1 - k) * 40 * fmt.u}px) scale(${pop})`,
                      textShadow: on && chorus ? `0 0 ${30 * fmt.u}px ${alpha(p.primary, 0.6)}` : `0 ${6 * fmt.u}px 0 ${alpha("#000", 0.25)}`,
                      display: "inline-block",
                      transformOrigin: "50% 80%",
                    }}
                  >
                    {w}
                  </span>
                );
              })}
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

function splitLines(text: string, maxLines: number): string[] {
  if (text.includes(" / ")) return text.split(" / ").slice(0, maxLines + 1);
  const parts = text.split(/(?<=[,!?.])\s+/).filter(Boolean);
  if (parts.length > 1 && parts.length <= maxLines + 1) return parts;
  const words = text.split(/\s+/);
  const per = Math.ceil(words.length / Math.min(maxLines, Math.ceil(words.length / 3)));
  const out: string[] = [];
  for (let i = 0; i < words.length; i += per) out.push(words.slice(i, i + per).join(" "));
  return out;
}
