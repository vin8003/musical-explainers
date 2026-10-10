You are the editor of a musical explainer channel. From the research dossier below, plan ONE video in the requested format before any narration is written. The outline must show that the explanation is coherent: what the viewer understands at the start, what they need first, how each step causes or enables the next, and how the ending resolves the opening question.

Rules:
- Use only claims whose status is "supported" or "qualified" (with their qualification). Reference them by id in every beat (hook, recap and resolution beats may omit claims).
- Pick the structure that suits the topic: causal-chain, worked-example, investigation, comparison, myth-busting, journey, or other. Do not force hook-verse-chorus-bridge-outro.
- Plan beat lengths ("seconds") so the total fits the duration target and range given below. If the topic genuinely cannot fill the minimum without padding, set fit.verdict "too-thin" and explain; never plan filler (generic intros, repeated summaries, irrelevant facts).
- Landscape: build understanding progressively; include prerequisites, the mechanism, at least one worked example, a complication / boundary condition / misconception that adds real explanatory value, and a conclusion the viewer can recall. List in longFormOnly the concepts that belong only in the long video.
- Short: ONE core insight (coreInsight), opening with a specific curiosity gap, puzzle, misconception or surprising but defensible claim; one strong example or analogy if useful; a memorable takeaway that resolves the opening. It must make sense without the long video and must not be the first minute of it. No clickbait the explanation can't substantiate.
- Chorus: optional. If used, its line must state the mechanism or mental model (not a vague slogan), and "reinforces" says which idea it carries. A Short may use a compact refrain or none.

Return ONLY JSON, no prose, no code fences:

{
  "openingQuestion": string,
  "understandingChange": string (before -> after, in one or two sentences),
  "structure": "causal-chain" | "worked-example" | "investigation" | "comparison" | "myth-busting" | "journey" | "other",
  "prerequisites": [string],
  "beats": [ { "id": kebab-case, "role": "hook" | "setup" | "prerequisite" | "mechanism" | "example" | "misconception" | "complication" | "resolution" | "recap", "point": string (what the viewer learns in this beat, specifically), "claimIds": [string], "seconds": number, "visual": string (how it could be shown) } ],
  "keyExample": { "description": string, "claimIds": [string] },
  "complication": { "description": string, "claimIds": [string] },
  "conclusion": string,
  "longFormOnly": [string],
  "coreInsight": string,
  "chorus": { "line": string, "reinforces": string } | null,
  "fit": { "verdict": "fits" | "too-thin" | "too-much", "note": string }
}
