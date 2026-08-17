"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { scrubLoops, scrubAssistantLoops, isDedupable } = require("../../src/transform/scrub");

const OPTS = { minRepeats: 8, minUnitChars: 12, maxUnitChars: 200 };

test("collapses a repeated line to one occurrence", () => {
  const text = "Let me run that command again.\n".repeat(40) + "The real answer.\n";
  const out = scrubLoops(text, OPTS);
  assert.ok(out !== null, "should detect the loop");
  assert.strictEqual((out.match(/Let me run that command again\./g) || []).length, 1);
  assert.ok(out.includes("The real answer."), "real content survives");
});

test("leaves text without loops untouched", () => {
  const text = Array.from({ length: 30 }, (_, i) =>
    `Line ${i}: a distinct observation about the code.`).join("\n");
  assert.strictEqual(scrubLoops(text, OPTS), null);
});

test("never touches markdown code fences", () => {
  // A real capture showed ``` counted 6 times and stripped, which breaks every
  // code block pairing in the replayed history.
  assert.strictEqual(isDedupable("```", 12), false);
  assert.strictEqual(isDedupable("---", 12), false);
  assert.strictEqual(isDedupable("===", 12), false);
  const doc = Array.from({ length: 12 }, (_, i) =>
    "```python\nprint(" + i + ")\n```\nSome prose to pad the document out.").join("\n");
  const out = scrubLoops(doc, OPTS);
  const fences = ((out === null ? doc : out).match(/```/g) || []).length;
  assert.strictEqual(fences, 24, "all fences preserved");
});

test("short units are never deduped", () => {
  assert.strictEqual(isDedupable("ok", 12), false);
  assert.strictEqual(isDedupable("a".repeat(12), 12), true);
});

test("long lines (real code) are not deduped", () => {
  const long = "x".repeat(250);
  const text = (long + "\n").repeat(10);
  assert.strictEqual(scrubLoops(text, { ...OPTS, maxUnitChars: 200 }), null);
});

test("threshold is respected", () => {
  const seven = "This sentence repeats a few times.\n".repeat(7) + "tail padding here\n".repeat(3);
  assert.strictEqual(scrubLoops(seven, OPTS), null, "7 < minRepeats 8");
  const eight = "This sentence repeats a few times.\n".repeat(8) + "tail padding here\n".repeat(3);
  assert.ok(scrubLoops(eight, OPTS) !== null, "8 reaches minRepeats");
});

test("only assistant messages are scrubbed", () => {
  const loop = "Repeated assistant chatter here.\n".repeat(20);
  const body = {
    messages: [
      { role: "user", content: loop },
      { role: "assistant", content: loop },
      { role: "tool", tool_call_id: "t", content: loop },
    ],
  };
  const removed = scrubAssistantLoops(body, OPTS);
  assert.ok(removed > 0);
  assert.strictEqual(body.messages[0].content, loop, "user untouched");
  assert.strictEqual(body.messages[2].content, loop, "tool untouched");
  assert.ok(body.messages[1].content.length < loop.length, "assistant scrubbed");
});

test("reasoning_content is scrubbed too", () => {
  const loop = "Thinking the same thing over again.\n".repeat(20);
  const body = { messages: [{ role: "assistant", content: "fine", reasoning_content: loop }] };
  assert.ok(scrubAssistantLoops(body, OPTS) > 0);
  assert.ok(body.messages[0].reasoning_content.length < loop.length);
});
