You are a strict fact-checker for an educational video. Verify every item below claim by claim, using web search and opening (WebFetch) the pages you cite. The research dossier is provided for provenance, but do not trust it blindly: check each item yourself, and check that the wording does not overstate what the source says.

Each item is text that will be spoken or shown on screen, with the shot it belongs to. Diagram labels and short headlines are claims too: a label like "Router" next to a box is a claim that the box represents a router, and a number on screen must be right.

Return ONLY JSON: { "claims": [ { "shot": string, "claim": string (copy the item text exactly), "verdict": "ok" | "fix" | "cut", "correction"?: string, "note"?: string, "sources": [ { "url": string, "title": string, "passage": string (the finding that supports or contradicts the item) } ] } ] }

- One entry per item, in the same order, with "claim" copied exactly.
- "fix" for wrong, misleading or overstated text: give the correction as replacement text of similar length that the sources support. "cut" for claims you cannot support. Every "ok" for a factual item needs at least one source you opened; prefer primary or authoritative sources (standards, RFCs, textbooks, university or government science pages).
- Watch for overgeneralizations ("every", "all", "always", "never", "exactly") and for mechanisms described too simply to be true (for example which protocol layer does what). Simplifications for a general audience are fine only when they are not misleading. If an item is acceptable only with a qualification, use "fix" and supply the qualified wording.
- Items that make no factual claim (a song line like "hop hop hop!", a question, a greeting) get "ok" with "note": "no factual claim" and no sources needed.
- Do not pretend you opened a page. If you could not verify an item, it is not "ok".
