You write the script for ONE format of a musical explainer video for curious people of all ages. The research dossier and the approved outline below are binding: follow the outline's beats in order, teach what each beat says, and state only what the dossier's supported or qualified claims support (keep qualifications). The goal is that the viewer understands the mechanism, not that they memorize terms.

Return ONLY a JSON object, no prose, no code fences:

{
  "slug": string, "title": string,
  "brief": { "audience": string, "learningGoal": string (one sentence: what the viewer can explain afterwards), "hook": string },
  "world": "night" | "cell" | "sky" | "paper",      // art direction: night = technology, cell = biology, sky = physics/space/weather, paper = history/maths
  "music": { "bpm": number (90-128), "key": "C"|"D"|"Eb"|"E"|"F"|"G"|"A"|"Bb", "mode": "major"|"minor", "mood": "bright"|"driving"|"calm"|"mysterious" },
  "shots": [ { "id": kebab-case, "section": "intro"|"verse"|"chorus"|"bridge"|"outro", "beat": string (outline beat id), "purpose": string, "narration"?: string, "lyric"?: string, "headline"?: string, "claims": [claim ids stated in this shot] } ]
}

Writing rules:
- Length: the format, target duration, allowed range and the delivery rate are given below. Aim for the target. Runtime is estimated from your narration at that rate plus musical time (each shot is rounded up to whole bars; sung chorus words take beats), so do not pad to reach it and do not cram to stay under it. If the material is thin, deepen the explanation with the dossier's examples and mechanism detail, never with repetition.
- One idea per shot. narration: spoken by a narrator, at most 3 short sentences and the per-shot word limit given below. Plain words, short sentences, every term explained in a phrase when first used.
- Causal language: say what causes what and why ("because", "so", "which means"). Prefer a concrete, specific example (real numbers from the dossier, a specific device, a specific molecule) over a generic statement. No empty hooks ("Have you ever wondered...?" with no content), no filler ("Let's dive in", "It's fascinating"), no summary that repeats without adding.
- Transitions connect ideas ("That raises a problem: ...") rather than announcing sections.
- The opening poses the outline's question specifically; the ending resolves it with the mental model.
- Music: a "chorus" shot has a "lyric" and no narration. Use the outline's chorus line if it has one; it must state the mechanism or mental model. Use as many chorus shots as genuinely help (none is fine for a Short); repeated identical chorus lyrics count toward runtime. Music must never replace explanation.
- headline: optional on-screen title for the shot, max 5 words, never a full sentence, and it must agree with the narration.
- claims: list the dossier claim ids each shot states. Do not state facts that are not in the dossier. Avoid "every/always/never/all" unless the dossier supports it literally. No invented numbers, names or specifics.
- Narration, headlines and claims must be consistent with each other.
