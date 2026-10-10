import React from "react";
import { CalculateMetadataFunction, Composition } from "remotion";
import { Explainer, totalFrames } from "./Explainer";
import { theme } from "./theme";
import { VideoSpec } from "./types";
import example from "../specs/how-does-the-internet-work.json";

const defaultSpec = example as VideoSpec;

// Duration comes from the spec, so passing --props=specs/<slug>.json is enough.
const calculateMetadata: CalculateMetadataFunction<VideoSpec> = ({ props }) => ({
  durationInFrames: Math.max(1, totalFrames(props, theme.fps)),
});

export const RemotionRoot: React.FC = () => (
  <>
    <Composition
      id="Explainer"
      component={Explainer}
      width={1920}
      height={1080}
      fps={theme.fps}
      durationInFrames={1}
      defaultProps={defaultSpec}
      calculateMetadata={calculateMetadata}
    />
    <Composition
      id="Short"
      component={Explainer}
      width={1080}
      height={1920}
      fps={theme.fps}
      durationInFrames={1}
      defaultProps={defaultSpec}
      calculateMetadata={calculateMetadata}
    />
  </>
);
