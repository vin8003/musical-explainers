// An illustration on a lit platform with an optional label: the basic actor in
// diagrams. `k` drives the entrance, `hot` a highlight ring.
import React from "react";
import { Icon } from "../assets/icons";
import type { Format } from "../layout";
import { alpha, Palette } from "../theme";
import { Label } from "./Text";

export const IconNode: React.FC<{
  icon: string;
  p: Palette;
  fmt: Format;
  x: number;
  y: number;
  size: number;
  label?: string;
  k?: number;
  hot?: number;
  labelPos?: "below" | "above" | "right";
  plate?: boolean;
}> = ({ icon, p, fmt, x, y, size, label, k = 1, hot = 0, labelPos = "below", plate = true }) => {
  const s = 0.6 + 0.4 * k;
  return (
    <div style={{ position: "absolute", left: x - size / 2, top: y - size / 2, width: size, height: size, opacity: Math.min(1, k * 1.4), transform: `translateY(${(1 - k) * 30 * fmt.u}px) scale(${s})` }}>
      {plate ? (
        <div
          style={{
            position: "absolute",
            inset: -size * 0.16,
            borderRadius: "50%",
            background: `radial-gradient(circle at 50% 40%, ${alpha(p.surfaceHi, 0.95)} 0%, ${alpha(p.surface, 0.9)} 60%, ${alpha(p.surface, 0)} 72%)`,
            boxShadow: hot ? `0 0 ${size * 0.5 * hot}px ${alpha(p.primary, 0.55 * hot)}` : "none",
          }}
        />
      ) : null}
      {hot ? <div style={{ position: "absolute", inset: -size * 0.2, borderRadius: "50%", border: `${4 * fmt.u}px solid ${alpha(p.primary, hot)}`, transform: `scale(${1 + 0.06 * hot})` }} /> : null}
      <div style={{ position: "absolute", inset: size * 0.08 }}>
        <Icon id={icon} p={p} size={size * 0.84} />
      </div>
      {label && labelPos === "right" ? (
        <div style={{ position: "absolute", left: size * 1.12, top: "50%", transform: "translateY(-50%)" }}>
          <Label text={label} p={p} fmt={fmt} k={k} size={26} />
        </div>
      ) : label ? (
        <div style={{ position: "absolute", left: "50%", [labelPos === "below" ? "top" : "bottom"]: size * 1.08, transform: "translateX(-50%)" }}>
          <Label text={label} p={p} fmt={fmt} k={k} size={26} />
        </div>
      ) : null}
    </div>
  );
};
