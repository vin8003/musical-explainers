// Renders a VideoSpec: one Sequence per scene, each wrapped in BeatFlash,
// with the mascot on stage throughout. Scene lengths are in beats, so every
// cut lands on the beat of the song.
import React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile, useVideoConfig } from "remotion";
import { beatsToFrames } from "./beat";
import { BeatFlash } from "./components/BeatFlash";
import { Mascot, MascotMood } from "./components/Mascot";
import { TextPop } from "./components/TextPop";
import { sceneColor, theme } from "./theme";
import { SceneKind, VideoSpec } from "./types";

const moodFor: Record<SceneKind, MascotMood> = {
  hook: "wow",
  beat: "thinking",
  chorus: "happy",
  recap: "happy",
};

export const totalFrames = (spec: VideoSpec, fps: number) =>
  spec.scenes.reduce((sum, s) => sum + beatsToFrames(s.durationBeats, spec.bpm, fps), 0);

export const Explainer: React.FC<VideoSpec> = (spec) => {
  const { fps, width, height } = useVideoConfig();
  const vertical = height > width;

  let from = 0;
  const scenes = spec.scenes.map((scene, i) => {
    const duration = beatsToFrames(scene.durationBeats, spec.bpm, fps);
    const start = from;
    from += duration;
    const color = sceneColor[scene.kind];
    return (
      <Sequence key={i} from={start} durationInFrames={duration} name={`${scene.kind}: ${scene.text}`}>
        <BeatFlash bpm={spec.bpm} color={color} intensity={scene.kind === "chorus" ? 1.4 : 1}>
          <AbsoluteFill
            style={{
              flexDirection: vertical ? "column" : "row",
              alignItems: "center",
              justifyContent: "center",
              gap: vertical ? 40 : 60,
            }}
          >
            <Mascot bpm={spec.bpm} mood={moodFor[scene.kind]} size={vertical ? 320 : 280} />
            <div style={{ maxWidth: vertical ? "100%" : "60%" }}>
              <TextPop
                text={scene.text}
                caption={scene.caption}
                color={scene.kind === "chorus" ? theme.palette.primary : theme.palette.text}
                fontSize={vertical ? 96 : 100}
              />
            </div>
          </AbsoluteFill>
        </BeatFlash>
      </Sequence>
    );
  });

  return (
    <AbsoluteFill style={{ backgroundColor: theme.palette.background }}>
      {spec.songSrc ? <Audio src={staticFile(spec.songSrc)} /> : null}
      {scenes}
    </AbsoluteFill>
  );
};
