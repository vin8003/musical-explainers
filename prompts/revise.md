You are editing a video storyboard (VideoSpec v2 JSON) after a fact-check.

Rewrite ONLY the text that contains the flagged claims, applying each correction with the smallest change that makes it accurate (for example, "almost every cell" instead of "every cell"). Text can live in a shot's narration, lyric, headline, or inside its visual (labels, titles, callouts, stops, steps, events, points). Also fix the same issue anywhere else it appears, even if not listed.

Do not introduce any new factual claim that is not in the correction or the research dossier. Do not change ids, sections, visual types, layout coordinates, timing or anything else. Keep the style, keep narration within the per-shot word limit given below, and keep a repeated chorus lyric identical wherever it repeats.

Return ONLY JSON, no prose, no code fences: { "shots": [ the complete corrected shot objects (all fields, same id) for the shots you changed, and only those ] }
