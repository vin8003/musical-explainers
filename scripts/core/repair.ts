// Token-conscious repair of a Claude JSON reply that failed to parse or validate.
// Pure functions (no I/O), so every rule is unit tested.
//
// Order of preference, cheapest first:
//   1. local repair of a formatting defect (no Claude call)
//   2. field repair: ask only for the failing fields, merge them back, re-run
//      the FULL validator on the merged object
//   3. full-object repair: only when the failures can't be attributed to
//      independent fields (the reason is recorded in the usage ledger)

/** Fixes only defects that have one unambiguous reading: raw control characters inside strings, and trailing commas. */
export function localRepairJson(text: string): { value: unknown; fixes: string[] } | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  const src = body.slice(start, end + 1);
  const fixes: string[] = [];
  let out = "";
  let inString = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inString) {
      if (c === "\\") { out += c + (src[++i] ?? ""); continue; }
      if (c === '"') { inString = false; out += c; continue; }
      if (c === "\n") { out += "\\n"; fixes.push("escaped a raw newline inside a string"); continue; }
      if (c === "\t") { out += "\\t"; fixes.push("escaped a raw tab inside a string"); continue; }
      if (c === "\r") { out += "\\r"; continue; }
      out += c;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === ",") {
      let j = i + 1;
      while (j < src.length && /\s/.test(src[j])) j++;
      if (src[j] === "}" || src[j] === "]") { fixes.push("removed a trailing comma"); continue; }
    }
    out += c;
  }
  if (!fixes.length) return null;
  try {
    return { value: JSON.parse(out), fixes: [...new Set(fixes)] };
  } catch {
    return null;
  }
}

export type FieldPlan = { safe: true; paths: string[]; byPath: Record<string, string[]> } | { safe: false; reason: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Where a validation message points: "claims[3] (c4): ..." -> "claims[3]"; "thesis: unknown claim id" -> "thesis"; "qualification.scores.depth must be 0-5" -> "qualification". */
export function problemPath(value: Record<string, unknown>, problem: string): string | null {
  const m = problem.match(/^([A-Za-z_][\w]*)(?:\[(\d+)\])?/);
  if (!m || !(m[1] in value)) return null;
  const field = value[m[1]];
  if (m[2] !== undefined) return Array.isArray(field) && isObj(field[Number(m[2])]) ? `${m[1]}[${m[2]}]` : null;
  // A bare array field ("claims must list at least 5") needs new content, not a fix to existing items.
  return Array.isArray(field) ? null : m[1];
}

/**
 * Decides whether the problems are confined to a few independent fields.
 * Unsafe when any problem can't be attributed, or the fields to resend are
 * most of the object (then a field repair saves nothing and is riskier).
 */
export function planFieldRepair(value: unknown, problems: string[], maxShare = 0.5): FieldPlan {
  if (!isObj(value)) return { safe: false, reason: "the reply is not a JSON object" };
  const byPath: Record<string, string[]> = {};
  for (const p of problems) {
    const path = problemPath(value, p);
    if (!path) return { safe: false, reason: `a problem is not attributable to one existing field: "${p.slice(0, 120)}"` };
    (byPath[path] ??= []).push(p);
  }
  const paths = Object.keys(byPath);
  const total = JSON.stringify(value).length;
  const part = paths.reduce((n, p) => n + JSON.stringify(getPath(value, p)).length, 0);
  if (total > 0 && part / total > maxShare) return { safe: false, reason: `the failing fields are ${Math.round((part / total) * 100)}% of the object` };
  return { safe: true, paths, byPath };
}

export function getPath(value: Record<string, unknown>, path: string): unknown {
  const m = path.match(/^([\w]+)(?:\[(\d+)\])?$/)!;
  const f = value[m[1]];
  return m[2] !== undefined ? (f as unknown[])[Number(m[2])] : f;
}

/** The compact prompt for a field repair. It carries the problems and the failing fields only, never the original prompt. */
export function fieldRepairPrompt(value: Record<string, unknown>, plan: Extract<FieldPlan, { safe: true }>, extra?: { context?: string; hint?: string }): string {
  return [
    "Some fields of a JSON object you produced failed validation. Return ONLY a JSON object of the form {\"patch\": {...}} whose keys are exactly these paths: " + plan.paths.join(", ") + ".",
    "For a path like claims[3], return the complete corrected element. Change only what is needed to fix the listed problems and keep every other value as it is. Do not invent sources, URLs, quotations or evidence; do not search or fetch anything.",
    extra?.hint ?? "",
    extra?.context ? `Context:\n${extra.context}` : "",
    "Problems:\n" + plan.paths.map((p) => plan.byPath[p].map((x) => `- ${x}`).join("\n")).join("\n"),
    "Current values:\n" + plan.paths.map((p) => `${p}: ${JSON.stringify(getPath(value, p))}`).join("\n"),
  ].filter(Boolean).join("\n\n");
}

/**
 * Merges a patch into the original deterministically. Rejects (returns an
 * error string) a patch that touches paths it wasn't asked for, replaces an
 * element with a non-object, or changes an element's id (other fields refer
 * to ids). Original fields the patch doesn't mention are preserved. The caller
 * must still run the full validator on the result.
 */
export function applyPatch(original: Record<string, unknown>, patch: unknown, plan: Extract<FieldPlan, { safe: true }>): { value: Record<string, unknown> } | { error: string } {
  if (!isObj(patch)) return { error: "the patch is not an object" };
  const extra = Object.keys(patch).filter((k) => !plan.paths.includes(k));
  if (extra.length) return { error: `the patch touches fields that were not requested: ${extra.join(", ")}` };
  const missing = plan.paths.filter((k) => !(k in patch));
  if (missing.length) return { error: `the patch is missing: ${missing.join(", ")}` };
  const next: Record<string, unknown> = { ...original };
  for (const path of plan.paths) {
    const m = path.match(/^([\w]+)(?:\[(\d+)\])?$/)!;
    const old = getPath(original, path);
    const fix = patch[path];
    let merged: unknown = fix;
    if (isObj(old)) {
      if (!isObj(fix)) return { error: `${path}: the patch must be an object` };
      if ("id" in old && fix.id !== undefined && fix.id !== old.id) return { error: `${path}: the patch changed the id` };
      merged = { ...old, ...fix };
    }
    if (m[2] !== undefined) {
      const arr = [...(next[m[1]] as unknown[])]; // from `next`, so several elements of one array can all be patched
      arr[Number(m[2])] = merged;
      next[m[1]] = arr;
    } else next[m[1]] = merged;
  }
  return { value: next };
}

/** Reads {"patch": {...}} (or a bare object of the requested paths) out of a reply. */
export function extractPatch(parsed: unknown): unknown {
  return isObj(parsed) && isObj(parsed.patch) ? parsed.patch : parsed;
}
