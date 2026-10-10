// Effective production settings for one run. The admin panel saves
// config/settings.json; a job resolves and validates it ONCE when it starts
// (the admin passes that snapshot in PIPELINE_SETTINGS), records it in
// state.json, and every stage reads ctx.settings, so a settings change during
// a run only affects later jobs.
import { DEFAULT_SETTINGS, normalizeSettings, resolveSettings, validateSettings } from "../../src/schema/settings.mjs";
import type { Settings } from "../../src/schema/settings.mjs";
import { paths, PipelineError, readJson } from "./files";

export type SettingsSnapshot = { settings: Settings; source: string; warnings: string[]; at: string };

/** Current file settings (validated; defaults when missing or invalid). */
export function currentSettings(): SettingsSnapshot {
  const raw = readJson<unknown>(paths.settings, null);
  const r = resolveSettings(raw);
  return { ...r, at: new Date().toISOString() };
}

/** The snapshot this run uses: the one the admin handed over, else the file as of now. */
export function runSettings(env = process.env): SettingsSnapshot {
  if (env.PIPELINE_SETTINGS) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(env.PIPELINE_SETTINGS);
    } catch {
      throw new PipelineError("PIPELINE_SETTINGS is not valid JSON", "config");
    }
    const s = normalizeSettings((parsed as { settings?: unknown })?.settings ?? parsed);
    const problems = validateSettings(s);
    if (problems.length) throw new PipelineError(`The job's settings snapshot is invalid: ${problems.join("; ")}`, "config", "Fix the Video formats settings in the admin panel and start the job again.");
    return { settings: s, source: (parsed as { source?: string })?.source ?? "job snapshot", warnings: [], at: (parsed as { at?: string })?.at ?? new Date().toISOString() };
  }
  return currentSettings();
}

export { DEFAULT_SETTINGS };
