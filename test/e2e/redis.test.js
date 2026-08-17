"use strict";
/**
 * L2 cache behaviour. Skipped when no Redis is reachable, so the suite still
 * runs on a machine without one — but the assertions below are the only proof
 * that persistence and TTL renewal work, so CI should provide Redis.
 */
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { Harness, JSON_HEADERS, chatBody, TOOLS_PARAM } = require("./helpers");

const REDIS_URL = process.env.TEST_REDIS_URL || "redis://127.0.0.1:6380";
const PREFIX = `dsv4test:${process.pid}:`;
const TTL = "3600";

let Redis = null;
let available = false;
let cli = null;

const h = new Harness();

before(async () => {
  try {
    Redis = require("ioredis");
    cli = new Redis(REDIS_URL, { lazyConnect: true, connectTimeout: 1500, maxRetriesPerRequest: 0 });
    await cli.connect();
    await cli.ping();
    available = true;
  } catch {
    if (cli) cli.disconnect();
    cli = null;
    console.log(`# skipping Redis tests: nothing at ${REDIS_URL}`);
  }
  await h.startUpstream();
});

after(async () => {
  await h.stop();
  if (cli) {
    const keys = await cli.keys(PREFIX + "*");
    if (keys.length) await cli.del(...keys);
    await cli.quit();
  }
});

beforeEach(() => h.stopProxy());

const ENV = {
  BACKFILL_REASONING: "1",
  DEFAULT_REASONING_EFFORT: "off",
  REASONING_REDIS_URL: REDIS_URL,
  REASONING_REDIS_PREFIX: PREFIX,
  REASONING_REDIS_TTL_SEC: TTL,
};

function replayBody(id) {
  return JSON.stringify({
    model: "m", tools: TOOLS_PARAM,
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: null,
        tool_calls: [{ id, type: "function", function: { name: "read_file", arguments: "{}" } }] },
      { role: "tool", tool_call_id: id, content: "out" },
    ],
  });
}

test("traces are written to Redis with a TTL", async (t) => {
  if (!available) return t.skip("no Redis");
  await h.startProxy(ENV);
  await h.waitForLog("redis ready");
  h.toolCallUpstream("stored in redis", "rk1");
  await h.request({ body: chatBody(), headers: JSON_HEADERS });
  await h.waitForLog("res status=200");
  await new Promise((r) => setTimeout(r, 150));

  assert.ok(await cli.get(PREFIX + "rk1"), "key written");
  const ttl = await cli.ttl(PREFIX + "rk1");
  assert.ok(ttl > 3500 && ttl <= 3600, `unexpected TTL ${ttl}`);
});

test("backfill survives losing the in-process cache", async (t) => {
  if (!available) return t.skip("no Redis");
  await h.startProxy(ENV);
  await h.waitForLog("redis ready");
  h.toolCallUpstream("only in redis", "rk2");
  await h.request({ body: chatBody(), headers: JSON_HEADERS });
  await h.waitForLog("res status=200");
  await new Promise((r) => setTimeout(r, 150));

  // Restart: L1 is empty, so a hit can only come from Redis.
  await h.stopProxy();
  await h.startProxy(ENV);
  await h.waitForLog("redis ready");
  const seen = h.recordUpstream();
  await h.request({ body: replayBody("rk2"), headers: JSON_HEADERS });
  assert.strictEqual(seen.body.messages[1].reasoning_content, "only in redis");
});

test("reads renew the TTL (GETEX, not GET)", async (t) => {
  if (!available) return t.skip("no Redis");
  // Without renewal a session running past the TTL would watch its early turns
  // go empty again.
  await h.startProxy(ENV);
  await h.waitForLog("redis ready");
  h.toolCallUpstream("renew me", "rk3");
  await h.request({ body: chatBody(), headers: JSON_HEADERS });
  await h.waitForLog("res status=200");
  await new Promise((r) => setTimeout(r, 150));

  await cli.expire(PREFIX + "rk3", 100); // age it artificially
  await h.stopProxy();
  await h.startProxy(ENV);
  await h.waitForLog("redis ready");
  h.recordUpstream();
  await h.request({ body: replayBody("rk3"), headers: JSON_HEADERS });
  await new Promise((r) => setTimeout(r, 150));

  const ttl = await cli.ttl(PREFIX + "rk3");
  assert.ok(ttl > 100, `TTL was not refreshed on read (still ${ttl})`);
});

test("Redis holds ciphertext when a key is configured", async (t) => {
  if (!available) return t.skip("no Redis");
  const keyFile = path.join(os.tmpdir(), `dsv4-test-key-${process.pid}`);
  fs.writeFileSync(keyFile, "c".repeat(64));
  try {
    await h.startProxy({ ...ENV, REASONING_CACHE_KEY_FILE: keyFile });
    await h.waitForLog("redis ready");
    const SECRET = "SENSITIVE-REASONING-ABOUT-CODE";
    h.toolCallUpstream(SECRET, "rk4");
    await h.request({ body: chatBody(), headers: JSON_HEADERS });
    await h.waitForLog("res status=200");
    await new Promise((r) => setTimeout(r, 150));

    const raw = await cli.get(PREFIX + "rk4");
    assert.ok(raw, "key written");
    assert.ok(!raw.includes(SECRET), "plaintext must not reach Redis");

    const seen = h.recordUpstream();
    await h.request({ body: replayBody("rk4"), headers: JSON_HEADERS });
    assert.strictEqual(seen.body.messages[1].reasoning_content, SECRET, "decrypted on read");
  } finally {
    fs.unlinkSync(keyFile);
  }
});

test("an unreachable Redis degrades to L1 instead of failing", async () => {
  await h.startProxy({ ...ENV, REASONING_REDIS_URL: "redis://127.0.0.1:6399" });
  h.toolCallUpstream("l1 only", "rk5");
  const r = await h.request({ body: chatBody(), headers: JSON_HEADERS });
  assert.strictEqual(r.status, 200, "still serving");
  await h.waitForLog("res status=200");

  const seen = h.recordUpstream();
  await h.request({ body: replayBody("rk5"), headers: JSON_HEADERS });
  assert.strictEqual(seen.body.messages[1].reasoning_content, "l1 only",
    "L1 backfill unaffected by the outage");
});
