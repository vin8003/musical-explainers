import type { Section, Shot, Sfx, Transition, VideoSpec } from "./storyboard.mjs";

export type Format = "main" | "short";

export type TimedShot = {
  id: string;
  index: number;
  section: Section;
  startBeat: number;
  bars: number;
  startFrame: number;
  durationFrames: number;
  transition: Transition;
  narration: { startFrame: number; durationFrames: number; measured: boolean } | null;
  lyric: { word: string; beat: number; frame: number }[];
  accents: { beat: number; sfx?: Sfx; target?: string; frame: number }[];
};

export type Timeline = {
  format: Format;
  fps: number;
  bpm: number;
  beatOffsetMs: number;
  framesPerBeat: number;
  totalBeats: number;
  totalFrames: number;
  shots: TimedShot[];
};

export declare const FPS: number;
export declare const BEATS_PER_BAR: number;
export declare const NARRATION_LEAD_S: number;
export declare const NARRATION_TAIL_S: number;
export declare const TRANSITION_FRAMES: Record<Transition, number>;
export declare function shotsFor(spec: VideoSpec, format: Format): Shot[];
export declare function lyricWords(lyric?: string): string[];
export declare function buildTimeline(spec: VideoSpec, format?: Format, voice?: Record<string, number>, fps?: number, opts?: { wordsPerMinute?: number }): Timeline;
export declare const DEFAULT_WORDS_PER_MINUTE: number;
export declare function wordCount(text?: string | null): number;
export declare function estimateSpeechSeconds(text: string, wordsPerMinute?: number): number;
export type RuntimeEstimate = { seconds: number; spokenWords: number; sungWords: number; narrationSeconds: number; shots: number; wordsPerMinute: number };
export declare function estimateRuntime(spec: VideoSpec, format?: Format, wordsPerMinute?: number): RuntimeEstimate;
export declare function captionChunks(text: string, startFrame: number, durationFrames: number): { text: string; startFrame: number; durationFrames: number }[];
