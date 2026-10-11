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

/**
 * Every Claude call in the pipeline, one row per step, so model and reasoning
 * effort can be tuned where it pays. Project rule: Sonnet is the ceiling (no
 * Opus); Haiku is the cheap option for mechanical steps.
 * `why` is the rationale behind the default and is shown in the admin panel.
 */
export const MODEL_STEPS = [
  { id: "research", label: "Research", stage: "research", tools: "web", why: "Judgement-heavy: qualifies the topic, picks the angle and builds the evidence dossier with web search. Everything downstream inherits its quality, and it runs once per topic." },
  { id: "outline", label: "Outline", stage: "outline", why: "Structure under a duration budget; the research already did the thinking, so medium effort is enough." },
  { id: "script", label: "Script", stage: "script", why: "The creative core (narration, lyric, claims). Quality here is what viewers hear, so it gets the most reasoning." },
  { id: "scriptFix", label: "Script length fix", stage: "script", why: "A precise numeric rewrite (add or cut N words) after a failed length check. Mechanical." },
  { id: "review", label: "Editorial review", stage: "script", why: "Judgement of the finished script against the thesis. A shallow reviewer approves bad scripts, so keep effort high." },
  { id: "factcheck", label: "Fact check", stage: "factcheck", tools: "web", why: "Verdict per claim with sources. Needs reliable search use and caution; many items per call, so medium rather than high." },
  { id: "revise", label: "Fact revision", stage: "factcheck", why: "Rewrites only flagged shots using given corrections. Narrow and mechanical." },
  { id: "direct", label: "Shot direction", stage: "direct", why: "Many batches of structured storyboard JSON validated by code (retried on error). The highest call volume, so this is the best place to save." },
  { id: "repair", label: "Output repair", stage: "any", why: "Fixes a small validation defect in an earlier reply by returning only the failing fields (or a reformatted object). Narrow and mechanical, so the cheapest setting is enough; it never replaces the model that generated the original." },
  { id: "visualReview", label: "Visual review", stage: "qa", tools: "images", why: "Looks at contact sheets and flags layout problems. Optional and run once per candidate; vision quality matters, so stay on Sonnet." },
];
export const MODEL_STEP_IDS = MODEL_STEPS.map((s) => s.id);
/** Aliases the CLI resolves to the newest model of that family. */
export const MODEL_CHOICES = Object.freeze(["sonnet", "haiku"]);
export const EFFORT_LEVELS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);
/** A full model id is also accepted when it is a Sonnet or Haiku (e.g. claude-sonnet-5-5). */
export const isAllowedModel = (m) => typeof m === "string" && (MODEL_CHOICES.includes(m) || /^claude-(sonnet|haiku)-[\w.-]+$/.test(m));

export const DEFAULT_SETTINGS = Object.freeze({
  version: SETTINGS_VERSION,
  models: Object.freeze({
    research: Object.freeze({ model: "sonnet", effort: "high" }),
    outline: Object.freeze({ model: "sonnet", effort: "medium" }),
    script: Object.freeze({ model: "sonnet", effort: "high" }),
    scriptFix: Object.freeze({ model: "sonnet", effort: "medium" }),
    review: Object.freeze({ model: "sonnet", effort: "high" }),
    factcheck: Object.freeze({ model: "sonnet", effort: "medium" }),
    revise: Object.freeze({ model: "sonnet", effort: "low" }),
    direct: Object.freeze({ model: "sonnet", effort: "low" }),
    repair: Object.freeze({ model: "sonnet", effort: "low" }),
    visualReview: Object.freeze({ model: "sonnet", effort: "medium" }),
  }),
  formats: Object.freeze({
    main: Object.freeze({ targetSeconds: 420, minSeconds: 300, maxSeconds: 600 }),
    short: Object.freeze({ targetSeconds: 45, minSeconds: 30, maxSeconds: 60 }),
  }),
  /** Usage budgets. null = unrestricted (never zero). Zero is a real zero allowance. See docs/usage-budgets.md. */
  budgets: Object.freeze({
    run: Object.freeze({ maxInputTokens: null, maxOutputTokens: null, maxEstimatedCost: null, maxCalls: null }),
    stage: Object.freeze({ maxInputTokens: null, maxOutputTokens: null, maxEstimatedCost: null, maxCalls: null }),
    repair: Object.freeze({ maxAttemptsPerOperation: 1, maxCallsPerRun: null }),
    warnings: Object.freeze({ usagePercent: 80 }),
    unknownUsage: "warn",
  }),
  narration: Object.freeze({
    /** Spoken words per minute used to estimate runtime before audio exists. */
    wordsPerMinute: 156,
    /** Acceptance window around the target: a script estimate, the measured audio and the rendered file must all be within this share of the target (and inside min-max). */
    targetTolerance: 0.15,
  }),
});

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
export const BUDGET_LIMIT_KEYS = ["maxInputTokens", "maxOutputTokens", "maxEstimatedCost", "maxCalls"];
export const UNKNOWN_USAGE_POLICIES = ["warn", "block"];
/** Hard ceiling on repair attempts per operation, whatever the setting says: no unbounded retry loops. */
export const MAX_REPAIR_ATTEMPTS_HARD = 3;
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
  if (s.models != null) {
    if (typeof s.models !== "object" || Array.isArray(s.models)) p.push("models must be an object");
    else
      for (const st of MODEL_STEPS) {
        const m = s.models[st.id];
        if (!m || typeof m !== "object") p.push(`${st.label}: model settings are missing`);
        else {
          if (!isAllowedModel(m.model)) p.push(`${st.label}: model must be ${MODEL_CHOICES.join(" or ")} (Opus is not allowed)`);
          if (!EFFORT_LEVELS.includes(m.effort)) p.push(`${st.label}: effort must be one of ${EFFORT_LEVELS.join(", ")}`);
        }
      }
  }
  p.push(...validateBudgets(s.budgets));
  const n = s.narration;
  if (!n || typeof n !== "object") p.push("narration is required");
  else {
    if (!isNum(n.wordsPerMinute) || n.wordsPerMinute < 60 || n.wordsPerMinute > 300) p.push("Narration rate must be 60-300 words per minute");
    if (!isNum(n.targetTolerance) || n.targetTolerance <= 0 || n.targetTolerance > 1) p.push("Target tolerance must be more than 0% and at most 100%");
  }
  return p;
}

const isEmpty = (v) => v === null || v === undefined || v === "";
const COUNT_KEYS = ["maxInputTokens", "maxOutputTokens", "maxCalls", "maxAttemptsPerOperation", "maxCallsPerRun"];

/** Budgets are optional: absent/null/"" = unrestricted. Zero is valid and means "allow none". */
export function validateBudgets(b) {
  const p = [];
  if (isEmpty(b)) return p;
  if (typeof b !== "object" || Array.isArray(b)) return ["budgets must be an object"];
  const limit = (where, key, v) => {
    if (isEmpty(v)) return;
    if (!isNum(v) || v < 0) return p.push(`Budget ${where} ${key} must be a number of 0 or more, or empty for no limit`);
    if (COUNT_KEYS.includes(key) && !Number.isInteger(v)) p.push(`Budget ${where} ${key} must be a whole number`);
  };
  for (const scope of ["run", "stage"]) {
    const x = b[scope];
    if (isEmpty(x)) continue;
    if (typeof x !== "object" || Array.isArray(x)) p.push(`Budget ${scope} must be an object`);
    else for (const k of BUDGET_LIMIT_KEYS) limit(scope, k, x[k]);
  }
  if (!isEmpty(b.repair)) {
    if (typeof b.repair !== "object") p.push("Budget repair must be an object");
    else for (const k of ["maxAttemptsPerOperation", "maxCallsPerRun"]) limit("repair", k, b.repair[k]);
  }
  if (!isEmpty(b.warnings?.usagePercent) && (!isNum(b.warnings.usagePercent) || b.warnings.usagePercent <= 0 || b.warnings.usagePercent > 100)) p.push("Budget warning threshold must be more than 0 and at most 100 percent");
  if (!isEmpty(b.unknownUsage) && !UNKNOWN_USAGE_POLICIES.includes(b.unknownUsage)) p.push(`Budget unknownUsage must be ${UNKNOWN_USAGE_POLICIES.join(" or ")}`);
  return p;
}

const lim = (v) => (isEmpty(v) ? null : v);
/** Canonical budgets: unknown keys dropped, empty -> null, missing parts take the (unrestricted) defaults. Invalid values are kept so validation can report them. */
export function normalizeBudgets(b) {
  const d = DEFAULT_SETTINGS.budgets;
  const scope = (x) => Object.fromEntries(BUDGET_LIMIT_KEYS.map((k) => [k, lim(x?.[k])]));
  return {
    run: scope(b?.run),
    stage: scope(b?.stage),
    repair: { maxAttemptsPerOperation: isEmpty(b?.repair?.maxAttemptsPerOperation) ? d.repair.maxAttemptsPerOperation : b.repair.maxAttemptsPerOperation, maxCallsPerRun: lim(b?.repair?.maxCallsPerRun) },
    warnings: { usagePercent: isEmpty(b?.warnings?.usagePercent) ? d.warnings.usagePercent : b.warnings.usagePercent },
    unknownUsage: isEmpty(b?.unknownUsage) ? d.unknownUsage : b.unknownUsage,
  };
}

/** The fields an admin can save, in canonical shape (unknown keys dropped). */
export function normalizeSettings(s) {
  const pick = (x) => ({ targetSeconds: x?.targetSeconds, minSeconds: x?.minSeconds, maxSeconds: x?.maxSeconds });
  return {
    version: SETTINGS_VERSION,
    formats: { main: pick(s?.formats?.main), short: pick(s?.formats?.short) },
    narration: { wordsPerMinute: s?.narration?.wordsPerMinute, targetTolerance: s?.narration?.targetTolerance },
    budgets: normalizeBudgets(s?.budgets),
    // Model choices are optional input: any step not given keeps its default.
    models: Object.fromEntries(MODEL_STEPS.map((st) => [st.id, { ...DEFAULT_SETTINGS.models[st.id], ...pickModel(s?.models?.[st.id]) }])),
  };
}
const pickModel = (x) => Object.fromEntries(["model", "effort"].filter((k) => x && k in x).map((k) => [k, x[k]]));

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
    models: raw.models,
    budgets: raw.budgets,
  });
  const problems = validateSettings(merged);
  if (problems.length) {
    warnings.push(`config/settings.json is invalid (${problems.join("; ")}); using the defaults until it is saved again`);
    return { settings: clone(DEFAULT_SETTINGS), source: "defaults", warnings };
  }
  // Models are optional in the file: an older file without them is not "partial".
  const partial = FORMATS.some((f) => !raw.formats?.[f]) || !raw.narration;
  if (partial) warnings.push("config/settings.json is missing some sections; defaults fill the gaps");
  return { settings: merged, source: partial ? "file+defaults" : "file", warnings };
}

/** What a script, its audio and its render depend on for one format: changing this invalidates them. */
export function formatKey(settings, format) {
  const f = settings.formats[format];
  return `${format}:${f.targetSeconds}/${f.minSeconds}-${f.maxSeconds}@${settings.narration.wordsPerMinute}wpm±${settings.narration.targetTolerance}`;
}

/**
 * Product rule: the target is an acceptance criterion, not a preference.
 * min/max are absolute bounds; the tolerance window around the target is what
 * a finished cut must land in. "short", "long" and "off-target" all block.
 */
export const BLOCKING_VERDICTS = ["short", "long", "off-target"];
export const isBlocking = (verdict) => BLOCKING_VERDICTS.includes(verdict);

/**
 * Spoken words to add (positive) or cut (negative) to move a measured cut to
 * its target. Music, sung chorus, transitions and tails stay as they are, so
 * the whole deficit has to come from narration: words = deficit x the measured
 * delivery rate (not scaled by the narration share of the video).
 */
export function wordsToTarget({ seconds, targetSeconds, measuredWpm }, fallbackWpm) {
  const wpm = isNum(measuredWpm) && measuredWpm > 0 ? measuredWpm : fallbackWpm;
  return Math.round(((targetSeconds - seconds) * wpm) / 60);
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
