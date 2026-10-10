// Timeline: shots land on bar lines and fit their narration; the Short uses
// marked shots; captions split narration into readable chunks.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTimeline, captionChunks, shotsFor } from "../src/schema/timeline.mjs";

const spec = {
  schemaVersion: 2, slug: "t", title: "T", music: { bpm: 120 },
  shots: [
    { id: "a", section: "intro", narration: "one two three", short: true, visual: { type: "title", title: "A" } },
    { id: "b", section: "verse", narration: "x", visual: { type: "kinetic" } },
    { id: "c", section: "chorus", lyric: "hop hop hop hop hop", short: true, visual: { type: "kinetic" } },
  ],
};

test("shot boundaries are whole bars and fit measured narration", () => {
  const tl = buildTimeline(spec, "main", { a: 5.2, b: 1 });
  const barFrames = 4 * (60 / 120) * 30; // 60 frames
  for (const s of tl.shots) assert.equal(s.startFrame % barFrames, 0);
  // 0.35 lead + 5.2 + 0.45 tail = 6.0s -> 3 bars of 2s.
  assert.equal(tl.shots[0].bars, 3);
  assert.equal(tl.shots[0].narration.startFrame, Math.round(0.35 * 30));
  assert.equal(tl.totalFrames, tl.shots.reduce((n, s) => n + s.durationFrames, 0));
});

test("lyric words land on beats inside the shot", () => {
  const tl = buildTimeline(spec, "main", {});
  const c = tl.shots[2];
  assert.equal(c.lyric.length, 5);
  assert.equal(c.lyric[0].frame, c.startFrame);
  assert.equal(c.lyric[1].frame - c.lyric[0].frame, 15);
});

test("the Short uses only shots marked short", () => {
  assert.deepEqual(shotsFor(spec, "short").map((s) => s.id), ["a", "c"]);
  assert.deepEqual(buildTimeline(spec, "short").shots.map((s) => s.id), ["a", "c"]);
});

test("caption chunks cover the narration window exactly", () => {
  const chunks = captionChunks("This is a fairly long sentence, and it keeps going for quite a while until it ends.", 100, 200);
  assert.ok(chunks.length >= 2);
  assert.equal(chunks[0].startFrame, 100);
  const last = chunks[chunks.length - 1];
  assert.equal(last.startFrame + last.durationFrames, 300);
  assert.ok(chunks.every((c) => c.text.split(" ").length <= 9));
});
