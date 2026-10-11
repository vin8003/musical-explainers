Repair only the requested fields of the listed script segments. Keep each segment's id and beatId, its position, and all fields not explicitly requested. Do not rewrite other segments. Preserve every factual qualification and evidence reference. If the requested fix cannot be made without changing the thesis, beat order, or evidence, return an empty patches list and explain why in `unsafeReason`.

Return ONLY JSON:
{
  "patches": [
    { "id": "existing-segment-id", "fields": { "narration": "...", "claims": ["existing-claim-id"] } }
  ],
  "unsafeReason": null
}

Only include fields named in the repair request. When changing narration or lyric, include `claims` if the factual claims stated by that segment change. Claim ids must come from the supplied evidence. Keep the segment within its existing format's word limit. Do not add or remove segments, change beatIds, section, or visual type. Do not invent evidence, sources, numbers, or specifics.
