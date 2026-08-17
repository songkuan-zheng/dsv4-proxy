"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const {
  encryptValue,
  decryptValue,
  contentKey,
  sessionKey,
} = require("../../src/crypto");

const KEY = Buffer.alloc(32, 7);
const OTHER = Buffer.alloc(32, 9);

test("value round-trips through encryption", () => {
  const text = "推理内容 with code: cache.get(k) — mixed unicode";
  const enc = encryptValue(text, KEY);
  assert.notStrictEqual(enc, text, "must not be plaintext");
  assert.ok(!enc.includes("推理"), "ciphertext must not leak content");
  assert.strictEqual(decryptValue(enc, KEY), text);
});

test("each encryption uses a fresh IV", () => {
  const a = encryptValue("same input", KEY);
  const b = encryptValue("same input", KEY);
  assert.notStrictEqual(a, b, "identical plaintext must not produce identical ciphertext");
  assert.strictEqual(decryptValue(a, KEY), decryptValue(b, KEY));
});

test("wrong key yields null rather than throwing", () => {
  const enc = encryptValue("secret", KEY);
  assert.strictEqual(decryptValue(enc, OTHER), null);
});

test("tampered ciphertext is rejected by the auth tag", () => {
  const enc = encryptValue("secret payload here", KEY);
  const buf = Buffer.from(enc, "base64");
  buf[buf.length - 1] ^= 0xff; // flip a bit in the body
  assert.strictEqual(decryptValue(buf.toString("base64"), KEY), null);
});

test("no key means passthrough", () => {
  assert.strictEqual(encryptValue("plain", null), "plain");
  assert.strictEqual(decryptValue("plain", null), "plain");
});

test("contentKey is stable and prefix-scoped", () => {
  const a = contentKey("the same beginning, different tail A", 20);
  const b = contentKey("the same beginning, different tail B", 20);
  assert.strictEqual(a, b, "only the first N chars matter");
  assert.match(a, /^c:[0-9a-f]{20}$/);
  assert.strictEqual(contentKey("", 20), null);
  assert.strictEqual(contentKey(null, 20), null);
});

test("sessionKey is stable across a growing conversation", () => {
  const opening = [
    { role: "system", content: "You are an agent." },
    { role: "user", content: "first question" },
  ];
  const early = sessionKey(opening);
  const later = sessionKey([...opening, { role: "assistant", content: "..." }]);
  assert.strictEqual(early, later, "later turns must not change the session id");
  const different = sessionKey([
    { role: "system", content: "You are an agent." },
    { role: "user", content: "another question" },
  ]);
  assert.notStrictEqual(early, different);
  assert.strictEqual(sessionKey([]), null);
});
