"use strict";
/**
 * Two-level cache for reasoning traces.
 *
 *   L1  in-process LRU — a turn backfills dozens to hundreds of keys and the
 *       next turn asks for the same ones, so the steady state stays local
 *   L2  Redis — carries restarts and new sessions, expires by TTL
 *
 * Reads renew the TTL (GETEX), so keys a live session keeps touching never
 * expire under it: the TTL bounds how long a key survives *unused*, not how
 * long a session may run.
 *
 * Redis is optional. Without it, or when it is unreachable, everything still
 * works against L1 alone — degraded (nothing survives a restart) but never
 * broken.
 */

const { encryptValue, decryptValue } = require("./crypto");

/**
 * Insertion-ordered Map as an LRU, bounded by entry count and total size.
 * Traces range from a few hundred bytes to ~120K, so a count-only bound would
 * either waste memory or evict far too early.
 */
class LRUCache {
  constructor(maxEntries, maxBytes) {
    this.maxEntries = Math.max(1, maxEntries);
    this.maxBytes = Math.max(1, maxBytes);
    this.bytes = 0;
    this.evictions = 0;
    this.map = new Map();
  }
  get(key) {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, value); // refresh recency
    return value;
  }
  set(key, value) {
    const prev = this.map.get(key);
    if (prev !== undefined) {
      this.bytes -= prev.length * 2;
      this.map.delete(key);
    }
    this.map.set(key, value);
    this.bytes += value.length * 2; // JS strings are UTF-16
    while (
      this.map.size > this.maxEntries ||
      (this.bytes > this.maxBytes && this.map.size > 1)
    ) {
      const oldest = this.map.keys().next().value;
      this.bytes -= this.map.get(oldest).length * 2;
      this.map.delete(oldest);
      this.evictions++;
    }
  }
  get size() {
    return this.map.size;
  }
}

class ReasoningCache {
  /**
   * @param {object} opts
   * @param {number} opts.maxEntries    L1 entry cap
   * @param {number} opts.maxBytes      L1 size cap
   * @param {number} opts.maxChars      per-trace truncation
   * @param {Buffer|null} opts.key      encryption key, null = plaintext
   * @param {string} opts.redisUrl      empty disables L2
   * @param {number} opts.ttlSec        idle timeout, refreshed on read
   * @param {string} opts.prefix        Redis key namespace
   * @param {object} [opts.log]         { info, error }
   */
  constructor(opts) {
    this.maxChars = opts.maxChars;
    this.key = opts.key || null;
    this.ttlSec = opts.ttlSec;
    this.prefix = opts.prefix;
    this.log = opts.log || { info: console.log, error: console.error };
    this.l1 = new LRUCache(opts.maxEntries, opts.maxBytes);
    this.redis = null;
    this.redisReady = false;
    if (opts.redisUrl) this._connect(opts.redisUrl);
  }

  _connect(url) {
    const Redis = require("ioredis");
    this.redis = new Redis(url, {
      // Fail fast rather than queueing: a Redis outage must degrade to L1,
      // never hold requests.
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 3000,
    });
    this.redis.on("ready", () => {
      this.redisReady = true;
      this.log.info(`[proxy] redis ready at ${url} (ttl ${this.ttlSec}s)`);
    });
    this.redis.on("end", () => {
      this.redisReady = false;
    });
    this.redis.on("error", (err) => {
      if (this.redisReady) this.log.error("[proxy] redis error:", err.message);
      this.redisReady = false;
    });
  }

  /**
   * Resolve many keys at once: L1 first, then a single pipelined round trip for
   * the misses. Returns Map(key -> trace); absent keys are simply missing.
   */
  async getMany(keys) {
    const found = new Map();
    const missing = [];
    for (const k of keys) {
      const hit = this.l1.get(k);
      if (hit !== undefined) found.set(k, hit);
      else missing.push(k);
    }
    if (!missing.length || !this.redis || !this.redisReady) return found;
    try {
      const pipe = this.redis.pipeline();
      for (const k of missing) pipe.getex(this.prefix + k, "EX", this.ttlSec);
      const res = await pipe.exec();
      if (!res) return found;
      for (let i = 0; i < missing.length; i++) {
        const entry = res[i];
        if (!entry) continue;
        const [err, val] = entry;
        if (err || !val) continue;
        const text = decryptValue(val, this.key);
        if (text) {
          found.set(missing[i], text);
          this.l1.set(missing[i], text); // promote
        }
      }
    } catch (err) {
      this.log.error("[proxy] redis read failed:", err.message);
    }
    return found;
  }

  /**
   * Store one trace under several keys (a turn's tool_call ids all share it).
   * Write-behind: the response never waits on Redis.
   */
  set(keys, text) {
    if (!keys.length || !text) return false;
    const clipped =
      text.length > this.maxChars ? text.slice(0, this.maxChars) : text;
    for (const k of keys) this.l1.set(k, clipped);
    if (this.redis && this.redisReady) {
      try {
        const enc = encryptValue(clipped, this.key);
        const pipe = this.redis.pipeline();
        for (const k of keys) pipe.set(this.prefix + k, enc, "EX", this.ttlSec);
        pipe
          .exec()
          .catch((err) =>
            this.log.error("[proxy] redis write failed:", err.message)
          );
      } catch (err) {
        this.log.error("[proxy] redis write failed:", err.message);
      }
    }
    return true;
  }

  get size() {
    return this.l1.size;
  }
  get bytes() {
    return this.l1.bytes;
  }
  async close() {
    if (this.redis) await this.redis.quit().catch(() => {});
  }
}

module.exports = { LRUCache, ReasoningCache };
