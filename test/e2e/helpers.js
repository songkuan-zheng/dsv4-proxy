"use strict";
/**
 * Shared harness for end-to-end tests: a mock upstream plus a real proxy
 * process, so the whole request path is exercised (buffering, http-proxy,
 * streaming, headers) rather than the transform functions in isolation.
 */

const http = require("http");
const { spawn } = require("child_process");
const path = require("path");

const ENTRY = path.join(__dirname, "..", "..", "src", "index.js");

class Harness {
  constructor() {
    this.upstreamHandler = (_req, res) => res.end();
    this.stdout = "";
    this.proc = null;
    this.server = null;
    this.port = 0;
    this.proxyPort = 0;
  }

  async startUpstream() {
    this.server = http.createServer((req, res) => this.upstreamHandler(req, res));
    await new Promise((r) => this.server.listen(0, "127.0.0.1", r));
    this.port = this.server.address().port;
    return this.port;
  }

  async startProxy(env = {}) {
    this.stdout = "";
    // Port 0 would be ideal but the proxy binds explicitly, so pick a free one.
    const probe = http.createServer();
    await new Promise((r) => probe.listen(0, "127.0.0.1", r));
    this.proxyPort = probe.address().port;
    await new Promise((r) => probe.close(r));

    this.proc = spawn("node", [ENTRY], {
      env: {
        ...process.env,
        UPSTREAM: `http://127.0.0.1:${this.port}`,
        PORT: String(this.proxyPort),
        LOG_REASONING: "1",
        ...env,
      },
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("proxy startup timeout")), 8000);
      this.proc.stdout.on("data", (d) => {
        this.stdout += d.toString();
        if (this.stdout.includes("listening")) {
          clearTimeout(timer);
          resolve();
        }
      });
      this.proc.stderr.on("data", (d) => {
        this.stdout += d.toString();
      });
      this.proc.on("exit", (code) => reject(new Error(`proxy exited early: ${code}`)));
    });
  }

  async stopProxy() {
    if (!this.proc) return;
    const p = this.proc;
    this.proc = null;
    await new Promise((r) => {
      p.on("exit", r);
      p.kill();
    });
  }

  async stop() {
    await this.stopProxy();
    if (this.server) await new Promise((r) => this.server.close(r));
  }

  /** Wait for a line to appear on the proxy's stdout. */
  async waitForLog(sub, ms = 3000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (this.stdout.includes(sub)) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`log never contained ${JSON.stringify(sub)}\n--- got ---\n${this.stdout}`);
  }

  request(opts = {}) {
    const {
      path: p = "/v1/chat/completions",
      method = "POST",
      body = null,
      headers = {},
      chunked = false,
    } = opts;
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port: this.proxyPort, path: p, method, headers },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const raw = Buffer.concat(chunks);
            resolve({ status: res.statusCode, headers: res.headers, raw, body: raw.toString("utf-8") });
          });
        }
      );
      req.on("error", reject);
      if (body !== null) {
        // Two writes without content-length force chunked encoding, which the
        // rewriter has to normalise back to a fixed length.
        if (chunked && body.length > 1) {
          req.write(body.slice(0, 1));
          req.write(body.slice(1));
        } else {
          req.write(body);
        }
      }
      req.end();
    });
  }

  /** Upstream that records the request it received and replies 200. */
  recordUpstream(response) {
    const seen = {};
    this.upstreamHandler = (req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        seen.raw = Buffer.concat(chunks).toString("utf-8");
        seen.headers = req.headers;
        try {
          seen.body = JSON.parse(seen.raw);
        } catch {}
        const body = JSON.stringify(response || { id: "x", choices: [] });
        res.writeHead(200, {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        });
        res.end(body);
      });
    };
    return seen;
  }

  /** Upstream that answers with a tool call carrying reasoning. */
  toolCallUpstream(reasoning, toolCallId) {
    return this.recordUpstream({
      id: "x",
      choices: [{
        index: 0,
        message: {
          role: "assistant", content: null, reasoning_content: reasoning,
          tool_calls: [{ id: toolCallId, type: "function",
            function: { name: "read_file", arguments: "{}" } }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 20, reasoning_tokens: 15 },
    });
  }

  /** Upstream that reports a given reasoning_tokens count. */
  reasoningUpstream(reasoningTokens) {
    return this.recordUpstream({
      id: "x",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, reasoning_tokens: reasoningTokens },
    });
  }
}

const JSON_HEADERS = { "content-type": "application/json" };

function chatBody(extra = {}) {
  return JSON.stringify({
    model: "deepseek-v4-flash-0731",
    messages: [{ role: "user", content: "hi" }],
    ...extra,
  });
}

const TOOLS_PARAM = [
  { type: "function", function: { name: "read_file", description: "Read a file" } },
];

/** n tool turns ending on a tool result; `opener` identifies the session. */
function agentBody(n, opener = "go", extra = {}) {
  const messages = [{ role: "user", content: opener }];
  for (let i = 0; i < n; i++) {
    messages.push({ role: "assistant", content: null,
      tool_calls: [{ id: `t${i}`, type: "function",
        function: { name: "read_file", arguments: "{}" } }] });
    messages.push({ role: "tool", tool_call_id: `t${i}`, content: `result ${i}` });
  }
  return JSON.stringify({ model: "m", tools: TOOLS_PARAM, messages, ...extra });
}

module.exports = { Harness, JSON_HEADERS, chatBody, agentBody, TOOLS_PARAM };
