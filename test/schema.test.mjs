// Storyboard schema: validation, migration of v1 specs, lint and text extraction.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { lintSpec, migrateSpec, textOf, validateSpec } from "../src/schema/storyboard.mjs";

const base = () => ({
  schemaVersion: 2, slug: "demo", title: "Demo", music: { bpm: 110 },
  shots: [
    { id: "hook", section: "intro", narration: "Hello there.", visual: { type: "title", title: "Hello", icon: "globe" } },
    { id: "net", section: "verse", narration: "Packets hop.", visual: { type: "network", nodes: [{ id: "a", icon: "phone", x: 10, y: 50 }, { id: "b", icon: "router", x: 60, y: 50 }], links: [{ from: "a", to: "b" }], packets: [{ route: ["a", "b"] }] } },
    { id: "chorus", section: "chorus", lyric: "Hop hop hop", visual: { type: "kinetic", style: "punch" } },
  ],
});

test("a valid storyboard has no problems", () => {
  assert.deepEqual(validateSpec(base(), { slug: "demo" }), []);
});

test("packets must follow links", () => {
  const s = base();
  s.shots[1].visual.nodes.push({ id: "c", icon: "server", x: 90, y: 50 });
  s.shots[1].visual.packets = [{ route: ["a", "c"] }];
  assert.ok(validateSpec(s).some((p) => p.includes("no link between them")));
});

test("unknown icons, visual types and slug changes are rejected", () => {
  const s = base();
  s.shots[0].visual.icon = "unicorn";
  s.shots[2].visual = { type: "hologram" };
  const problems = validateSpec(s, { slug: "other" });
  assert.ok(problems.some((p) => p.includes("unicorn")));
  assert.ok(problems.some((p) => p.includes("visual.type must be one of")));
  assert.ok(problems.some((p) => p.includes('slug must stay "other"')));
});

test("scene3d needs a 2D fallback, which is validated too", () => {
  const s = base();
  s.shots[1].visual = { type: "scene3d", scene: "fiber-packets" };
  assert.ok(validateSpec(s).some((p) => p.includes("fallback")));
  s.shots[1].visual.fallback = { type: "anatomy", subject: "cable", callouts: [{ label: "x", x: 2, y: 0 }] };
  assert.ok(validateSpec(s).some((p) => p.includes("callouts[0]")));
  s.shots[1].visual.fallback.callouts[0].x = 0.5;
  assert.deepEqual(validateSpec(s), []);
});

test("named anatomy anchors resolve, unknown ones are reported", () => {
  const s = base();
  s.shots[1].visual = { type: "anatomy", subject: "packet", callouts: [{ label: "To", anchor: "to-address" }] };
  assert.deepEqual(validateSpec(s), []);
  s.shots[1].visual.callouts[0].anchor = "wings";
  assert.ok(validateSpec(s).some((p) => p.includes('anchor "wings"')));
});

test("v1 specs migrate to valid v2 storyboards", () => {
  const v1 = JSON.parse(readFileSync(new URL("./fixtures/v1-spec.json", import.meta.url), "utf8"));
  const v2 = migrateSpec(v1);
  assert.equal(v2.schemaVersion, 2);
  assert.equal(v2.shots.length, v1.scenes.length);
  assert.deepEqual(validateSpec(v2, { slug: v1.slug }), []);
  assert.equal(v2.shots.find((s) => s.section === "chorus").lyric, "Packets on the move, hop hop hop!");
});

test("lint flags repetition and an overused mascot", () => {
  const s = base();
  s.shots = Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, section: "verse", narration: "x", mascot: { mood: "happy" }, visual: { type: "kinetic" } }));
  const lint = lintSpec(s);
  assert.ok(lint.some((w) => w.includes("both use")));
  assert.ok(lint.some((w) => w.includes("mascot")));
  assert.ok(lint.some((w) => w.includes("no chorus")));
});

test("textOf collects narration, lyrics, headlines and diagram labels", () => {
  const s = base();
  s.shots[1].visual.nodes[0].label = "Your phone";
  const t = textOf(s);
  assert.ok(t.find((x) => x.shot === "net").labels.includes("Your phone"));
  assert.equal(t.find((x) => x.shot === "chorus").lyric, "Hop hop hop");
});
