// A VideoSpec is everything one video needs. Stage 2 (script) writes it,
// stages 4-5 (music, narration) add timing, and Explainer renders it.

export type SceneKind = "hook" | "beat" | "chorus" | "recap";

export type Scene = {
  kind: SceneKind;
  /** Big on-screen phrase. Keep it short: it pops in on the beat. */
  text: string;
  /** Smaller supporting line (narration excerpt or caption). */
  caption?: string;
  /** Length in musical beats, so cuts always land on the beat. */
  durationBeats: number;
};

export type VideoSpec = {
  slug: string;
  title: string;
  /** Tempo of the generated song; drives every cut, zoom and flash. */
  bpm: number;
  /** Milliseconds from audio start to the first downbeat. */
  beatOffsetMs?: number;
  /** Path under public/ for the song, once stage 4 has produced it. */
  songSrc?: string;
  scenes: Scene[];
};
