// Typography primitives: a fitted headline that reveals word by word, small
// diagram labels, and the caption band. Sizes come from fitText so long text
// shrinks within readable limits instead of overflowing.
import React from "react";
import { fitText, Format } from "../layout";
import { alpha, Palette, theme } from "../theme";
import { appear } from "./motion";

export const Headline: React.FC<{
  text: string;
  f: number;
  p: Palette;
  fmt: Format;
  width: number;
  align?: "left" | "center";
  maxSize?: number;
  color?: string;
  at?: number;
}> = ({ text, f, p, fmt, width, align = "left", maxSize, color, at = 0 }) => {
  const fit = fitText(text, width, { maxSize: maxSize ?? (fmt.vertical ? 96 : 84) * fmt.u, minSize: (fmt.vertical ? 60 : 48) * fmt.u, maxLines: fmt.vertical ? 3 : 2 });
  let wi = 0;
  return (
    <div style={{ fontFamily: theme.font.display, fontWeight: theme.font.heavy, fontSize: fit.size, lineHeight: 1.08, color: color ?? p.text, textAlign: align, letterSpacing: -0.5 * fmt.u, width }}>
      {fit.lines.map((line, li) => (
        <div key={li} style={{ whiteSpace: "nowrap" }}>
          {line.split(" ").map((w, i) => {
            const k = appear(f, at + wi++ * 3, 16);
            return (
              <span key={i} style={{ display: "inline-block", overflow: "hidden", verticalAlign: "top", paddingBottom: fit.size * 0.12, marginBottom: -fit.size * 0.12 }}>
                <span style={{ display: "inline-block", transform: `translateY(${(1 - k) * 105}%)`, opacity: k }}>
                  {w}
                  {i < line.split(" ").length - 1 ? " " : ""}
                </span>
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
};

/** Kicker line above a headline, in the accent colour. */
export const Kicker: React.FC<{ text: string; p: Palette; fmt: Format; f: number; color?: string }> = ({ text, p, fmt, f, color }) => {
  const k = appear(f, 0, 12);
  return (
    <div style={{ fontFamily: theme.font.body, fontWeight: theme.font.bold, fontSize: 30 * fmt.u, letterSpacing: 4 * fmt.u, textTransform: "uppercase", color: color ?? p.accent, opacity: k, transform: `translateX(${(1 - k) * -20}px)` }}>
      {text}
    </div>
  );
};

/** Label chip used inside diagrams. */
export const Label: React.FC<{ text: string; p: Palette; fmt: Format; k?: number; size?: number; tone?: "dark" | "light" | "accent"; mono?: boolean; maxWidth?: number }> = ({ text, p, fmt, k = 1, size = 30, tone = "dark", mono, maxWidth }) => {
  const fs = (fmt.vertical ? size * 1.08 : size) * fmt.u;
  const bg = tone === "accent" ? p.primary : tone === "light" ? "#ffffff" : alpha(p.surface, 0.92);
  const fg = tone === "dark" ? p.text : p.ink;
  return (
    <div
      style={{
        display: "inline-block",
        padding: `${fs * 0.28}px ${fs * 0.6}px`,
        borderRadius: fs * 0.5,
        background: bg,
        border: tone === "dark" ? `${2 * fmt.u}px solid ${alpha(p.line, 0.8)}` : "none",
        color: fg,
        fontFamily: mono ? theme.font.mono : theme.font.body,
        fontWeight: theme.font.bold,
        fontSize: fs,
        lineHeight: 1.15,
        whiteSpace: maxWidth ? "normal" : "nowrap",
        maxWidth,
        textAlign: "center",
        opacity: k,
        transform: `translateY(${(1 - k) * 12 * fmt.u}px) scale(${0.9 + 0.1 * k})`,
        boxShadow: `0 ${8 * fmt.u}px ${24 * fmt.u}px ${alpha("#000000", 0.25)}`,
      }}
    >
      {text}
    </div>
  );
};

/** Subtitle band: the current narration chunk, or a lyric line with a note glyph. */
export const CaptionBand: React.FC<{ text: string; p: Palette; fmt: Format; local: number; len: number; lyric?: boolean }> = ({ text, p, fmt, local, len, lyric }) => {
  const box = fmt.captionBand;
  const fit = fitText(text, box.w * 0.9, { maxSize: (fmt.vertical ? 50 : 44) * fmt.u, minSize: (fmt.vertical ? 40 : 34) * fmt.u, maxLines: 2, weight: "bold" });
  const k = Math.min(appear(local, 0, 6), 1 - appear(local, len - 5, 5));
  return (
    <div style={{ position: "absolute", left: box.x, top: box.y, width: box.w, height: box.h, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
      <div
        style={{
          maxWidth: box.w,
          padding: `${fit.size * 0.3}px ${fit.size * 0.65}px`,
          borderRadius: fit.size * 0.45,
          background: alpha("#05060F", 0.62),
          color: lyric ? p.primary : "#ffffff",
          fontFamily: theme.font.body,
          fontWeight: theme.font.bold,
          fontSize: fit.size,
          lineHeight: 1.22,
          textAlign: "center",
          opacity: k,
          transform: `translateY(${(1 - k) * 8}px)`,
          fontStyle: lyric ? "italic" : "normal",
        }}
      >
        {fit.lines.map((l, i) => (
          <div key={i}>{i === 0 && lyric ? "♪ " : ""}{l}</div>
        ))}
      </div>
    </div>
  );
};
