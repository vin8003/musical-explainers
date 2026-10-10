// Renders a storyboard. The timeline (from the audio stage, or estimated when
// there is no audio yet) places every shot on bar lines; each shot gets an
// entrance transition, a camera move, an optional headline, its scene system
// and, if asked, the mascot. Captions and the backdrop sit above/below all
// shots so they stay continuous across cuts.
import React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { Backdrop } from "./components/Backdrop";
import { Mascot } from "./components/Mascot";
import { appear } from "./components/motion";
import { CaptionBand, Headline } from "./components/Text";
import { fitText, Format, formatFor } from "./layout";
import { migrateSpec } from "./schema/storyboard.mjs";
import type { Shot, VideoSpec } from "./schema/storyboard.mjs";
import { buildTimeline, captionChunks, TRANSITION_FRAMES } from "./schema/timeline.mjs";
import type { Timeline, TimedShot } from "./schema/timeline.mjs";
import { AnatomyShot } from "./shots/AnatomyShot";
import { CharacterShot, ComparisonShot, FlowShot, PopulationShot, StepsShot, TimelineShot, TitleShot } from "./shots/CardShots";
import { ShotCtx } from "./shots/context";
import { JourneyShot } from "./shots/JourneyShot";
import { KineticShot } from "./shots/KineticShot";
import { NetworkShot } from "./shots/NetworkShot";
import { PacketizeShot } from "./shots/PacketizeShot";
import { Scene3DShot } from "./shots/Scene3DShot";
import { paletteFor, theme } from "./theme";
import type { RenderProps } from "./types";

const SYSTEMS: Record<Shot["visual"]["type"], React.FC<{ ctx: ShotCtx }>> = {
  title: TitleShot,
  kinetic: KineticShot,
  network: NetworkShot,
  packetize: PacketizeShot,
  anatomy: AnatomyShot,
  journey: JourneyShot,
  flow: FlowShot,
  population: PopulationShot,
  comparison: ComparisonShot,
  timeline: TimelineShot,
  steps: StepsShot,
  character: CharacterShot,
  scene3d: Scene3DShot,
};

export { SYSTEMS };

/** Accepts a bare v1/v2 spec (old --props=specs/x.json) or full render props. */
export function normalizeProps(props: RenderProps | VideoSpec | Record<string, unknown>, vertical: boolean) {
  const rp = (props as RenderProps).spec ? (props as RenderProps) : ({ spec: props } as RenderProps);
  const spec = migrateSpec(rp.spec) as VideoSpec;
  const format = vertical ? "short" : "main";
  const timeline: Timeline = rp.timelines?.[format] ?? buildTimeline(spec, format);
  const audio = rp.audio?.[format] ?? null;
  const clips = Object.fromEntries(Object.entries(rp.clips ?? {}).map(([id, c]) => [id, c?.[format] ?? null]));
  return { spec, timeline, audio, format, clips } as const;
}

export const Explainer: React.FC<RenderProps> = (props) => {
  const { width, height } = useVideoConfig();
  const fmt = formatFor(width, height);
  const { spec, timeline, audio, clips } = normalizeProps(props, fmt.vertical);
  const p = paletteFor(spec.world);
  const world = spec.world ?? "night";
  const shotsById = Object.fromEntries(spec.shots.map((s) => [s.id, s]));

  return (
    <AbsoluteFill style={{ backgroundColor: p.bg[1], fontFamily: theme.font.body }}>
      <Backdrop p={p} world={world} seed={spec.slug} />
      {timeline.shots.map((t, i) => {
        const shot = shotsById[t.id];
        if (!shot) return null;
        const lead = i === 0 ? 0 : TRANSITION_FRAMES[t.transition] ?? 0;
        const next = timeline.shots[i + 1];
        const exit = next ? { kind: next.transition, frames: TRANSITION_FRAMES[next.transition] ?? 0 } : null;
        return (
          <Sequence key={t.id} from={t.startFrame - lead} durationInFrames={t.durationFrames + lead} name={`${i + 1}. ${t.id} (${shot.visual.type})`}>
            <ShotFrame spec={spec} shot={shot} timed={t} fmt={fmt} lead={lead} exit={exit} fpb={timeline.framesPerBeat} clip={clips[t.id] ?? null} />
          </Sequence>
        );
      })}
      <Captions spec={spec} timeline={timeline} fmt={fmt} />
      {audio?.src ? <Audio src={staticFile(audio.src)} /> : null}
    </AbsoluteFill>
  );
};

const ShotFrame: React.FC<{ spec: VideoSpec; shot: Shot; timed: TimedShot; fmt: Format; lead: number; exit: { kind: string; frames: number } | null; fpb: number; clip: { src: string; seconds: number } | null }> = ({ spec, shot, timed, fmt, lead, exit, fpb, clip }) => {
  const frame = useCurrentFrame();
  const p = paletteFor(spec.world);
  const f = frame - lead;
  const dur = timed.durationFrames;

  // Headline above the visual (title and kinetic shots set their own type).
  const hasHeadline = Boolean(shot.headline) && shot.visual.type !== "title" && shot.visual.type !== "kinetic";
  const hw = fmt.stage.w * (fmt.vertical ? 1 : 0.82);
  const hfit = hasHeadline ? fitText(shot.headline!, hw, { maxSize: (fmt.vertical ? 96 : 84) * fmt.u, minSize: (fmt.vertical ? 60 : 48) * fmt.u, maxLines: fmt.vertical ? 3 : 2 }) : null;
  const headH = hfit ? hfit.lines.length * hfit.size * 1.12 + 30 * fmt.u : 0;
  const content = { ...fmt.stage, y: fmt.stage.y + headH, h: fmt.stage.h - headH };
  const ctx: ShotCtx = { spec, shot, timed, p, fmt, fpb, lead, dur, content, seed: `${spec.slug}-${shot.id}`, clip };
  const System = SYSTEMS[shot.visual.type];

  // Entrance.
  const kIn = lead ? appear(frame, 0, lead, theme.easing.inOut) : 1;
  const enter = transitionStyle(timed.transition, kIn, true);
  // Exit, mirroring the next shot's entrance.
  const kOut = exit && exit.frames ? appear(f, dur - exit.frames, exit.frames, theme.easing.inOut) : 0;
  const leave = exit ? transitionStyle(exit.kind, kOut, false) : {};

  const cam = cameraTransform(shot, (f + lead) / (dur + lead));
  const narr = timed.narration;
  const talking = narr ? f >= narr.startFrame - timed.startFrame && f < narr.startFrame - timed.startFrame + narr.durationFrames : false;
  const showMascot = shot.mascot && shot.visual.type !== "character";
  const mSize = (fmt.vertical ? 300 : 260) * fmt.u;

  return (
    <AbsoluteFill style={{ ...enter.outer, ...mergeOuter(leave) }}>
      <AbsoluteFill style={{ transform: `${enter.transform ?? ""} ${(leave as { transform?: string }).transform ?? ""}`, opacity: (enter.opacity ?? 1) * ((leave as { opacity?: number }).opacity ?? 1) }}>
        <AbsoluteFill style={{ transform: cam.transform, transformOrigin: cam.origin }}>
          <System ctx={ctx} />
        </AbsoluteFill>
        {hasHeadline ? (
          <div style={{ position: "absolute", left: fmt.vertical ? fmt.stage.x : fmt.stage.x, top: fmt.stage.y, width: fmt.vertical ? fmt.stage.w : hw }}>
            <Headline text={shot.headline!} f={f} p={p} fmt={fmt} width={fmt.vertical ? fmt.stage.w : hw} align={fmt.vertical ? "center" : "left"} />
          </div>
        ) : null}
        {showMascot ? (
          <div style={{ position: "absolute", left: shot.mascot!.position === "left" ? fmt.safe.x : fmt.safe.x + fmt.safe.w - mSize, top: fmt.captionBand.y - mSize * (fmt.vertical ? 1.05 : 0.9), opacity: appear(f, 4, 14), transform: `translateY(${(1 - appear(f, 4, 16)) * 60 * fmt.u}px)` }}>
            <Mascot p={p} size={mSize} mood={shot.mascot!.mood} talking={talking} grooveFpb={shot.section === "chorus" ? fpb : undefined} flip={shot.mascot!.position === "left"} />
          </div>
        ) : null}
      </AbsoluteFill>
      {timed.transition === "wipe" && kIn < 1 ? <div style={{ position: "absolute", top: 0, bottom: 0, left: `${kIn * 100}%`, width: 10 * fmt.u, background: p.primary, boxShadow: `0 0 ${40 * fmt.u}px ${p.primary}` }} /> : null}
    </AbsoluteFill>
  );
};

function transitionStyle(kind: string, k: number, entering: boolean): { outer: React.CSSProperties; transform?: string; opacity?: number } {
  if (entering) {
    if (kind === "fade") return { outer: {}, opacity: k };
    if (kind === "wipe") return { outer: { clipPath: `inset(0 ${(1 - k) * 100}% 0 0)` } };
    if (kind === "push") return { outer: {}, transform: `translateX(${(1 - k) * 100}%)` };
    if (kind === "zoom") return { outer: {}, transform: `scale(${1.25 - 0.25 * k})`, opacity: k };
    return { outer: {} };
  }
  if (kind === "push") return { outer: {}, transform: `translateX(${-k * 35}%)`, opacity: 1 - k * 0.6 };
  if (kind === "zoom") return { outer: {}, transform: `scale(${1 + 0.18 * k})`, opacity: 1 - k };
  if (kind === "fade") return { outer: {}, opacity: 1 - k * 0.5 };
  return { outer: {} };
}

const mergeOuter = (x: { outer?: React.CSSProperties }) => x.outer ?? {};

function cameraTransform(shot: Shot, t: number) {
  const e = theme.easing.soft(Math.max(0, Math.min(1, t)));
  const target = shot.camera?.target ?? [0.5, 0.5];
  const origin = `${target[0] * 100}% ${target[1] * 100}%`;
  switch (shot.camera?.move) {
    case "push-in": return { transform: `scale(${1 + 0.08 * e})`, origin };
    case "pull-out": return { transform: `scale(${1.1 - 0.1 * e})`, origin };
    case "pan-left": return { transform: `scale(1.06) translateX(${2.5 - 5 * e}%)`, origin };
    case "pan-right": return { transform: `scale(1.06) translateX(${-2.5 + 5 * e}%)`, origin };
    case "rise": return { transform: `scale(1.05) translateY(${2.5 - 5 * e}%)`, origin };
    case "drift": return { transform: `scale(1.03) translate(${Math.sin(t * 3) * 0.6}%, ${Math.cos(t * 2.4) * 0.5}%)`, origin };
    default: return { transform: "none", origin };
  }
}

const Captions: React.FC<{ spec: VideoSpec; timeline: Timeline; fmt: Format }> = ({ spec, timeline, fmt }) => {
  const frame = useCurrentFrame();
  const p = paletteFor(spec.world);
  for (const t of timeline.shots) {
    if (frame < t.startFrame || frame >= t.startFrame + t.durationFrames) continue;
    const shot = spec.shots.find((s) => s.id === t.id);
    if (!shot) return null;
    if (shot.narration && t.narration) {
      const chunk = captionChunks(shot.narration, t.narration.startFrame, t.narration.durationFrames).find((c) => frame >= c.startFrame && frame < c.startFrame + c.durationFrames);
      if (chunk) return <CaptionBand text={chunk.text} p={p} fmt={fmt} local={frame - chunk.startFrame} len={chunk.durationFrames} />;
    }
    if (shot.lyric && shot.visual.type !== "kinetic" && t.lyric.length) {
      const from = t.lyric[0].frame, to = t.startFrame + t.durationFrames;
      if (frame >= from - 4) return <CaptionBand text={shot.lyric} p={p} fmt={fmt} local={frame - from + 4} len={to - from} lyric />;
    }
    return null;
  }
  return null;
};
