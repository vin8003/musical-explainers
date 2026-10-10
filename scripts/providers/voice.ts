// Speech providers. The default is macOS `say` (local, free, no account),
// which is intelligible but clearly synthetic. ElevenLabs is optional, off by
// default, and only used when AUDIO_VOICE=elevenlabs and ELEVENLABS_API_KEY are
// both set (it costs money per character). "none" renders without narration.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PipelineError } from "../core/files";

export type VoiceProvider = {
  name: string;
  /** Licence/provenance note recorded in the audio manifest. */
  license: string;
  /** Renders text to an audio file at outPath (any format ffmpeg reads). */
  speak(text: string, outPath: string, opts?: { rate?: number }): Promise<void>;
  /** Cache key component: changes when voice settings change. */
  id: string;
};

const sayAvailable = () => process.platform === "darwin" && spawnSync("say", ["-v", "?"], { encoding: "utf8" }).status === 0;

function sayProvider(): VoiceProvider {
  const voice = process.env.VOICE_NAME ?? "Samantha";
  const rate = Number(process.env.VOICE_RATE ?? 172);
  return {
    name: "say",
    id: `say:${voice}:${rate}`,
    license: `macOS system voice "${voice}" via say (local). Check Apple's licence terms before commercial publication.`,
    async speak(text, outPath, opts) {
      mkdirSync(dirname(outPath), { recursive: true });
      const res = spawnSync("say", ["-v", voice, "-r", String(opts?.rate ?? rate), "-o", outPath, "--file-format=AIFF", text], { encoding: "utf8" });
      if (res.status !== 0 || !existsSync(outPath)) throw new PipelineError(`say failed: ${res.stderr}`, "external");
    },
  };
}

function elevenLabsProvider(): VoiceProvider {
  const key = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID ?? "21m00Tcm4TlvDq8ikWAM";
  if (!key) throw new PipelineError("AUDIO_VOICE=elevenlabs needs ELEVENLABS_API_KEY", "missing");
  return {
    name: "elevenlabs",
    id: `elevenlabs:${voiceId}`,
    license: "ElevenLabs TTS (paid plan required for commercial use; check your plan).",
    async speak(text, outPath) {
      // Untested in this repo (no key available while building it); kept minimal on purpose.
      const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: "POST",
        headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
        body: JSON.stringify({ text, model_id: process.env.ELEVENLABS_MODEL ?? "eleven_multilingual_v2" }),
      });
      if (!res.ok) throw new PipelineError(`ElevenLabs TTS failed: ${res.status} ${(await res.text()).slice(0, 200)}`, "external");
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, Buffer.from(await res.arrayBuffer()));
    },
  };
}

/** null means "no narration": the video renders with music only (reported as partial audio). */
export function getVoiceProvider(): VoiceProvider | null {
  const name = process.env.AUDIO_VOICE ?? (sayAvailable() ? "say" : "none");
  if (name === "none") return null;
  if (name === "say") {
    if (!sayAvailable()) throw new PipelineError("AUDIO_VOICE=say needs macOS `say`", "missing", "Set AUDIO_VOICE=none to render without narration.");
    return sayProvider();
  }
  if (name === "elevenlabs") return elevenLabsProvider();
  throw new PipelineError(`Unknown AUDIO_VOICE "${name}" (say, elevenlabs, none)`, "invalid");
}

export const voiceStatus = () => ({ say: sayAvailable(), elevenlabs: Boolean(process.env.ELEVENLABS_API_KEY), selected: process.env.AUDIO_VOICE ?? (sayAvailable() ? "say" : "none") });
