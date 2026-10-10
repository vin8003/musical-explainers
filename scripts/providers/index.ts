// Swappable music/voice providers. The default is a stub that makes no calls
// and costs nothing: videos render silent on the spec's bpm. ElevenLabs costing
// is deferred, so add a real provider here later and select it with
// AUDIO_PROVIDER=elevenlabs.
import type { VideoSpec } from "../../src/types";

export interface AudioProvider {
  name: string;
  addAudio(spec: VideoSpec): Promise<VideoSpec>;
}

const stub: AudioProvider = {
  name: "stub",
  async addAudio(spec) {
    console.log(`  [stub] no music/voiceover for ${spec.slug}; rendering silent at ${spec.bpm} bpm`);
    return spec;
  },
};

export function getAudioProvider(): AudioProvider {
  const name = process.env.AUDIO_PROVIDER ?? "stub";
  if (name === "stub") return stub;
  throw new Error(`Audio provider "${name}" is not implemented yet`);
}
