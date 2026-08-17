"use strict";
/**
 * Deadlock escape.
 *
 * Past roughly 60 empty <think></think> turns the model stops reasoning
 * deterministically — measured 12/12 empty responses at 60, 120 and 170 turns
 * versus 4/12 at 20. It then produces nothing worth caching, so those turns stay
 * empty forever. Appending one line to the trailing tool result breaks the
 * pattern: on a deadlocked conversation median reasoning went 1 -> 1390 with
 * finish_reason staying tool_calls in 6/6 runs.
 *
 * The trigger reads RESPONSES, not requests. An earlier version checked whether
 * recent assistant messages carried reasoning_content, but backfill writes
 * exactly that field, so the nudge saw its own repair and stayed silent while
 * the model was demonstrably stuck.
 *
 * Wording matters: "Think carefully about what to do next before responding."
 * keeps the agent loop, whereas "before answering, reason step by step" pushed
 * 4/6 runs to finish_reason=stop — the model stopped calling tools.
 */

/** Per-session ring of recent reasoning_tokens values, LRU-evicted. */
class DeadlockTracker {
  constructor({ consecutive, maxSessions }) {
    this.consecutive = consecutive;
    this.maxSessions = maxSessions;
    this.history = new Map();
  }
  record(key, tokens) {
    if (!key || typeof tokens !== "number") return;
    const prev = this.history.get(key);
    const arr = prev || [];
    if (prev) this.history.delete(key); // refresh LRU position
    arr.push(tokens);
    while (arr.length > this.consecutive) arr.shift();
    this.history.set(key, arr);
    while (this.history.size > this.maxSessions) {
      this.history.delete(this.history.keys().next().value);
    }
  }
  /** True once the model returned an empty thinking block N times running. */
  isDeadlocked(key) {
    if (!key) return false;
    const arr = this.history.get(key);
    if (!arr || arr.length < this.consecutive) return false;
    return arr.every((t) => t <= 1);
  }
}

/**
 * Append the nudge to the trailing tool result when the model has actually
 * stopped thinking. Returns whether the body changed.
 */
function nudgeToolResult(body, { text, minTurns, deadlocked }) {
  if (!text) return false;
  if (!body || !Array.isArray(body.messages)) return false;
  const msgs = body.messages;
  const last = msgs[msgs.length - 1];
  if (!last || last.role !== "tool") return false;
  if (typeof last.content !== "string") return false;

  let turns = 0;
  for (const m of msgs) {
    if (m && m.role === "assistant" && Array.isArray(m.tool_calls)) turns++;
  }
  // A fresh session has no history to copy from; never nudge it.
  if (turns < minTurns) return false;
  if (!deadlocked) return false;
  if (last.content.endsWith(text)) return false; // idempotent on retries

  last.content += "\n\n" + text;
  return true;
}

module.exports = { DeadlockTracker, nudgeToolResult };
