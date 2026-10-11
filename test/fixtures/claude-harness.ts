// Runs claudeJson/claudeText against the scripted CLI and prints the outcomes as JSON.
// HARNESS = { ledger, runId, stage, budgets?, scenario, ... }
import { claudeJson, claudeText } from "../../scripts/claude";
import { setUsageContext } from "../../scripts/core/usage";
import { validateResearch } from "../../src/schema/editorial.mjs";
import { DEFAULT_SETTINGS, normalizeBudgets } from "../../src/schema/settings.mjs";

const h = JSON.parse(process.env.HARNESS!);
setUsageContext({ ledgerFile: h.ledger, runId: h.runId ?? "run-test", stage: h.stage ?? "research", budgets: normalizeBudgets({ ...DEFAULT_SETTINGS.budgets, ...(h.budgets ?? {}) }) });

const simple = (v: any) => {
  const p: string[] = [];
  if (typeof v?.a !== "string") p.push("a must be a string");
  if (typeof v?.b !== "number") p.push("b must be a number");
  return p;
};
const checks: Record<string, (v: any) => string[]> = { research: validateResearch, simple };

const out = (e: any) => ({ ok: false, name: e?.constructor?.name, kind: e?.kind, message: String(e?.message).slice(0, 300), blocks: e?.blocks });
const results: any[] = [];
try {
  if (h.scenario === "json") {
    try {
      const value = await claudeJson<any>(h.prompt ?? "PROMPT", { step: h.step ?? "research", label: "op", allowedTools: h.tools, check: checks[h.check], fieldRepair: h.fieldRepair, repairResendsPrompt: h.resend });
      results.push({ ok: true, value });
    } catch (e) { results.push(out(e)); }
  } else if (h.scenario === "texts") {
    for (const s of h.sequence as { stage: string }[]) {
      setUsageContext({ stage: s.stage });
      try { results.push({ ok: true, value: await claudeText("hello", { step: "outline", label: "t" }) }); } catch (e) { results.push(out(e)); }
    }
  } else if (h.scenario === "concurrent") {
    const rs = await Promise.allSettled(Array.from({ length: h.n }, () => claudeText("hello", { step: "outline", label: "c" })));
    for (const r of rs) results.push(r.status === "fulfilled" ? { ok: true } : out(r.reason));
  }
} finally {
  console.log("@@RESULT " + JSON.stringify(results));
}
