// The channel's visual identity. Chosen once, reused by every video.
// Scenes never hard-code colours, fonts or easing: they read them from here.
import { Easing } from "remotion";

export const theme = {
  fps: 30,
  palette: {
    background: "#14123a",
    surface: "#262262",
    primary: "#ffcc33",
    secondary: "#ff4f8b",
    accent: "#3ee0cf",
    text: "#ffffff",
    textMuted: "#c9c6ff",
  },
  font: {
    family: "'Baloo 2', 'Arial Rounded MT Bold', system-ui, sans-serif",
    heavy: 800,
    regular: 500,
  },
  easing: {
    pop: Easing.bezier(0.34, 1.56, 0.64, 1),
    smooth: Easing.bezier(0.45, 0, 0.55, 1),
  },
} as const;

/** Colour used for the flash and accents of each scene kind. */
export const sceneColor = {
  hook: theme.palette.secondary,
  beat: theme.palette.accent,
  chorus: theme.palette.primary,
  recap: theme.palette.secondary,
} as const;
