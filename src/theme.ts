// The channel's art direction. One brand (yellow + Avenir Next + calm motion),
// several "worlds" so a biology video doesn't look like a networking video.
// Scenes never hard-code colours, fonts or easing: they read them from here.
import { Easing } from "remotion";
import type { ColorName, World } from "./schema/storyboard.mjs";

export type Palette = {
  /** Background gradient, top to bottom. */
  bg: [string, string];
  /** Soft light sources painted behind content. */
  glow: [string, string];
  surface: string;
  surfaceHi: string;
  line: string;
  text: string;
  textMuted: string;
  primary: string;
  secondary: string;
  accent: string;
  warm: string;
  cool: string;
  ink: string;
};

const brand = { primary: "#FFC93C", ink: "#1B1530" };

export const worlds: Record<World, Palette> = {
  night: {
    bg: ["#0E1033", "#060818"], glow: ["#2B48C9", "#7A2BD1"], surface: "#1A1E4D", surfaceHi: "#262C66", line: "#4A55A8",
    text: "#F5F6FF", textMuted: "#A9B0E8", primary: brand.primary, secondary: "#FF5C93", accent: "#3EE6D3", warm: "#FF9A3C", cool: "#5AA8FF", ink: brand.ink,
  },
  cell: {
    bg: ["#2A0F2E", "#120612"], glow: ["#C2366B", "#E86A33"], surface: "#3B1840", surfaceHi: "#4D2152", line: "#8A4A86",
    text: "#FFF4F2", textMuted: "#E5B9C9", primary: brand.primary, secondary: "#FF6B8B", accent: "#5FF2B0", warm: "#FF8A3D", cool: "#7FB8FF", ink: brand.ink,
  },
  sky: {
    bg: ["#16305E", "#0A1530"], glow: ["#3D7BE0", "#E0703D"], surface: "#1E3D73", surfaceHi: "#2A4E8C", line: "#5C83C4",
    text: "#F4F8FF", textMuted: "#B6C8EA", primary: brand.primary, secondary: "#FF7AA2", accent: "#62E3FF", warm: "#FFAA4D", cool: "#7FC4FF", ink: brand.ink,
  },
  paper: {
    bg: ["#F6EEDC", "#E9DCC0"], glow: ["#FFFFFF", "#F2C77E"], surface: "#FFF9EC", surfaceHi: "#FFFFFF", line: "#B9A57E",
    text: "#2A2236", textMuted: "#6E6280", primary: "#F2A900", secondary: "#E0457B", accent: "#1BA88F", warm: "#E8742A", cool: "#3A78D6", ink: brand.ink,
  },
};

export const theme = {
  fps: 30,
  font: {
    display: "'Avenir Next', 'Avenir', 'Arial Rounded MT Bold', 'Helvetica Neue', sans-serif",
    body: "'Avenir Next', 'Avenir', 'Helvetica Neue', sans-serif",
    mono: "'SF Mono', 'Menlo', 'Monaco', monospace",
    heavy: 800,
    bold: 700,
    medium: 500,
  },
  radius: { sm: 12, md: 22, lg: 36 },
  /** Motion language: things ease out of the way, never bounce for the sake of it. */
  easing: {
    out: Easing.bezier(0.16, 1, 0.3, 1),
    inOut: Easing.bezier(0.65, 0, 0.35, 1),
    soft: Easing.bezier(0.45, 0, 0.55, 1),
    back: Easing.bezier(0.34, 1.4, 0.64, 1),
  },
  spring: {
    gentle: { damping: 18, stiffness: 120, mass: 0.9 },
    snappy: { damping: 14, stiffness: 200, mass: 0.7 },
  },
} as const;

export const paletteFor = (world?: World): Palette => worlds[world ?? "night"] ?? worlds.night;

export const colorOf = (p: Palette, c?: ColorName): string => (c ? p[c] : p.primary);

/** Hex colour with alpha, for glows and translucent fills. */
export const alpha = (hex: string, a: number) => {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((x) => x + x).join("") : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};
