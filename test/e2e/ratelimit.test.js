"use strict";
/** SGLang's queue-full signal must reach clients as a retryable 429. */
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const zlib = require("zlib");
const { Harness } = require("./helpers");

const h = new Harness();
before(async () => {
  await h.startUpstream();
  await h.startProxy({ DEFAULT_REASONING_EFFORT: "off", BACKFILL_REASONING: "0" });
});
after(() => h.stop());

const QUEUE_FULL_SSE =
  'data: {"error":{"object":"error","message":"The request queue is full.","code":503}}\n\n';

function assertCanonical429(r, fragment) {
  assert.strictEqual(r.status, 429);
  assert.strictEqual((r.headers["content-type"] || "").split(";")[0].trim(), "application/json");
  assert.strictEqual(r.headers["retry-after"], "1");
  const parsed = JSON.parse(r.body);
  assert.strictEqual(parsed.error.type, "rate_limit_exceeded");
  assert.strictEqual(parsed.error.code, "rate_limit_exceeded");
  if (fragment) assert.match(parsed.error.message, new RegExp(fragment));
}

test("200 JSON passes through untouched", async () => {
  h.upstreamHandler = (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "abc", choices: [{ text: "hi" }] }));
  };
  const r = await h.request();
  assert.strictEqual(r.status, 200);
  assert.strictEqual(JSON.parse(r.body).id, "abc");
});

test("503 SSE queue-full becomes 429", async () => {
  h.upstreamHandler = (_req, res) => {
    res.writeHead(503, { "content-type": "text/event-stream" });
    res.end(QUEUE_FULL_SSE);
  };
  assertCanonical429(await h.request(), "queue is full");
});

test("503 top-level shape (non-streaming) becomes 429", async () => {
  h.upstreamHandler = (_req, res) => {
    const body = JSON.stringify({ object: "error",
      message: "The request queue is full.", type: "503", code: 503 });
    res.writeHead(503, { "content-type": "application/json",
      "content-length": Buffer.byteLength(body) });
    res.end(body);
  };
  assertCanonical429(await h.request(), "queue is full");
});

test("gzipped 503 is decoded, then answered as plain 429", async () => {
  h.upstreamHandler = (_req, res) => {
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify({
      error: { message: "The request queue is full", code: 503 } })));
    res.writeHead(503, { "content-type": "application/json", "content-encoding": "gzip" });
    res.end(gz);
  };
  const r = await h.request();
  assertCanonical429(r);
  assert.ok(!r.headers["content-encoding"], "canonical 429 must not claim an encoding");
});

test("other 503s pass through unchanged", async () => {
  h.upstreamHandler = (_req, res) => {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Internal server error", code: 503 } }));
  };
  const r = await h.request();
  assert.strictEqual(r.status, 503);
  assert.match(r.body, /Internal server error/);
});

test("marker text in the wrong shape is not rewritten", async () => {
  h.upstreamHandler = (_req, res) => {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ detail: "The request queue is full but no proper shape" }));
  };
  assert.strictEqual((await h.request()).status, 503);
});

test("queue-full as the sole SSE event still becomes a real 429", async () => {
  h.upstreamHandler = (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(QUEUE_FULL_SSE + "data: [DONE]\n\n");
  };
  assertCanonical429(await h.request());
});

test("mid-stream queue-full keeps status 200 but rewrites the event", async () => {
  // Tokens already went out, so the status cannot change; the error is
  // normalised in-band instead.
  h.upstreamHandler = (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"id":"x","choices":[{"delta":{"content":"hi"}}]}\n\n');
    setTimeout(() => {
      res.write(QUEUE_FULL_SSE);
      res.end("data: [DONE]\n\n");
    }, 30);
  };
  const r = await h.request();
  assert.strictEqual(r.status, 200);
  assert.match(r.body, /"content":"hi"/, "tokens preserved");
  assert.match(r.body, /"code":"rate_limit_exceeded"/);
  assert.match(r.body, /\[DONE\]/);
});

test("queue-full split across chunks is caught in-band", async () => {
  h.upstreamHandler = (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(QUEUE_FULL_SSE.slice(0, 30));
    setTimeout(() => {
      res.write(QUEUE_FULL_SSE.slice(30));
      res.end("data: [DONE]\n\n");
    }, 30);
  };
  const r = await h.request();
  assert.strictEqual(r.status, 200, "peek could not see the whole JSON");
  assert.match(r.body, /"code":"rate_limit_exceeded"/);
});

test("normal SSE stream is not disturbed", async () => {
  h.upstreamHandler = (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"id":"x","choices":[{"delta":{"content":"hello"}}]}\n\n');
    res.end("data: [DONE]\n\n");
  };
  const r = await h.request();
  assert.strictEqual(r.status, 200);
  assert.match(r.body, /hello/);
  assert.ok(!r.body.includes("rate_limit_exceeded"));
});

test("plaintext containing the marker is left alone", async () => {
  h.upstreamHandler = (_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("The request queue is full was once an error message");
  };
  const r = await h.request();
  assert.strictEqual(r.status, 200);
  assert.match(r.body, /The request queue is full/);
  assert.ok(!r.body.includes("rate_limit_exceeded"));
});

test("upstream failure surfaces as 502", async () => {
  h.upstreamHandler = (req, res) => {
    req.resume();
    res.destroy();
  };
  const r = await h.request();
  assert.strictEqual(r.status, 502);
});
