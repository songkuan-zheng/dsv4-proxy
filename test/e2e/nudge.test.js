"use strict";
/**
 * The deadlock backstop. Its trigger reads responses, so an earlier version
 * that inspected requests saw its own backfill and stayed silent while the
 * model was stuck — test 4 below locks that regression out.
 */
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const { Harness, JSON_HEADERS, chatBody, agentBody } = require("./helpers");

const h = new Harness();
before(() => h.startUpstream());
after(() => h.stop());
beforeEach(() => h.stopProxy());

const NUDGE = "Think carefully about what to do next before responding.";
const ENV = { TOOL_RESULT_NUDGE: NUDGE, BACKFILL_REASONING: "0",
  DEFAULT_REASONING_EFFORT: "off" };

/** Drive `count` turns whose responses all report `reasoningTokens`. */
async function drive(count, reasoningTokens, opener = "go", turns = 20) {
  for (let i = 0; i < count; i++) {
    h.reasoningUpstream(reasoningTokens);
    await h.request({ body: agentBody(turns, opener), headers: JSON_HEADERS });
    await new Promise((r) => setTimeout(r, 40));
  }
}

test("three consecutive empty responses trigger the nudge", async () => {
  await h.startProxy(ENV);
  await drive(3, 1);
  const seen = h.reasoningUpstream(1);
  await h.request({ body: agentBody(20), headers: JSON_HEADERS });
  const last = seen.body.messages.at(-1).content;
  assert.match(last, new RegExp(NUDGE.replace(/[.]/g, "\\.")));
  assert.match(last, /^result 19/, "tool output preserved");
  assert.match(h.stdout, /nudged=yes/);
});

test("a single thinking response clears the state", async () => {
  await h.startProxy(ENV);
  await drive(2, 1);
  await drive(1, 500);
  const seen = h.reasoningUpstream(1);
  await h.request({ body: agentBody(20), headers: JSON_HEADERS });
  assert.ok(!seen.body.messages.at(-1).content.includes(NUDGE));
});

test("sessions keep separate state", async () => {
  await h.startProxy(ENV);
  await drive(3, 1, "session-A");
  const seen = h.reasoningUpstream(1);
  await h.request({ body: agentBody(20, "session-B"), headers: JSON_HEADERS });
  assert.ok(!seen.body.messages.at(-1).content.includes(NUDGE));
});

test("backfilled reasoning does NOT suppress the nudge", async () => {
  await h.startProxy({ ...ENV, BACKFILL_REASONING: "1" });
  for (let i = 0; i < 3; i++) {
    h.toolCallUpstream("cached thought", `t${i}`);
    await h.request({ body: chatBody(), headers: JSON_HEADERS });
    await h.waitForLog("res status=200");
  }
  await drive(3, 1);
  const seen = h.reasoningUpstream(1);
  await h.request({ body: agentBody(20), headers: JSON_HEADERS });
  assert.ok(seen.body.messages.some((m) => m.reasoning_content),
    "precondition: backfill repaired something");
  assert.match(seen.body.messages.at(-1).content, new RegExp(NUDGE.replace(/[.]/g, "\\.")));
});

test("short sessions are never nudged", async () => {
  await h.startProxy(ENV);
  await drive(3, 1, "go", 4);
  const seen = h.reasoningUpstream(1);
  await h.request({ body: agentBody(4), headers: JSON_HEADERS });
  assert.ok(!seen.body.messages.at(-1).content.includes(NUDGE));
});

test("only applies when the last message is a tool result", async () => {
  await h.startProxy(ENV);
  await drive(3, 1);
  const seen = h.reasoningUpstream(1);
  const body = JSON.parse(agentBody(20));
  body.messages.push({ role: "user", content: "now explain" });
  await h.request({ body: JSON.stringify(body), headers: JSON_HEADERS });
  assert.ok(!seen.raw.includes(NUDGE));
});

test("no text configured means disabled", async () => {
  await h.startProxy({ BACKFILL_REASONING: "0", DEFAULT_REASONING_EFFORT: "off" });
  await drive(3, 1);
  const seen = h.reasoningUpstream(1);
  await h.request({ body: agentBody(20), headers: JSON_HEADERS });
  assert.ok(!seen.raw.includes("Think carefully"));
});
