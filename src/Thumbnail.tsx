// Thumbnail still (1280x720), built from the same art direction: backdrop,
// the hero icon from the opening shot, the mascot, and one bold phrase.
import React from "react";
import { AbsoluteFill } from "remotion";
import { Icon } from "./assets/icons";
import { Backdrop } from "./components/Backdrop";
import { Mascot } from "./components/Mascot";
import { fitText } from "./layout";
import { migrateSpec } from "./schema/storyboard.mjs";
import { alpha, paletteFor, theme } from "./theme";
import type { RenderProps } from "./types";

export const Thumbnail: React.FC<RenderProps & { phrase?: string }> = (props) => {
  const spec = migrateSpec(props.spec);
  const p = paletteFor(spec.world);
  const hero = spec.shots.map((s) => (s.visual.type === "title" ? s.visual.icon : undefined)).find(Boolean) ?? "question";
  const phrase = props.phrase ?? spec.title.replace(/\?$/, "?");
  const fit = fitText(phrase, 700, { maxSize: 120, minSize: 64, maxLines: 3 });
  return (
    <AbsoluteFill>
      <Backdrop p={p} world={spec.world ?? "night"} seed={`${spec.slug}-thumb`} intensity={1.4} />
      <div style={{ position: "absolute", right: 60, top: 90, width: 520, height: 520, borderRadius: "50%", background: `radial-gradient(circle, ${alpha(p.primary, 0.35)} 0%, transparent 65%)` }} />
      <div style={{ position: "absolute", right: 110, top: 120 }}>
        <Icon id={hero} p={p} size={430} />
      </div>
      <div style={{ position: "absolute", right: 40, bottom: 10 }}>
        <Mascot p={p} size={250} mood="wow" />
      </div>
      <div style={{ position: "absolute", left: 60, top: 0, bottom: 0, width: 720, display: "flex", flexDirection: "column", justifyContent: "center" }}>
        {fit.lines.map((l, i) => (
          <div key={i} style={{ fontFamily: theme.font.display, fontWeight: 800, fontSize: fit.size, lineHeight: 1.02, color: i === fit.lines.length - 1 ? p.primary : p.text, textShadow: `0 8px 0 ${alpha("#000", 0.35)}`, whiteSpace: "nowrap" }}>
            {l}
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
};
