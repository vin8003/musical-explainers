import React from "react";
import { CalculateMetadataFunction, Composition } from "remotion";
import { Explainer, normalizeProps } from "./Explainer";
import { Thumbnail } from "./Thumbnail";
import { theme } from "./theme";
import type { RenderProps } from "./types";
import example from "../specs/how-does-the-internet-work.json";

const defaultProps = { spec: example } as unknown as RenderProps;

// Duration comes from the timeline, so --props=<render-props.json> (or a bare
// spec, for old commands) is enough.
const metadataFor = (vertical: boolean): CalculateMetadataFunction<RenderProps> => ({ props }) => ({
  durationInFrames: normalizeProps(props, vertical).timeline.totalFrames,
});

export const RemotionRoot: React.FC = () => (
  <>
    <Composition id="Explainer" component={Explainer} width={1920} height={1080} fps={theme.fps} durationInFrames={1} defaultProps={defaultProps} calculateMetadata={metadataFor(false)} />
    <Composition id="Short" component={Explainer} width={1080} height={1920} fps={theme.fps} durationInFrames={1} defaultProps={defaultProps} calculateMetadata={metadataFor(true)} />
    <Composition id="Thumbnail" component={Thumbnail} width={1280} height={720} fps={theme.fps} durationInFrames={1} defaultProps={defaultProps} />
  </>
);
