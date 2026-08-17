"use strict";
/**
 * AES-256-GCM helpers for the reasoning cache.
 *
 * The cache holds the model's reasoning about the user's codebase — file paths,
 * symbol names, bug analysis — so it should not sit in plaintext on disk or in
 * Redis. This protects data at rest only: anyone able to run commands on the
 * host can read both the key and the live process memory.
 *
 * Every function takes the key as an argument and returns null on failure, so
 * a wrong key degrades to a cache miss instead of breaking a request.
 */

const crypto = require("crypto");

const ENC_IV_LEN = 12; // GCM standard
const ENC_TAG_LEN = 16;

/** Single value, for Redis: base64 of iv | tag | ciphertext. */
function encryptValue(text, key) {
  if (!key) return text;
  const iv = crypto.randomBytes(ENC_IV_LEN);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([c.update(text, "utf-8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64");
}

function decryptValue(raw, key) {
  if (!key) return raw;
  try {
    const buf = Buffer.from(raw, "base64");
    const d = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      buf.subarray(0, ENC_IV_LEN)
    );
    d.setAuthTag(buf.subarray(ENC_IV_LEN, ENC_IV_LEN + ENC_TAG_LEN));
    return Buffer.concat([
      d.update(buf.subarray(ENC_IV_LEN + ENC_TAG_LEN)),
      d.final(),
    ]).toString("utf-8");
  } catch {
    // Wrong key or corrupt value: treat as a miss.
    return null;
  }
}

/** Stable cache key for an assistant turn that made no tool call. */
function contentKey(text, chars) {
  if (typeof text !== "string" || !text) return null;
  return (
    "c:" +
    crypto.createHash("sha1").update(text.slice(0, chars)).digest("hex").slice(0, 20)
  );
}

/** Identify a conversation by its opening messages, which never change. */
function sessionKey(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  let seed = "";
  for (const m of messages.slice(0, 2)) {
    if (!m) continue;
    const c = typeof m.content === "string" ? m.content : "";
    seed += `${m.role}|${c.length}|${c.slice(0, 256)}\n`;
  }
  if (!seed) return null;
  return crypto.createHash("sha1").update(seed).digest("hex").slice(0, 16);
}

module.exports = {
  ENC_IV_LEN,
  ENC_TAG_LEN,
  encryptValue,
  decryptValue,
  contentKey,
  sessionKey,
};
