// Production settings (config/settings.json): video format durations and the
// narration delivery rate used to estimate runtime. Plain ESM so the admin
// server (plain node) and the pipeline (tsx) share one validator, the same way
// they share the storyboard schema.
//
// The file only ever contains values an admin saved. Missing or malformed
// content falls back to DEFAULT_SETTINGS (with a warning), never to a guess.

export const SETTINGS_VERSION = 1;

/** Landscape ("main", 16:9) and Short ("short", 9:16). */
export const FORMATS = ["main", "short"];
export const FORMAT_LABEL = { main: "Landscape (16:9)", short: "Short (9:16)" };

export const DEFAULT_SETTINGS = Object.freeze({
  version: SETTINGS_VERSION,
  formats: Object.freeze({
    main: Object.freeze({ targetSeconds: 420, minSeconds: 300, maxSeconds: 600 }),
    short: Object.freeze({ targetSeconds: 45, minSeconds: 30, maxSeconds: 60 }),
  }),
  narration: Object.freeze({
    /** Spoken words per minute used to estimate runtime before audio exists. */
    wordsPerMinute: 156,
    /** A script estimate further than this share from the target is flagged (it must still be inside min-max). */
    targetTolerance: 0.15,
  }),
});

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const clone = (v) => JSON.parse(JSON.stringify(v));

/**
 * Validates a full settings object. Returns a list of problems (empty = valid).
 * Nothing is clamped or corrected: an invalid value is an error the admin sees.
 */
export function validateSettings(s) {
  const p = [];
  if (!s || typeof s !== "object" || Array.isArray(s)) return ["Settings must be a JSON object"];
  if (!s.formats || typeof s.formats !== "object") p.push("formats is required");
  else
    for (const f of FORMATS) {
      const x = s.formats[f];
      const label = FORMAT_LABEL[f];
      if (!x || typeof x !== "object") {
        p.push(`${label}: settings are missing`);
        continue;
      }
      for (const k of ["targetSeconds", "minSeconds", "maxSeconds"])
        if (!isNum(x[k]) || x[k] <= 0) p.push(`${label}: ${k} must be a positive number of seconds`);
      if (isNum(x.minSeconds) && isNum(x.maxSeconds) && x.minSeconds > x.maxSeconds) p.push(`${label}: minimum (${fmt(x.minSeconds)}) is longer than maximum (${fmt(x.maxSeconds)})`);
      if (isNum(x.targetSeconds) && isNum(x.minSeconds) && x.targetSeconds < x.minSeconds) p.push(`${label}: target (${fmt(x.targetSeconds)}) is shorter than the minimum (${fmt(x.minSeconds)})`);
      if (isNum(x.targetSeconds) && isNum(x.maxSeconds) && x.targetSeconds > x.maxSeconds) p.push(`${label}: target (${fmt(x.targetSeconds)}) is longer than the maximum (${fmt(x.maxSeconds)})`);
      if (isNum(x.maxSeconds) && x.maxSeconds > 3 * 3600) p.push(`${label}: maximum must be at most 3 hours`);
    }
  const n = s.narration;
  if (!n || typeof n !== "object") p.push("narration is required");
  else {
    if (!isNum(n.wordsPerMinute) || n.wordsPerMinute < 60 || n.wordsPerMinute > 300) p.push("Narration rate must be 60-300 words per minute");
    if (!isNum(n.targetTolerance) || n.targetTolerance <= 0 || n.targetTolerance > 1) p.push("Target tolerance must be more than 0% and at most 100%");
  }
  return p;
}

/** The fields an admin can save, in canonical shape (unknown keys dropped). */
export function normalizeSettings(s) {
  const pick = (x) => ({ targetSeconds: x?.targetSeconds, minSeconds: x?.minSeconds, maxSeconds: x?.maxSeconds });
  return {
    version: SETTINGS_VERSION,
    formats: { main: pick(s?.formats?.main), short: pick(s?.formats?.short) },
    narration: { wordsPerMinute: s?.narration?.wordsPerMinute, targetTolerance: s?.narration?.targetTolerance },
  };
}

/**
 * Effective settings from whatever was read from disk (possibly null, legacy
 * or malformed). Missing sections take the defaults; an invalid file is
 * ignored as a whole (defaults used) and reported, so a half-valid file can
 * never produce an inconsistent range.
 */
export function resolveSettings(raw) {
  const warnings = [];
  if (raw == null) return { settings: clone(DEFAULT_SETTINGS), source: "defaults", warnings };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push("config/settings.json is not a JSON object; using the defaults");
    return { settings: clone(DEFAULT_SETTINGS), source: "defaults", warnings };
  }
  const merged = normalizeSettings({
    formats: {
      main: { ...DEFAULT_SETTINGS.formats.main, ...(raw.formats?.main ?? {}) },
      short: { ...DEFAULT_SETTINGS.formats.short, ...(raw.formats?.short ?? {}) },
    },
    narration: { ...DEFAULT_SETTINGS.narration, ...(raw.narration ?? {}) },
  });
  const problems = validateSettings(merged);
  if (problems.length) {
    warnings.push(`config/settings.json is invalid (${problems.join("; ")}); using the defaults until it is saved again`);
    return { settings: clone(DEFAULT_SETTINGS), source: "defaults", warnings };
  }
  const partial = FORMATS.some((f) => !raw.formats?.[f]) || !raw.narration;
  if (partial) warnings.push("config/settings.json is missing some sections; defaults fill the gaps");
  return { settings: merged, source: partial ? "file+defaults" : "file", warnings };
}

/** What a script, its audio and its render depend on for one format: changing this invalidates them. */
export function formatKey(settings, format) {
  const f = settings.formats[format];
  return `${format}:${f.targetSeconds}/${f.minSeconds}-${f.maxSeconds}@${settings.narration.wordsPerMinute}wpm±${settings.narration.targetTolerance}`;
}

/** Duration verdict for one format: "ok", "off-target" (inside the range, outside the tolerance), "short" or "long". */
export function checkDuration(seconds, settings, format) {
  const f = settings.formats[format];
  const tol = settings.narration.targetTolerance;
  if (!isNum(seconds)) return { verdict: "unknown", message: "duration unknown" };
  if (seconds < f.minSeconds) return { verdict: "short", message: `${fmt(seconds)} is shorter than the minimum ${fmt(f.minSeconds)}` };
  if (seconds > f.maxSeconds) return { verdict: "long", message: `${fmt(seconds)} is longer than the maximum ${fmt(f.maxSeconds)}` };
  const off = Math.abs(seconds - f.targetSeconds) / f.targetSeconds;
  if (off > tol) return { verdict: "off-target", message: `${fmt(seconds)} is ${Math.round(off * 100)}% from the ${fmt(f.targetSeconds)} target (tolerance ${Math.round(tol * 100)}%)` };
  return { verdict: "ok", message: `${fmt(seconds)} (target ${fmt(f.targetSeconds)}, allowed ${fmt(f.minSeconds)}-${fmt(f.maxSeconds)})` };
}

/** 425 -> "7:05". */
export function fmt(seconds) {
  if (!isNum(seconds)) return "?";
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
