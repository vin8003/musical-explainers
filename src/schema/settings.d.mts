// Types for settings.mjs.
import type { Format } from "./timeline.mjs";

export type FormatDuration = { targetSeconds: number; minSeconds: number; maxSeconds: number };
export type Settings = {
  version: number;
  formats: Record<Format, FormatDuration>;
  narration: { wordsPerMinute: number; targetTolerance: number };
};
export type DurationCheck = { verdict: "ok" | "off-target" | "short" | "long" | "unknown"; message: string };

export declare const SETTINGS_VERSION: number;
export declare const FORMATS: Format[];
export declare const FORMAT_LABEL: Record<Format, string>;
export declare const DEFAULT_SETTINGS: Settings;
export declare function validateSettings(s: unknown): string[];
export declare function normalizeSettings(s: unknown): Settings;
export declare function resolveSettings(raw: unknown): { settings: Settings; source: "defaults" | "file" | "file+defaults"; warnings: string[] };
export declare function formatKey(settings: Settings, format: Format): string;
export declare function checkDuration(seconds: number | null | undefined, settings: Settings, format: Format): DurationCheck;
export declare function fmt(seconds: number): string;
