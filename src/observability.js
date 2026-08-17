"use strict";
/**
 * Logging and diagnostics.
 *
 * Two levels, deliberately separated:
 *
 *   [effort]  one line per request and per response, parameters and counters
 *             only — never message or reasoning content. Safe to leave on.
 *   [dump]/[rdump]/[bfill]/[scrub]  investigation aids that DO print real
 *             content. All default to off.
 */

function fmt(v) {
  return v === undefined || v === null ? "-" : String(v);
}

class Logger {
  constructor(config) {
    this.config = config;
    this.dumpCount = 0;
    this.dumpResponseCount = 0;
    this.dumpScrubCount = 0;
  }

  dbg(...args) {
    if (this.config.debug) console.log("[dbg]", ...args);
  }
  info(...args) {
    console.log(...args);
  }
  error(...args) {
    console.error(...args);
  }

  /** One line per request: what was asked for and what we changed. */
  request(reqId, info) {
    if (!this.config.logReasoning) return;
    console.log(
      `[effort] ${reqId} req model=${fmt(info.model)} ` +
        `effort_client=${fmt(info.effortClient)} effort_sent=${fmt(info.effortSent)}` +
        `${info.injected ? " injected=yes" : ""}` +
        `${info.backfilled ? ` backfilled=${info.backfilled}` : ""}` +
        `${info.nudged ? " nudged=yes" : ""}` +
        `${info.scrubbed ? ` scrubbed=${info.scrubbed}` : ""} ` +
        `stream=${fmt(info.stream)} max_tokens=${fmt(info.maxTokens)} ` +
        `messages=${fmt(info.messages)}`
    );
  }

  /** One line per response: what the model actually did. */
  response(req, status, stats, cacheSize) {
    if (!this.config.logReasoning || !req.isChat) return;
    const s = stats || {};
    const dur = req.t0 ? ((Date.now() - req.t0) / 1000).toFixed(1) : "-";
    console.log(
      `[effort] ${req.reqId} res status=${status} ` +
        `prompt=${fmt(s.promptTokens)} completion=${fmt(s.completionTokens)} ` +
        `reasoning=${fmt(s.reasoningTokens)} finish=${fmt(s.finishReason)} ` +
        `thinking=${s.sawReasoning ? "yes" : "no"} ` +
        `content=${s.sawContent ? "yes" : "no"} dur=${dur}s` +
        (cacheSize !== undefined ? ` cache=${cacheSize}` : "")
    );
  }

  scrubDetected(unit, count) {
    if (this.config.dumpScrubChars <= 0 || this.dumpScrubCount >= 12) return;
    this.dumpScrubCount++;
    console.log(
      `[scrub] x${count} len=${unit.length} unit=` +
        JSON.stringify(unit.slice(0, this.config.dumpScrubChars))
    );
  }

  /** Which tool_call_id each restored trace came from, to match against rdump. */
  backfilled(filled) {
    if (this.config.dumpBackfillChars <= 0) return;
    for (const f of filled) {
      console.log(
        `[bfill] key=${f.key} msg#${f.index} rc=` +
          JSON.stringify(f.text.slice(0, this.config.dumpBackfillChars))
      );
    }
  }

  /** What the model reasoned and wrote — for judging quality, not just length. */
  responseContent(req, stats) {
    const n = this.config.dumpResponseChars;
    if (n <= 0 || !req.isChat) return;
    if (this.dumpResponseCount >= this.config.dumpResponseLimit) return;
    this.dumpResponseCount++;
    const clip = (s) => (s ? JSON.stringify(String(s).slice(0, n)) : "(none)");
    console.log(
      `[rdump] ${req.reqId} tools=${(stats.toolNames || []).join(",") || "(none)"} ` +
        `ids=${[...(stats.toolCallIds || [])].join(",") || "(none)"}`
    );
    console.log(`[rdump] ${req.reqId} reasoning=${clip(stats.reasoningText)}`);
    console.log(`[rdump] ${req.reqId} content=${clip(stats.contentText)}`);
  }

  /** Request shape: roles, field names, lengths, block types. No text. */
  requestShape(reqId, body) {
    const c = this.config;
    if (c.dumpRequest === "off" || this.dumpCount >= c.dumpLimit) return;
    const msgs = Array.isArray(body.messages) ? body.messages : [];
    if (msgs.length < c.dumpMinMessages) return;
    this.dumpCount++;

    if (c.dumpRequest === "full") {
      console.log(`[dump] ${reqId} FULL BODY (includes prompt content):`);
      console.log(JSON.stringify(body));
      return;
    }

    const top = {};
    for (const [k, v] of Object.entries(body)) {
      if (k === "messages" || k === "tools") continue;
      top[k] =
        v && typeof v === "object"
          ? `<${Array.isArray(v) ? "array" : "object"} ${JSON.stringify(v).length}c>`
          : v;
    }
    console.log(`[dump] ${reqId} top ${JSON.stringify(top)}`);

    const tools = Array.isArray(body.tools) ? body.tools : [];
    console.log(
      `[dump] ${reqId} tools n=${tools.length} ` +
        `[${tools.map((t) => (t.function && t.function.name) || t.type).join(",")}]`
    );

    const roles = {};
    let withReasoning = 0;
    let withToolCalls = 0;
    for (const m of msgs) {
      roles[m.role] = (roles[m.role] || 0) + 1;
      if (m.reasoning_content) withReasoning++;
      if (Array.isArray(m.tool_calls)) withToolCalls++;
    }
    console.log(
      `[dump] ${reqId} messages n=${msgs.length} roles=${JSON.stringify(roles)} ` +
        `assistant_with_reasoning=${withReasoning} with_tool_calls=${withToolCalls}`
    );

    // The thinking pattern the model actually sees, one symbol per tool-calling
    // turn: '#' carries reasoning, '.' renders as an empty <think></think>.
    // This is what drives the copying behaviour, so it is the fastest way to
    // see a collapse.
    const marks = [];
    for (const m of msgs) {
      if (!m || m.role !== "assistant") continue;
      if (!Array.isArray(m.tool_calls) || m.tool_calls.length === 0) continue;
      marks.push(m.reasoning_content ? "#" : ".");
    }
    if (marks.length) {
      const filled = marks.filter((x) => x === "#").length;
      let tailRun = 0;
      for (let i = marks.length - 1; i >= 0 && marks[i] === "."; i--) tailRun++;
      console.log(
        `[dump] ${reqId} think-pattern turns=${marks.length} ` +
          `filled=${filled} (${((100 * filled) / marks.length).toFixed(0)}%) ` +
          `trailing_empty=${tailRun}`
      );
      console.log(`[dump] ${reqId} think-pattern tail=${marks.slice(-60).join("")}`);
    }
  }
}

module.exports = { Logger, fmt };
