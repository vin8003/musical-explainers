// Types for storyboard.mjs (VideoSpec v2).

export type Section = "intro" | "verse" | "chorus" | "bridge" | "outro";
export type World = "night" | "cell" | "sky" | "paper";
export type CameraMove = "static" | "push-in" | "pull-out" | "pan-left" | "pan-right" | "rise" | "drift";
export type Transition = "cut" | "fade" | "wipe" | "push" | "zoom";
export type MascotMood = "happy" | "wow" | "thinking" | "pointing";
export type Sfx = "pop" | "whoosh" | "blip" | "hit" | "riser" | "chime";
export type ColorName = "primary" | "secondary" | "accent" | "warm" | "cool";
export type IconRef = string; // a built-in icon id, or "file:<asset-id>"
export type JourneyScene = "home" | "city" | "coast" | "ocean" | "seafloor" | "datacenter" | "space" | "cell";

export type Visual =
  | { type: "title"; kicker?: string; title: string; subtitle?: string; icon?: IconRef }
  | { type: "kinetic"; style?: "stack" | "wave" | "punch"; lines?: string[]; emphasis?: string[] }
  | {
      type: "network";
      nodes: { id: string; icon: IconRef; label?: string; x: number; y: number }[];
      links?: { from: string; to: string; style?: "cable" | "wireless" | "undersea" | "dashed" }[];
      packets?: { route: string[]; label?: string; color?: ColorName; startBeat?: number; beatsPerHop?: number }[];
      highlight?: string[];
    }
  | {
      type: "packetize";
      mode: "split" | "reassemble";
      source: { icon: IconRef; label?: string };
      count: number;
      packetLabel?: "seq" | "address" | "none";
      destination?: { icon: IconRef; label?: string };
    }
  | { type: "anatomy"; subject: IconRef; label?: string; callouts: { label: string; anchor?: string; x?: number; y?: number }[] }
  | {
      type: "journey";
      stops: { scene: JourneyScene; label: string }[];
      traveller: { icon: IconRef; label?: string };
      stat?: { label: string; value: string };
    }
  | {
      type: "flow";
      inputs: { icon: IconRef; label?: string }[];
      machine: { icon: IconRef; label?: string };
      outputs: { icon: IconRef; label?: string }[];
    }
  | { type: "population"; groups: { label: string; icon: IconRef; count: number; value?: string; container?: IconRef }[] }
  | {
      type: "comparison";
      left: { title: string; icon?: IconRef; points?: string[] };
      right: { title: string; icon?: IconRef; points?: string[] };
    }
  | { type: "timeline"; events: { when: string; label: string; icon?: IconRef }[] }
  | { type: "steps"; steps: { icon: IconRef; label: string }[] }
  | { type: "character"; say: string; prop?: IconRef }
  | { type: "scene3d"; scene: string; fallback: Exclude<Visual, { type: "scene3d" }> };

export type Shot = {
  id: string;
  section: Section;
  /** Editorial: what this shot is for. Read by reviewers and QA, ignored by the renderer. */
  purpose?: string;
  narration?: string;
  lyric?: string;
  headline?: string;
  minBars?: number;
  visual: Visual;
  camera?: { move: CameraMove; target?: [number, number] };
  transition?: Transition;
  mascot?: { mood: MascotMood; position?: "left" | "right" } | null;
  accents?: { beat: number; sfx?: Sfx; target?: string }[];
  short?: boolean;
  assets?: { id: string; required: boolean; role?: string }[];
  notes?: string;
};

export type VideoSpec = {
  schemaVersion: 2;
  slug: string;
  title: string;
  /** Editorial. */
  brief?: { audience?: string; learningGoal?: string; hook?: string };
  world?: World;
  /** Pipeline bookkeeping: "draft" until the direct stage has chosen visuals. */
  direction?: { status: "draft" | "directed"; at?: string; by?: string };
  music: {
    bpm: number;
    key?: string;
    mode?: "major" | "minor";
    mood?: "bright" | "driving" | "calm" | "mysterious";
    beatOffsetMs?: number;
    /** A user-supplied song under public/, used instead of the built-in composer. */
    songSrc?: string;
  };
  shots: Shot[];
};

export declare const SCHEMA_VERSION: 2;
export declare const SECTIONS: Section[];
export declare const WORLDS: World[];
export declare const MOODS: string[];
export declare const KEYS: string[];
export declare const CAMERA_MOVES: CameraMove[];
export declare const TRANSITIONS: Transition[];
export declare const MASCOT_MOODS: MascotMood[];
export declare const SFX: Sfx[];
export declare const LINK_STYLES: string[];
export declare const JOURNEY_SCENES: JourneyScene[];
export declare const KINETIC_STYLES: string[];
export declare const COLORS: ColorName[];
export declare const ICONS: string[];
export declare const VISUALS: Record<Visual["type"], string>;
export declare const EDITORIAL: string[];
export declare const SCENES_3D: Record<string, string>;
export declare const ANCHORS: Record<string, Record<string, [number, number]>>;
export declare function resolveAnchor(subject: string, c: { anchor?: string; x?: number; y?: number }): { x: number; y: number };
export declare function validateSpec(spec: unknown, opts?: { slug?: string }): string[];
export declare function lintSpec(spec: VideoSpec): string[];
export declare function migrateSpec(spec: any): VideoSpec;
export declare function textOf(spec: VideoSpec): { shot: string; narration: string | null; lyric: string | null; headline: string | null; labels: string[] }[];
