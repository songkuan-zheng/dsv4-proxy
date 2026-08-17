"use strict";
/**
 * Every environment variable the proxy reads, parsed once, in one place.
 *
 * Pure logic elsewhere takes its options as arguments instead of reaching for
 * this module, so unit tests can exercise it without touching process.env.
 */

const fs = require("fs");

function int(name, dflt) {
  return parseInt(process.env[name] || String(dflt), 10);
}
function bool(name, dflt = false) {
  const v = process.env[name];
  if (v === undefined) return dflt;
  return v === "1";
}

const VALID_EFFORTS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

/**
 * Resolve the configured effort to the value to place in the JSON body: a
 * string for the named levels, a number for SGLang's numeric form, or null
 * when injection is disabled or misconfigured.
 */
function resolveEffort(raw, onError = console.error) {
  const v = (raw === undefined ? "max" : raw).trim();
  if (v === "" || v === "off") return null;
  if (VALID_EFFORTS.has(v)) return v;
  const n = Number(v);
  if (Number.isFinite(n)) return n;
  onError(
    `[proxy] invalid DEFAULT_REASONING_EFFORT=${JSON.stringify(raw)}, ` +
      `injection disabled (expected one of ${[...VALID_EFFORTS].join(", ")} or a number)`
  );
  return null;
}

/** Read a 32-byte hex key from a file or inline value; null disables crypto. */
function loadCacheKey(env = process.env, onError = console.error) {
  const file = env.REASONING_CACHE_KEY_FILE;
  const inline = env.REASONING_CACHE_KEY;
  let hex = null;
  if (file) {
    try {
      hex = fs.readFileSync(file, "utf-8").trim();
    } catch (err) {
      onError(
        `[proxy] cannot read REASONING_CACHE_KEY_FILE (${err.code}); ` +
          `cache will not be encrypted`
      );
      return null;
    }
  } else if (inline) {
    hex = inline.trim();
  }
  if (!hex) return null;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    onError(
      "[proxy] cache key must be 64 hex chars (32 bytes); cache will not be " +
        "encrypted. Generate one with: openssl rand -hex 32"
    );
    return null;
  }
  return Buffer.from(hex, "hex");
}

const config = {
  // --- server ---
  port: int("PORT", 8002),
  upstream: process.env.UPSTREAM || "http://sglang-server:8000",
  debug: bool("DEBUG"),
  // Only these paths are buffered and rewritten; everything else streams through.
  injectPaths: new Set(["/v1/chat/completions"]),
  maxRewriteBodyBytes: int("MAX_REWRITE_BODY_BYTES", 32 * 1024 * 1024),

  // --- reasoning_effort injection ---
  // SGLang treats a missing reasoning_effort as "no thinking at all", so a
  // default is injected for clients that do not set one.
  effort: resolveEffort(process.env.DEFAULT_REASONING_EFFORT),
  effortOverride: bool("REASONING_EFFORT_OVERRIDE"),

  // --- reasoning_content backfill ---
  backfill: bool("BACKFILL_REASONING"),
  // 0 = repair every tool-calling turn, which is what DeepSeek's spec requires.
  backfillMaxTurns: int("BACKFILL_MAX_TURNS", 0),
  contentKeyChars: int("CONTENT_KEY_CHARS", 512),

  // --- L1 cache ---
  cacheSize: int("REASONING_CACHE_SIZE", 200000),
  cacheMaxBytes: int("REASONING_CACHE_MAX_BYTES", 4096 * 1024 * 1024),
  cacheMaxChars: int("REASONING_CACHE_MAX_CHARS", 256 * 1024),

  // --- L2 cache (Redis) ---
  redisUrl: process.env.REASONING_REDIS_URL || "",
  // Idle timeout, not session length: reads are GETEX and renew it.
  redisTtlSec: int("REASONING_REDIS_TTL_SEC", 24 * 3600),
  redisPrefix: process.env.REASONING_REDIS_PREFIX || "dsv4:rc:",

  // --- encryption ---
  cacheKey: loadCacheKey(),

  // --- loop scrubbing ---
  scrub: bool("SCRUB_ASSISTANT_LOOPS"),
  scrubMinRepeats: int("SCRUB_MIN_REPEATS", 8),
  scrubMinUnitChars: int("SCRUB_MIN_UNIT_CHARS", 12),
  scrubMaxUnitChars: int("SCRUB_MAX_UNIT_CHARS", 200),
  loopFrequencyPenalty: parseFloat(process.env.LOOP_FREQUENCY_PENALTY || "0.1"),

  // --- deadlock nudge ---
  nudgeText: process.env.TOOL_RESULT_NUDGE || "",
  nudgeConsecutive: int("NUDGE_CONSECUTIVE", 3),
  nudgeMinTurns: int("NUDGE_MIN_TURNS", 10),
  nudgeMaxSessions: int("NUDGE_MAX_SESSIONS", 2000),

  // --- observability ---
  logReasoning: process.env.LOG_REASONING !== "0",
  dumpRequest: (process.env.DUMP_REQUEST || "off").toLowerCase(),
  dumpLimit: int("DUMP_LIMIT", 5),
  dumpMinMessages: int("DUMP_MIN_MESSAGES", 0),
  dumpPreviewChars: int("DUMP_PREVIEW_CHARS", 0),
  dumpResponseChars: int("DUMP_RESPONSE_CHARS", 0),
  dumpResponseLimit: int("DUMP_RESPONSE_LIMIT", 5),
  dumpBackfillChars: int("DUMP_BACKFILL_CHARS", 0),
  dumpBackfillLimit: int("DUMP_BACKFILL_LIMIT", 3),
  dumpScrubChars: int("DUMP_SCRUB_CHARS", 0),
};

module.exports = { config, resolveEffort, loadCacheKey, VALID_EFFORTS };
