// Timeline: turns a storyboard plus measured narration lengths into frame
// positions. The audio stage and the renderer both use this, so music
// sections, chant words, SFX and cuts land on the same bar lines.

export const FPS = 30;
export const BEATS_PER_BAR = 4;
/** Narration starts this long after the cut, and the shot holds this long after it ends. */
export const NARRATION_LEAD_S = 0.35;
export const NARRATION_TAIL_S = 0.45;
export const TRANSITION_FRAMES = { cut: 0, fade: 12, wipe: 14, push: 14, zoom: 12 };

/**
 * Shots in a cut. A storyboard written for one format (spec.format) uses all
 * its shots. Older single storyboards cut the Short from shots marked `short`,
 * falling back to intro + chorus + outro.
 */
export function shotsFor(spec, format) {
  const shots = spec.shots ?? [];
  if (format !== "short" || spec.format === "short") return shots;
  const marked = shots.filter((s) => s.short);
  if (marked.length) return marked;
  const auto = shots.filter((s) => s.section === "intro" || s.section === "chorus" || s.section === "outro");
  return auto.length ? auto : shots.slice(0, 4);
}

/** Lyric words, with simple syllable counts so long words get two beats' worth of room. */
export function lyricWords(lyric) {
  return String(lyric ?? "").replace(/[^\w' -]/g, " ").split(/\s+/).filter(Boolean);
}

/**
 * @param spec      v2 storyboard
 * @param format    "main" | "short"
 * @param voice     { [shotId]: seconds } measured narration lengths (optional)
 * @param opts      { wordsPerMinute } delivery rate for shots without a measured length
 */
export function buildTimeline(spec, format = "main", voice = {}, fps = FPS, opts = {}) {
  const bpm = spec.music?.bpm ?? 120;
  const beatS = 60 / bpm;
  const barS = beatS * BEATS_PER_BAR;
  const fpb = (beatS * fps);
  const shots = shotsFor(spec, format);
  let beat = 0;
  const out = [];
  shots.forEach((s, index) => {
    const narr = typeof voice[s.id] === "number" ? voice[s.id] : s.narration ? estimateSpeechSeconds(s.narration, opts.wordsPerMinute) : 0;
    const needS = narr ? NARRATION_LEAD_S + narr + NARRATION_TAIL_S : 0;
    const words = lyricWords(s.lyric);
    // Chant: one word per beat, two per beat when the line is long.
    const perBeat = words.length > 8 ? 2 : 1;
    const lyricBeats = words.length ? Math.ceil(words.length / perBeat) + 1 : 0;
    const minBars = s.minBars ?? (s.visual?.type === "title" ? 2 : 2);
    const bars = Math.max(minBars, Math.ceil(needS / barS - 0.02), Math.ceil(lyricBeats / BEATS_PER_BAR));
    const startFrame = Math.round(beat * fpb);
    const endFrame = Math.round((beat + bars * BEATS_PER_BAR) * fpb);
    const lyricStartBeat = beat + (narr && words.length ? Math.ceil((needS) / beatS) : 0);
    out.push({
      id: s.id,
      index,
      section: s.section,
      startBeat: beat,
      bars,
      startFrame,
      durationFrames: endFrame - startFrame,
      transition: index === 0 ? "cut" : s.transition ?? defaultTransition(shots[index - 1], s),
      narration: narr ? { startFrame: startFrame + Math.round(NARRATION_LEAD_S * fps), durationFrames: Math.round(narr * fps), measured: typeof voice[s.id] === "number" } : null,
      lyric: words.map((w, i) => ({ word: w, beat: lyricStartBeat + i / perBeat, frame: Math.round((lyricStartBeat + i / perBeat) * fpb) })),
      accents: (s.accents ?? []).map((a) => ({ ...a, frame: Math.round((beat + a.beat) * fpb) })),
    });
    beat += bars * BEATS_PER_BAR;
  });
  return { format, fps, bpm, beatOffsetMs: spec.music?.beatOffsetMs ?? 0, framesPerBeat: fpb, totalBeats: beat, totalFrames: Math.max(1, Math.round(beat * fpb)), shots: out };
}

export const DEFAULT_WORDS_PER_MINUTE = 156;
export const wordCount = (text) => String(text ?? "").split(/\s+/).filter(Boolean).length;

/** Spoken length at the given delivery rate (default ~2.6 words a second), until real TTS lengths exist. */
export function estimateSpeechSeconds(text, wordsPerMinute = DEFAULT_WORDS_PER_MINUTE) {
  return Math.max(1, wordCount(text) / ((wordsPerMinute || DEFAULT_WORDS_PER_MINUTE) / 60));
}

/**
 * Estimated runtime of one cut before any audio exists: the real timeline
 * model (narration at the configured rate, lead/tail, whole bars, sung chorus
 * words on beats, minBars), so choruses and musical padding are counted.
 */
export function estimateRuntime(spec, format = "main", wordsPerMinute = DEFAULT_WORDS_PER_MINUTE) {
  const tl = buildTimeline(spec, format, {}, FPS, { wordsPerMinute });
  const shots = shotsFor(spec, format);
  const spokenWords = shots.reduce((n, s) => n + wordCount(s.narration), 0);
  const sungWords = shots.reduce((n, s) => n + lyricWords(s.lyric).length, 0);
  return {
    seconds: tl.totalFrames / tl.fps,
    spokenWords,
    sungWords,
    narrationSeconds: shots.reduce((n, s) => n + (s.narration ? estimateSpeechSeconds(s.narration, wordsPerMinute) : 0), 0),
    shots: shots.length,
    wordsPerMinute,
  };
}

function defaultTransition(prev, next) {
  if (next.section === "chorus" || prev.section === "chorus") return "zoom";
  if (prev.visual?.type === next.visual?.type) return "fade";
  return "push";
}

/** Narration split into caption chunks of at most ~7 words, timed by character share. */
export function captionChunks(text, startFrame, durationFrames) {
  const words = String(text ?? "").split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const chunks = [];
  let cur = [];
  for (const w of words) {
    cur.push(w);
    const long = cur.length >= 7 || (cur.length >= 4 && /[.,;:!?]$/.test(w));
    if (long) { chunks.push(cur.join(" ")); cur = []; }
  }
  if (cur.length) {
    if (cur.length <= 2 && chunks.length) chunks[chunks.length - 1] += " " + cur.join(" ");
    else chunks.push(cur.join(" "));
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  let f = startFrame;
  return chunks.map((c, i) => {
    const d = i === chunks.length - 1 ? startFrame + durationFrames - f : Math.round((c.length / total) * durationFrames);
    const chunk = { text: c, startFrame: f, durationFrames: Math.max(1, d) };
    f += d;
    return chunk;
  });
}
