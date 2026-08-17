"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { LRUCache, ReasoningCache } = require("../../src/cache");

test("LRU evicts the least recently used entry", () => {
  const c = new LRUCache(2, 1 << 20);
  c.set("a", "1");
  c.set("b", "2");
  c.get("a"); // refresh a, so b is now oldest
  c.set("c", "3");
  assert.strictEqual(c.get("a"), "1");
  assert.strictEqual(c.get("b"), undefined, "b evicted");
  assert.strictEqual(c.get("c"), "3");
});

test("LRU also bounds by bytes", () => {
  // 10 chars = 20 bytes each; budget fits two.
  const c = new LRUCache(100, 45);
  c.set("k1", "x".repeat(10));
  c.set("k2", "x".repeat(10));
  c.set("k3", "x".repeat(10));
  assert.strictEqual(c.get("k1"), undefined, "oldest dropped by byte budget");
  assert.strictEqual(c.size, 2);
  assert.ok(c.evictions >= 1);
});

test("re-setting a key does not double-count its bytes", () => {
  const c = new LRUCache(10, 1 << 20);
  c.set("k", "x".repeat(100));
  const after = c.bytes;
  c.set("k", "x".repeat(100));
  assert.strictEqual(c.bytes, after);
  assert.strictEqual(c.size, 1);
});

test("ReasoningCache works with L1 only (no Redis configured)", async () => {
  const c = new ReasoningCache({
    maxEntries: 10, maxBytes: 1 << 20, maxChars: 1000,
    key: null, redisUrl: "", ttlSec: 60, prefix: "t:",
  });
  c.set(["id1", "id2"], "shared trace");
  const found = await c.getMany(["id1", "id2", "missing"]);
  assert.strictEqual(found.get("id1"), "shared trace");
  assert.strictEqual(found.get("id2"), "shared trace", "all keys of a turn share it");
  assert.strictEqual(found.has("missing"), false);
});

test("traces longer than maxChars are truncated", async () => {
  const c = new ReasoningCache({
    maxEntries: 10, maxBytes: 1 << 20, maxChars: 20,
    key: null, redisUrl: "", ttlSec: 60, prefix: "t:",
  });
  c.set(["k"], "y".repeat(100));
  const found = await c.getMany(["k"]);
  assert.strictEqual(found.get("k").length, 20);
});

test("empty input is a no-op", async () => {
  const c = new ReasoningCache({
    maxEntries: 10, maxBytes: 1 << 20, maxChars: 100,
    key: null, redisUrl: "", ttlSec: 60, prefix: "t:",
  });
  assert.strictEqual(c.set([], "text"), false);
  assert.strictEqual(c.set(["k"], ""), false);
  assert.strictEqual((await c.getMany([])).size, 0);
});
