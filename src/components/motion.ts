// Small motion vocabulary. Every scene uses these instead of ad-hoc
// interpolate calls, so timing feels consistent across the channel.
import { interpolate } from "remotion";
import { theme } from "../theme";

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

/** 0 -> 1 between `at` and `at + len` frames, easing out. */
export const appear = (f: number, at: number, len = 14, easing = theme.easing.out) =>
  interpolate(f, [at, at + len], [0, 1], { ...clamp, easing });

/** 1 -> 0, for exits. */
export const disappear = (f: number, at: number, len = 12) => 1 - appear(f, at, len, theme.easing.inOut);

/** Eased progress across a range, for travel along paths. */
export const travel = (f: number, from: number, to: number, easing = theme.easing.inOut) =>
  interpolate(f, [from, Math.max(from + 1, to)], [0, 1], { ...clamp, easing });

/** A short swell (0 -> 1 -> 0) starting at `at`: used for selective musical accents. */
export const accent = (f: number, at: number, len = 10) => {
  if (f < at || f > at + len) return 0;
  const x = (f - at) / len;
  return Math.sin(Math.PI * Math.min(1, x * 1.6)) * (1 - x * 0.4);
};

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Point along a polyline at t in [0,1]. */
export function along(points: { x: number; y: number }[], t: number) {
  if (points.length === 1) return points[0];
  const segs = points.slice(1).map((p, i) => Math.hypot(p.x - points[i].x, p.y - points[i].y));
  const total = segs.reduce((a, b) => a + b, 0) || 1;
  let d = Math.max(0, Math.min(1, t)) * total;
  for (let i = 0; i < segs.length; i++) {
    if (d <= segs[i] || i === segs.length - 1) {
      const k = segs[i] ? d / segs[i] : 0;
      return { x: lerp(points[i].x, points[i + 1].x, k), y: lerp(points[i].y, points[i + 1].y, k) };
    }
    d -= segs[i];
  }
  return points[points.length - 1];
}
