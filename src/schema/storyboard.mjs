// Storyboard schema (VideoSpec v2): the single source of truth for what a
// video looks and sounds like. Plain ESM so the Remotion bundle, the pipeline
// (tsx) and the admin server (plain node) all share one validator.
//
// Every field either changes the render/audio, or is listed in EDITORIAL as
// metadata that reviewers and the QA prompt read but the renderer ignores.

export const SCHEMA_VERSION = 2;

export const SECTIONS = ["intro", "verse", "chorus", "bridge", "outro"];
export const WORLDS = ["night", "cell", "sky", "paper"];
export const MOODS = ["bright", "driving", "calm", "mysterious"];
export const KEYS = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
export const CAMERA_MOVES = ["static", "push-in", "pull-out", "pan-left", "pan-right", "rise", "drift"];
export const TRANSITIONS = ["cut", "fade", "wipe", "push", "zoom"];
export const MASCOT_MOODS = ["happy", "wow", "thinking", "pointing"];
export const SFX = ["pop", "whoosh", "blip", "hit", "riser", "chime"];
export const LINK_STYLES = ["cable", "wireless", "undersea", "dashed"];
export const JOURNEY_SCENES = ["home", "city", "coast", "ocean", "seafloor", "datacenter", "space", "cell"];
export const KINETIC_STYLES = ["stack", "wave", "punch"];
export const COLORS = ["primary", "secondary", "accent", "warm", "cool"];

// Code-drawn illustrations shipped in src/assets/icons.tsx. They are original
// work in this repo (no third-party licence). External files live in
// assets/manifest.json and are referenced as "file:<id>".
export const ICONS = [
  "laptop", "phone", "router", "server", "cloud", "tower", "satellite", "globe", "packet",
  "video", "cat", "house", "building", "wifi", "lock", "cable", "cell", "mitochondrion",
  "atp", "glucose", "oxygen", "dna", "bacterium", "nucleus", "heart", "muscle", "skin",
  "lightning", "sun", "leaf", "clock", "magnifier", "question", "star", "check", "book",
  "fish", "ship", "battery", "flame",
];

/** Visual systems the renderer implements, with the fields each one reads. */
export const VISUALS = {
  title: "Opening or closing card: kicker, title, subtitle, hero icon with light rays.",
  kinetic: "Kinetic typography of the lyric/headline, words land on beats. Styles: stack, wave, punch.",
  network: "Process diagram: nodes (icons) on a 0-100 grid, links, packets travelling along routes.",
  packetize: "A file splits into numbered packets (split) or packets arrive shuffled and reassemble (reassemble).",
  anatomy: "Close-up of one subject with labelled callouts pointing at its parts.",
  journey: "Side-scrolling parallax trip through environments (home, city, coast, ocean, seafloor...) with a traveller.",
  flow: "Transformation: inputs flow into a machine and come out as outputs.",
  population: "Quantity comparison: groups with many copies of an icon, counts animate up.",
  comparison: "Two-column contrast with icons and bullet points.",
  timeline: "Events on a time axis that draws itself.",
  steps: "Numbered sequence of icons that light up one by one (good for recaps).",
  character: "The mascot explains one idea in a speech bubble, holding a prop icon.",
  scene3d: "Optional pre-rendered Blender clip (see SCENES_3D). Needs a `fallback` visual used when Blender is unavailable.",
};

/** 3D scenes the optional Blender backend can render (scripts/blender/). */
export const SCENES_3D = {
  "fiber-packets": "Light pulses (bits) racing through the glass fibres of a cut-away undersea cable; camera starts on the cable end and travels with the pulses. 10 s.",
};

export const EDITORIAL = ["brief", "purpose", "notes", "direction", "editorial", "claims"];

/** A storyboard is written for one format; older storyboards (no format) serve both cuts. */
export const SPEC_FORMATS = ["main", "short"];

/** Named points on built-in subjects for anatomy callouts (x, y in 0-1 of the subject box). */
export const ANCHORS = {
  packet: { header: [0.5, 0.16], "from-address": [0.3, 0.2], "to-address": [0.72, 0.2], sequence: [0.88, 0.1], payload: [0.5, 0.66] },
  mitochondrion: { "outer-membrane": [0.5, 0.05], "inner-membrane": [0.28, 0.4], cristae: [0.42, 0.5], matrix: [0.66, 0.38], dna: [0.7, 0.62] },
  cell: { nucleus: [0.46, 0.46], mitochondria: [0.7, 0.6], membrane: [0.08, 0.5], cytoplasm: [0.3, 0.7] },
  router: { antenna: [0.27, 0.2], lights: [0.66, 0.63], ports: [0.32, 0.66] },
  phone: { screen: [0.5, 0.4], antenna: [0.5, 0.12] },
  laptop: { screen: [0.5, 0.4], keyboard: [0.5, 0.72] },
  atp: { phosphates: [0.5, 0.2], energy: [0.5, 0.5] },
  globe: { ocean: [0.4, 0.66], land: [0.7, 0.6] },
};

export const resolveAnchor = (subject, c) => {
  const a = c?.anchor && ANCHORS[subject]?.[c.anchor];
  return a ? { x: a[0], y: a[1] } : { x: c?.x, y: c?.y };
};

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const isStr = (v) => typeof v === "string" && v.trim().length > 0;
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function iconOk(v) {
  return typeof v === "string" && (ICONS.includes(v) || /^file:[a-z0-9-]+$/.test(v));
}

function checkVisual(v, at, p) {
  if (!isObj(v)) return p(`${at}: visual is required`);
  if (!(v.type in VISUALS)) return p(`${at}: visual.type must be one of ${Object.keys(VISUALS).join(", ")}`);
  const icon = (x, where) => { if (!iconOk(x)) p(`${at}: ${where} "${x}" is not a known icon (see ICONS) or file:<asset-id>`); };
  const list = (x, where, min, max) => {
    if (!Array.isArray(x) || x.length < min || x.length > max) { p(`${at}: ${where} must be a list of ${min}-${max} items`); return false; }
    return true;
  };
  switch (v.type) {
    case "title":
      if (!isStr(v.title)) p(`${at}: title.title is required`);
      if (v.icon != null) icon(v.icon, "icon");
      break;
    case "kinetic":
      if (v.style != null && !KINETIC_STYLES.includes(v.style)) p(`${at}: kinetic.style must be one of ${KINETIC_STYLES.join(", ")}`);
      if (v.lines != null && list(v.lines, "kinetic.lines", 1, 4)) v.lines.forEach((l, i) => { if (!isStr(l)) p(`${at}: kinetic.lines[${i}] must be text`); });
      break;
    case "network": {
      if (list(v.nodes, "network.nodes", 2, 9)) {
        const ids = new Set();
        v.nodes.forEach((n, i) => {
          if (!isObj(n) || !ID_RE.test(n.id ?? "")) p(`${at}: nodes[${i}].id must be kebab-case`);
          else if (ids.has(n.id)) p(`${at}: duplicate node id ${n.id}`);
          else ids.add(n.id);
          icon(n?.icon, `nodes[${i}].icon`);
          if (!isNum(n?.x) || n.x < 0 || n.x > 100 || !isNum(n?.y) || n.y < 0 || n.y > 100) p(`${at}: nodes[${i}] needs x and y in 0-100`);
        });
        (v.links ?? []).forEach((l, i) => {
          if (!ids.has(l?.from) || !ids.has(l?.to)) p(`${at}: links[${i}] must join two node ids`);
          if (l?.style != null && !LINK_STYLES.includes(l.style)) p(`${at}: links[${i}].style must be one of ${LINK_STYLES.join(", ")}`);
        });
        (v.packets ?? []).forEach((k, i) => {
          if (!Array.isArray(k?.route) || k.route.length < 2 || !k.route.every((r) => ids.has(r))) p(`${at}: packets[${i}].route must list 2+ node ids`);
          else for (let j = 1; j < k.route.length; j++) {
            const a = k.route[j - 1], b = k.route[j];
            if (!(v.links ?? []).some((l) => (l.from === a && l.to === b) || (l.from === b && l.to === a))) p(`${at}: packets[${i}] hops ${a} -> ${b} but there is no link between them`);
          }
          if (k?.color != null && !COLORS.includes(k.color)) p(`${at}: packets[${i}].color must be one of ${COLORS.join(", ")}`);
        });
        (v.highlight ?? []).forEach((h) => { if (!ids.has(h)) p(`${at}: highlight "${h}" is not a node id`); });
      }
      break;
    }
    case "packetize":
      if (!["split", "reassemble"].includes(v.mode)) p(`${at}: packetize.mode must be split or reassemble`);
      if (!isObj(v.source)) p(`${at}: packetize.source {icon,label} is required`);
      else icon(v.source.icon, "source.icon");
      if (!isNum(v.count) || v.count < 3 || v.count > 12) p(`${at}: packetize.count must be 3-12`);
      break;
    case "anatomy":
      icon(v.subject, "subject");
      if (list(v.callouts, "anatomy.callouts", 1, 5))
        v.callouts.forEach((c, i) => {
          if (!isStr(c?.label)) p(`${at}: callouts[${i}].label is required`);
          const pt = resolveAnchor(v.subject, c);
          if (c?.anchor && !ANCHORS[v.subject]?.[c.anchor]) p(`${at}: callouts[${i}].anchor "${c.anchor}" is not defined for ${v.subject} (${Object.keys(ANCHORS[v.subject] ?? {}).join(", ") || "use x,y"})`);
          else if (!isNum(pt.x) || !isNum(pt.y) || pt.x < 0 || pt.x > 1 || pt.y < 0 || pt.y > 1) p(`${at}: callouts[${i}] needs an anchor or x,y in 0-1 on the subject`);
        });
      break;
    case "journey":
      if (list(v.stops, "journey.stops", 2, 6)) v.stops.forEach((s, i) => {
        if (!JOURNEY_SCENES.includes(s?.scene)) p(`${at}: stops[${i}].scene must be one of ${JOURNEY_SCENES.join(", ")}`);
        if (!isStr(s?.label)) p(`${at}: stops[${i}].label is required`);
      });
      if (!isObj(v.traveller)) p(`${at}: journey.traveller {icon} is required`);
      else icon(v.traveller.icon, "traveller.icon");
      break;
    case "flow":
      for (const k of ["inputs", "outputs"]) if (list(v[k], `flow.${k}`, 1, 3)) v[k].forEach((x, i) => icon(x?.icon, `${k}[${i}].icon`));
      if (!isObj(v.machine)) p(`${at}: flow.machine {icon,label} is required`);
      else icon(v.machine.icon, "machine.icon");
      break;
    case "population":
      if (list(v.groups, "population.groups", 1, 3)) v.groups.forEach((g, i) => {
        if (!isStr(g?.label)) p(`${at}: groups[${i}].label is required`);
        icon(g?.icon, `groups[${i}].icon`);
        if (!isNum(g?.count) || g.count < 1 || g.count > 60) p(`${at}: groups[${i}].count (icons drawn) must be 1-60`);
      });
      break;
    case "comparison":
      for (const k of ["left", "right"]) {
        if (!isObj(v[k]) || !isStr(v[k].title)) p(`${at}: comparison.${k}.title is required`);
        else { if (v[k].icon != null) icon(v[k].icon, `${k}.icon`); if (v[k].points != null) list(v[k].points, `${k}.points`, 0, 3); }
      }
      break;
    case "timeline":
      if (list(v.events, "timeline.events", 2, 5)) v.events.forEach((e, i) => { if (!isStr(e?.label) || !isStr(e?.when)) p(`${at}: events[${i}] needs label and when`); });
      break;
    case "steps":
      if (list(v.steps, "steps.steps", 2, 5)) v.steps.forEach((s, i) => { icon(s?.icon, `steps[${i}].icon`); if (!isStr(s?.label)) p(`${at}: steps[${i}].label is required`); });
      break;
    case "scene3d":
      if (!(v.scene in SCENES_3D)) p(`${at}: scene3d.scene must be one of ${Object.keys(SCENES_3D).join(", ")}`);
      if (!isObj(v.fallback) || v.fallback.type === "scene3d") p(`${at}: scene3d needs a non-3D fallback visual`);
      else checkVisual(v.fallback, `${at} fallback`, p);
      break;
    case "character":
      if (!isStr(v.say)) p(`${at}: character.say is required`);
      if (v.prop != null) icon(v.prop, "prop");
      break;
  }
}

/** Throws nothing; returns a list of human-readable problems (empty = valid). */
export function validateSpec(spec, { slug } = {}) {
  const problems = [];
  const p = (m) => problems.push(m);
  if (!isObj(spec)) return ["Spec must be a JSON object"];
  if (spec.schemaVersion !== SCHEMA_VERSION) p(`schemaVersion must be ${SCHEMA_VERSION} (v1 specs are migrated with migrateSpec)`);
  if (slug && spec.slug !== slug) p(`slug must stay "${slug}"`);
  if (!ID_RE.test(spec.slug ?? "")) p("slug must be kebab-case");
  if (!isStr(spec.title)) p("title is required");
  if (spec.world != null && !WORLDS.includes(spec.world)) p(`world must be one of ${WORLDS.join(", ")}`);
  if (spec.format != null && !SPEC_FORMATS.includes(spec.format)) p(`format must be one of ${SPEC_FORMATS.join(", ")}`);
  if (spec.editorial != null && !isObj(spec.editorial)) p("editorial must be an object");
  if (spec.direction != null && (!isObj(spec.direction) || !["draft", "directed"].includes(spec.direction.status))) p("direction.status must be draft or directed");
  const m = spec.music;
  if (!isObj(m)) p("music {bpm} is required");
  else {
    if (!isNum(m.bpm) || m.bpm < 60 || m.bpm > 180) p("music.bpm must be 60-180");
    if (m.key != null && !KEYS.includes(m.key)) p(`music.key must be one of ${KEYS.join(" ")}`);
    if (m.mode != null && !["major", "minor"].includes(m.mode)) p("music.mode must be major or minor");
    if (m.mood != null && !MOODS.includes(m.mood)) p(`music.mood must be one of ${MOODS.join(", ")}`);
    if (m.songSrc != null && !/^[\w./-]+\.(mp3|wav|m4a|aac|ogg)$/.test(m.songSrc)) p("music.songSrc must be a path under public/ to an audio file");
  }
  if (!Array.isArray(spec.shots) || !spec.shots.length) {
    p("shots must be a non-empty list");
    return problems;
  }
  const ids = new Set();
  spec.shots.forEach((s, i) => {
    const at = `shot ${i + 1}${s?.id ? ` (${s.id})` : ""}`;
    if (!isObj(s)) return p(`${at}: must be an object`);
    if (!ID_RE.test(s.id ?? "")) p(`${at}: id must be kebab-case`);
    else if (ids.has(s.id)) p(`${at}: duplicate id`);
    ids.add(s.id);
    if (!SECTIONS.includes(s.section)) p(`${at}: section must be one of ${SECTIONS.join(", ")}`);
    for (const k of ["narration", "lyric", "headline", "purpose"]) if (s[k] != null && typeof s[k] !== "string") p(`${at}: ${k} must be text`);
    if (!isStr(s.narration) && !isStr(s.lyric) && s.visual?.type !== "title") p(`${at}: needs narration or a lyric`);
    if (isStr(s.headline) && s.headline.split(/\s+/).length > 8) p(`${at}: headline is over 8 words; keep on-screen text short`);
    if (s.minBars != null && (!isNum(s.minBars) || s.minBars < 1 || s.minBars > 16)) p(`${at}: minBars must be 1-16`);
    if (s.camera != null && (!isObj(s.camera) || !CAMERA_MOVES.includes(s.camera.move))) p(`${at}: camera.move must be one of ${CAMERA_MOVES.join(", ")}`);
    if (s.transition != null && !TRANSITIONS.includes(s.transition)) p(`${at}: transition must be one of ${TRANSITIONS.join(", ")}`);
    if (s.mascot != null && (!isObj(s.mascot) || !MASCOT_MOODS.includes(s.mascot.mood))) p(`${at}: mascot.mood must be one of ${MASCOT_MOODS.join(", ")}`);
    (s.accents ?? []).forEach((a, j) => {
      if (!isNum(a?.beat) || a.beat < 0) p(`${at}: accents[${j}].beat must be >= 0`);
      if (a?.sfx != null && !SFX.includes(a.sfx)) p(`${at}: accents[${j}].sfx must be one of ${SFX.join(", ")}`);
    });
    if (s.claims != null && (!Array.isArray(s.claims) || !s.claims.every((c) => typeof c === "string"))) p(`${at}: claims must be a list of research claim ids`);
    (s.assets ?? []).forEach((a, j) => { if (!ID_RE.test(a?.id ?? "")) p(`${at}: assets[${j}].id must be kebab-case`); });
    checkVisual(s.visual, at, p);
  });
  return problems;
}

/** Shot-to-shot lint: things that are legal but make a weak video. */
export function lintSpec(spec) {
  const warnings = [];
  const shots = spec.shots ?? [];
  for (let i = 1; i < shots.length; i++) {
    const a = shots[i - 1].visual?.type, b = shots[i].visual?.type;
    if (a && a === b && a !== "network") warnings.push(`shots ${i} and ${i + 1} both use "${a}"; vary the treatment unless it is a deliberate continuation`);
  }
  for (const s of shots) {
    const labels = (s.visual?.nodes ?? []).map((n) => n.label).filter(Boolean);
    const dup = labels.filter((l, i) => labels.indexOf(l) !== i && l !== "Router");
    if (dup.length) warnings.push(`shot ${s.id}: node label "${dup[0]}" is repeated; repeated labels read as the same thing`);
  }
  const counts = {};
  for (const s of shots) counts[s.visual?.type] = (counts[s.visual?.type] ?? 0) + 1;
  for (const [t, n] of Object.entries(counts)) if (shots.length >= 6 && n / shots.length > 0.4) warnings.push(`"${t}" is used in ${n} of ${shots.length} shots`);
  const mascots = shots.filter((s) => s.mascot || s.visual?.type === "character").length;
  if (shots.length >= 6 && mascots / shots.length > 0.35) warnings.push(`the mascot appears in ${mascots} of ${shots.length} shots; keep it for moments that need a guide`);
  if (!shots.some((s) => s.section === "chorus")) warnings.push("no chorus shot: the key idea never gets its musical hook");
  if (!spec.format && !shots.some((s) => s.short)) warnings.push("no shot is marked short: the vertical cut will be chosen automatically");
  return warnings;
}

/** Converts a v1 spec ({bpm, scenes}) into a v2 storyboard with simple treatments. */
export function migrateSpec(spec) {
  if (spec?.schemaVersion === SCHEMA_VERSION) return spec;
  if (!Array.isArray(spec?.scenes)) return spec;
  const sectionFor = { hook: "intro", beat: "verse", chorus: "chorus", recap: "outro" };
  const seen = {};
  return {
    schemaVersion: SCHEMA_VERSION,
    slug: spec.slug,
    title: spec.title,
    world: "night",
    music: { bpm: spec.bpm ?? 120, beatOffsetMs: spec.beatOffsetMs, songSrc: spec.songSrc, mode: "major", mood: "bright" },
    shots: spec.scenes.map((sc) => {
      const base = (sc.kind ?? "beat") + "";
      seen[base] = (seen[base] ?? 0) + 1;
      const chorus = sc.kind === "chorus";
      return {
        id: `${base}-${seen[base]}`,
        section: sectionFor[sc.kind] ?? "verse",
        purpose: "Migrated from a v1 scene",
        headline: chorus || String(sc.text).split(/\s+/).length > 8 ? undefined : sc.text,
        narration: chorus ? undefined : sc.caption ?? sc.text,
        lyric: chorus ? sc.text : undefined,
        minBars: Math.max(1, Math.round((sc.durationBeats ?? 8) / 4)),
        visual: chorus ? { type: "kinetic", style: "punch" } : sc.kind === "hook" ? { type: "title", title: sc.text } : { type: "kinetic", style: "stack", lines: [sc.text] },
        short: true,
      };
    }),
  };
}

/** All on-screen and spoken text, for fact-checking and change detection. */
export function textOf(spec) {
  const out = [];
  for (const s of spec.shots ?? []) {
    const v = (s.visual?.type === "scene3d" ? s.visual.fallback : s.visual) ?? {};
    const labels = [
      v.title, v.subtitle, v.kicker, v.say, ...(v.lines ?? []),
      ...(v.nodes ?? []).map((n) => n.label), ...(v.packets ?? []).map((k) => k.label),
      v.source?.label, v.destination?.label, ...(v.callouts ?? []).map((c) => c.label),
      ...(v.stops ?? []).map((x) => x.label), v.stat?.label && `${v.stat.label}: ${v.stat.value}`,
      ...(v.inputs ?? []).map((x) => x.label), v.machine?.label, ...(v.outputs ?? []).map((x) => x.label),
      ...(v.groups ?? []).map((g) => `${g.label}${g.value ? `: ${g.value}` : ""}`),
      v.left?.title, ...(v.left?.points ?? []), v.right?.title, ...(v.right?.points ?? []),
      ...(v.events ?? []).map((e) => `${e.when}: ${e.label}`), ...(v.steps ?? []).map((x) => x.label),
    ].filter((x) => typeof x === "string" && x.trim());
    out.push({ shot: s.id, narration: s.narration ?? null, lyric: s.lyric ?? null, headline: s.headline ?? null, labels });
  }
  return out;
}
