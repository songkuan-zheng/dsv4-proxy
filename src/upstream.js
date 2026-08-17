"use strict";
/**
 * Response-side handling.
 *
 * Two jobs:
 *
 *   1. Normalise SGLang's queue-full signal. It arrives as a 503 (or, mid
 *      stream, as an SSE event) that OpenAI clients do not recognise as
 *      retryable, so it is rewritten to a canonical 429 rate_limit_exceeded.
 *   2. Extract usage counters and reasoning text from the stream, which feeds
 *      both the cache and the deadlock detector.
 */

const zlib = require("zlib");
const { Transform } = require("stream");

const MARKER = "The request queue is full";

/**
 * SGLang reports queue-full in two shapes:
 *   streaming SSE:  {"error":{"object":"error","message":"...","code":503,...}}
 *   non-streaming:  {"object":"error","message":"...","code":503,...}
 * Returns the message when obj matches either, else null.
 */
function extractQueueFullFromObj(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (obj.error && typeof obj.error === "object") {
    const e = obj.error;
    if (
      (e.code === 503 || e.code === "503") &&
      typeof e.message === "string" &&
      e.message.includes(MARKER)
    ) {
      return e.message;
    }
  }
  if (
    obj.object === "error" &&
    (obj.code === 503 || obj.code === "503") &&
    typeof obj.message === "string" &&
    obj.message.includes(MARKER)
  ) {
    return obj.message;
  }
  return null;
}

/** Scan a body (plain JSON or SSE) for a queue-full error. */
function extractQueueFullMessage(bodyStr) {
  try {
    const msg = extractQueueFullFromObj(JSON.parse(bodyStr));
    if (msg !== null) return msg;
  } catch {}
  for (const rawLine of bodyStr.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    let jsonStr;
    if (line.startsWith("data: ")) jsonStr = line.slice(6);
    else if (line.startsWith("data:")) jsonStr = line.slice(5);
    else continue;
    jsonStr = jsonStr.trim();
    if (!jsonStr || jsonStr === "[DONE]") continue;
    try {
      const msg = extractQueueFullFromObj(JSON.parse(jsonStr));
      if (msg !== null) return msg;
    } catch {}
  }
  return null;
}

/** The schema OpenAI returns for 429. */
function buildRateLimitBody(message) {
  return JSON.stringify({
    error: {
      message: message || "The request queue is full.",
      type: "rate_limit_exceeded",
      code: "rate_limit_exceeded",
      param: null,
    },
  });
}

function emit429(res, message) {
  const body = Buffer.from(buildRateLimitBody(message), "utf-8");
  res.writeHead(429, {
    "content-type": "application/json",
    "content-length": body.length,
    "retry-after": "1",
  });
  res.end(body);
}

/**
 * Rewrite an SSE data event once the status is already committed as 200:
 * replace the inner JSON with the canonical error, preserving SSE framing.
 */
function rewriteSSELine(line) {
  const hasCR = line.endsWith("\r");
  const core = hasCR ? line.slice(0, -1) : line;
  const suffix = hasCR ? "\r" : "";
  let jsonStr;
  if (core.startsWith("data: ")) jsonStr = core.slice(6);
  else if (core.startsWith("data:")) jsonStr = core.slice(5);
  else return { line, hit: false, parsed: null };
  jsonStr = jsonStr.trim();
  if (!jsonStr || jsonStr === "[DONE]") return { line, hit: false, parsed: null };
  try {
    const parsed = JSON.parse(jsonStr);
    const msg = extractQueueFullFromObj(parsed);
    if (msg !== null) {
      return { line: "data: " + buildRateLimitBody(msg) + suffix, hit: true, parsed };
    }
    return { line, hit: false, parsed };
  } catch {}
  return { line, hit: false, parsed: null };
}

/**
 * Pull usage counters and finish_reason out of a parsed chunk. Records only
 * whether reasoning/content appeared, except when the caller asks for the text
 * (needed to cache it, and to dump it while debugging).
 */
function collectStats(parsed, stats, opts = {}) {
  if (!parsed || typeof parsed !== "object" || !stats) return;
  const { captureReasoning = false, captureContent = 0, contentKeyChars = 0 } = opts;
  const u = parsed.usage;
  if (u && typeof u === "object") {
    if (typeof u.prompt_tokens === "number") stats.promptTokens = u.prompt_tokens;
    if (typeof u.completion_tokens === "number")
      stats.completionTokens = u.completion_tokens;
    if (typeof u.reasoning_tokens === "number")
      stats.reasoningTokens = u.reasoning_tokens;
  }
  const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
  for (const ch of choices) {
    if (!ch || typeof ch !== "object") continue;
    if (ch.finish_reason) stats.finishReason = ch.finish_reason;
    const part = ch.delta || ch.message;
    if (!part || typeof part !== "object") continue;

    if (part.reasoning_content) {
      stats.sawReasoning = true;
      if (captureReasoning) {
        stats.reasoningText = (stats.reasoningText || "") + String(part.reasoning_content);
      }
    }
    if (part.content) {
      stats.sawContent = true;
      if (contentKeyChars > 0) {
        // Key for assistant turns that made no tool call: they have no id, but
        // the client replays their content verbatim.
        const head = stats.contentHead || "";
        if (head.length < contentKeyChars)
          stats.contentHead = head + String(part.content);
      }
      if (captureContent > 0) {
        const cur = stats.contentText || "";
        if (cur.length < captureContent) stats.contentText = cur + String(part.content);
      }
    }
    if (Array.isArray(part.tool_calls)) {
      for (const tc of part.tool_calls) {
        if (tc && tc.id) {
          stats.toolCallIds = stats.toolCallIds || new Set();
          stats.toolCallIds.add(tc.id);
        }
        const fn = tc && tc.function;
        if (fn && fn.name) {
          stats.toolNames = stats.toolNames || [];
          if (!stats.toolNames.includes(fn.name)) stats.toolNames.push(fn.name);
        }
      }
    }
  }
}

/**
 * Line-buffered transform used after the status is committed. Its job is to
 * rewrite mid-stream queue-full events in-band, and to collect stats from the
 * chunks it already had to parse.
 */
class SSERewriter extends Transform {
  constructor(statsOpts = {}) {
    super();
    this.buf = "";
    this.sawNewline = false;
    this.hits = 0;
    this.lines = 0;
    this.stats = {};
    this.statsOpts = statsOpts;
  }
  _transform(chunk, _enc, cb) {
    this.buf += chunk.toString("utf-8");
    let idx;
    while ((idx = this.buf.indexOf("\n")) !== -1) {
      this.sawNewline = true;
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      this.lines++;
      const r = rewriteSSELine(line);
      collectStats(r.parsed, this.stats, this.statsOpts);
      if (r.hit) this.hits++;
      this.push(r.line + "\n");
    }
    cb();
  }
  _flush(cb) {
    if (!this.buf.length) return cb();
    if (!this.sawNewline) {
      try {
        // Non-streaming JSON response: the whole body lands here.
        const parsed = JSON.parse(this.buf);
        collectStats(parsed, this.stats, this.statsOpts);
        const msg = extractQueueFullFromObj(parsed);
        if (msg !== null) {
          this.push(buildRateLimitBody(msg));
          this.buf = "";
          this.hits++;
          return cb();
        }
      } catch {}
    }
    const r = rewriteSSELine(this.buf);
    collectStats(r.parsed, this.stats, this.statsOpts);
    if (r.hit) this.hits++;
    this.push(r.line);
    this.buf = "";
    cb();
  }
}

function decompressIfNeeded(buf, encoding, onError = console.error) {
  if (!encoding) return buf;
  const enc = encoding.toLowerCase().trim();
  try {
    if (enc === "gzip") return zlib.gunzipSync(buf);
    if (enc === "deflate") return zlib.inflateSync(buf);
    if (enc === "br") return zlib.brotliDecompressSync(buf);
  } catch (err) {
    onError("[proxy] decompress failed:", err.message);
    return null;
  }
  return null;
}

module.exports = {
  MARKER,
  extractQueueFullFromObj,
  extractQueueFullMessage,
  buildRateLimitBody,
  emit429,
  rewriteSSELine,
  collectStats,
  SSERewriter,
  decompressIfNeeded,
};
