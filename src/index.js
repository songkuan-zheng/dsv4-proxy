"use strict";
/**
 * dsv4-proxy — an OpenAI-compatible proxy that sits in front of SGLang serving
 * DeepSeek-V4-Flash.
 *
 * It began as a queue-full 503→429 rewriter. Most of what it does now works
 * around a reasoning-collapse failure mode: translation layers drop
 * reasoning_content, SGLang renders the missing field as an empty
 * <think></think>, those accumulate as evidence that "this assistant does not
 * think", and past ~60 turns the model copies the pattern deterministically.
 * See README.md for the measurements and sources.
 */

const http = require("http");
const { PassThrough } = require("stream");
const httpProxy = require("http-proxy");

const { config } = require("./config");
const { ReasoningCache } = require("./cache");
const { Logger } = require("./observability");
const { DeadlockTracker } = require("./transform/nudge");
const { applyRequestTransforms } = require("./transform");
const {
  extractQueueFullMessage,
  emit429,
  SSERewriter,
  decompressIfNeeded,
} = require("./upstream");

const log = new Logger(config);

const cache = config.backfill
  ? new ReasoningCache({
      maxEntries: config.cacheSize,
      maxBytes: config.cacheMaxBytes,
      maxChars: config.cacheMaxChars,
      key: config.cacheKey,
      redisUrl: config.redisUrl,
      ttlSec: config.redisTtlSec,
      prefix: config.redisPrefix,
      log: { info: (...a) => log.info(...a), error: (...a) => log.error(...a) },
    })
  : null;

const tracker = config.nudgeText
  ? new DeadlockTracker({
      consecutive: config.nudgeConsecutive,
      maxSessions: config.nudgeMaxSessions,
    })
  : null;

/** True for JSON chat-completions POSTs — the only requests we buffer. */
function isChatJson(req) {
  if (req.method !== "POST") return false;
  if (!config.injectPaths.has((req.url || "").split("?")[0])) return false;
  const ct = (req.headers["content-type"] || "").toLowerCase();
  return ct.includes("application/json");
}

/** Buffering is only worth it if something will read or rewrite the body. */
function needsCapture(req) {
  if (
    config.effort === null &&
    !config.logReasoning &&
    config.dumpRequest === "off" &&
    !config.backfill &&
    !config.nudgeText &&
    !config.scrub &&
    config.dumpResponseChars <= 0
  ) {
    return false;
  }
  return isChatJson(req);
}

/**
 * Buffer the request body, rewrite it, and hand http-proxy a stream to replay.
 * Bodies that are too large, non-JSON or unparseable are forwarded byte for
 * byte — rewriting is best-effort and must never fail a request. req.headers is
 * mutated before the callback so setupOutgoing picks up the new length.
 */
function captureAndRewrite(req, res, reqId, cb) {
  const chunks = [];
  let size = 0;
  let done = false;

  const passthroughRest = () => {
    done = true;
    const pass = new PassThrough();
    for (const c of chunks) pass.write(c);
    req.pipe(pass);
    log.dbg(reqId, `body >${config.maxRewriteBodyBytes}B, forwarding unmodified`);
    log.request(reqId, { effortClient: "unread(body too large)" });
    cb(pass);
  };

  req.on("data", (chunk) => {
    if (done) return;
    chunks.push(chunk);
    size += chunk.length;
    if (size > config.maxRewriteBodyBytes) passthroughRest();
  });

  req.on("end", async () => {
    if (done) return;
    done = true;
    const raw = Buffer.concat(chunks);
    let out = raw;
    try {
      const body = JSON.parse(raw.toString("utf-8"));
      const effortClient = body.reasoning_effort;
      const r = await applyRequestTransforms(body, { config, cache, tracker, log });
      req.sessionKey = r.sessionKey;
      if (r.injected || r.backfilled || r.nudged || r.scrubbed) {
        out = Buffer.from(JSON.stringify(body), "utf-8");
      }
      log.backfilled(r.filled);
      log.request(reqId, {
        model: body.model,
        effortClient: effortClient === undefined ? "unset" : effortClient,
        effortSent:
          body.reasoning_effort === undefined ? "unset" : body.reasoning_effort,
        injected: r.injected,
        backfilled: r.backfilled,
        nudged: r.nudged,
        scrubbed: r.scrubbed,
        stream: body.stream === true,
        maxTokens: body.max_tokens,
        messages: Array.isArray(body.messages) ? body.messages.length : undefined,
      });
      log.requestShape(reqId, body);
    } catch (err) {
      log.dbg(reqId, `body not usable (${err.message}), forwarding unmodified`);
      log.request(reqId, { effortClient: "unparseable" });
    }
    req.headers["content-length"] = String(out.length);
    delete req.headers["transfer-encoding"];
    const pass = new PassThrough();
    pass.end(out);
    cb(pass);
  });

  req.on("error", (err) => {
    if (done) return;
    done = true;
    log.error("[proxy] request read error:", err.message);
    req.destroy();
    res.destroy();
  });
}

const proxy = httpProxy.createProxyServer({
  target: config.upstream,
  changeOrigin: true,
  selfHandleResponse: true,
});

let reqCounter = 0;

const server = http.createServer((req, res) => {
  const reqId = `r${++reqCounter}`;
  req.reqId = reqId;
  req.t0 = Date.now();
  req.isChat = isChatJson(req);
  if (!needsCapture(req)) {
    proxy.web(req, res);
    return;
  }
  captureAndRewrite(req, res, reqId, (bodyStream) => {
    proxy.web(req, res, { buffer: bodyStream });
  });
});

/** Everything the response side needs to collect while streaming. */
function statsOptions() {
  return {
    captureReasoning: config.backfill || config.dumpResponseChars > 0,
    captureContent: config.dumpResponseChars,
    contentKeyChars: config.backfill ? config.contentKeyChars : 0,
  };
}

function onResponseComplete(req, status, stats) {
  if (cache && stats.reasoningText) {
    const keys = [...(stats.toolCallIds || [])];
    const { contentKey } = require("./crypto");
    const ck = contentKey(stats.contentHead, config.contentKeyChars);
    if (ck) keys.push(ck);
    cache.set(keys, stats.reasoningText);
  }
  if (tracker) tracker.record(req.sessionKey, stats.reasoningTokens);
  log.responseContent(req, stats);
  log.response(req, status, stats, cache ? cache.size : undefined);
}

proxy.on("proxyRes", (proxyRes, req, res) => {
  const reqId = req.reqId || `r${++reqCounter}`;
  log.dbg(
    reqId,
    `upstream ${proxyRes.statusCode} ct=${proxyRes.headers["content-type"]} ` +
      `ce=${proxyRes.headers["content-encoding"]} path=${req.url}`
  );

  const onClientClose = () => proxyRes.destroy();
  req.on("close", onClientClose);
  res.on("close", onClientClose);

  proxyRes.on("error", (err) => {
    log.error("[proxy] upstream read error:", err.message);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Bad Gateway", code: 502 } }));
    } else {
      res.destroy(err);
    }
  });

  // ---- non-503 path (typically 200, often streaming) ----
  if (proxyRes.statusCode !== 503) {
    if (proxyRes.headers["content-encoding"]) {
      // Compressed: pass through untouched, no counters available.
      log.dbg(reqId, "passthrough (compressed)");
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
      res.on("finish", () => log.response(req, proxyRes.statusCode, null));
      return;
    }

    let decided = false;
    proxyRes.pause();

    const proceed = (firstChunk) => {
      if (decided) return;
      decided = true;

      if (firstChunk) {
        // Peek: a queue-full error as the first thing on the wire can still
        // become a real 429 because the status is not committed yet.
        const msg = extractQueueFullMessage(firstChunk.toString("utf-8"));
        if (msg !== null) {
          log.dbg(reqId, "peek hit -> emit canonical 429");
          proxyRes.destroy();
          emit429(res, msg);
          log.response(req, 429, null);
          return;
        }
      }

      const headers = { ...proxyRes.headers };
      delete headers["content-length"]; // rewriting can change the length
      res.writeHead(proxyRes.statusCode, headers);

      const rewriter = new SSERewriter(statsOptions());
      rewriter.pipe(res);
      rewriter.on("end", () =>
        onResponseComplete(req, proxyRes.statusCode, rewriter.stats)
      );
      if (firstChunk) rewriter.write(firstChunk);
      proxyRes.pipe(rewriter);
      proxyRes.resume();
    };

    proxyRes.once("readable", () => proceed(proxyRes.read()));
    proxyRes.once("end", () => proceed(null));
    return;
  }

  // ---- 503 path: buffer, decode, and maybe emit a canonical 429 ----
  log.dbg(reqId, "buffering 503 body");
  const chunks = [];
  proxyRes.on("data", (chunk) => chunks.push(chunk));
  proxyRes.on("end", () => {
    req.removeListener("close", onClientClose);
    res.removeListener("close", onClientClose);

    const raw = Buffer.concat(chunks);
    const decoded = decompressIfNeeded(
      raw,
      proxyRes.headers["content-encoding"],
      (...a) => log.error(...a)
    );

    const passthrough = () => {
      const headers = { ...proxyRes.headers };
      headers["content-length"] = raw.length;
      delete headers["transfer-encoding"];
      res.writeHead(503, headers);
      res.end(raw);
      log.response(req, 503, null);
    };

    if (decoded === null) {
      log.dbg(reqId, "503 passthrough (undecodable)");
      passthrough();
      return;
    }
    const msg = extractQueueFullMessage(decoded.toString("utf-8"));
    if (msg !== null) {
      log.dbg(reqId, "503 queue-full -> 429");
      emit429(res, msg);
      log.response(req, 429, null);
      return;
    }
    log.dbg(reqId, "503 passthrough (not queue-full)");
    passthrough();
  });
});

proxy.on("error", (err, req, res) => {
  log.error("[proxy error]", err.message);
  if (res && !res.headersSent) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Bad Gateway", code: 502 } }));
  }
  if (req) log.response(req, 502, null);
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, async () => {
    if (cache) await cache.close();
    process.exit(0);
  });
}

server.listen(config.port, "0.0.0.0", () => {
  const parts = [
    `reasoning_effort default=${
      config.effort === null ? "off" : JSON.stringify(config.effort)
    }`,
  ];
  if (config.effort !== null && config.effortOverride) parts.push("override=on");
  parts.push(`log=${config.logReasoning ? "on" : "off"}`);
  parts.push(
    `backfill=${
      config.backfill
        ? `on/last${config.backfillMaxTurns > 0 ? config.backfillMaxTurns : "∞"}` +
          `${config.redisUrl ? "/redis" : "/memory-only"}` +
          `${config.cacheKey ? "+aes256" : ""}`
        : "off"
    }`
  );
  if (config.nudgeText) parts.push(`nudge=on/${config.nudgeConsecutive}x-empty`);
  if (config.scrub) parts.push(`scrub=on/${config.scrubMinRepeats}x`);
  console.log(
    `dsv4-proxy listening on :${config.port} -> ${config.upstream} (${parts.join(", ")})`
  );
});

module.exports = { server, cache, tracker, config };
