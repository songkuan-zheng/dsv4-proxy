"use strict";
/**
 * reasoning_content backfill — the main workaround.
 *
 * DeepSeek-V4 requires the reasoning of previous assistant turns to be replayed
 * when the request carries tools:
 *
 *   "must participate in the context concatenation and must be passed back to
 *    the API in all subsequent user interaction turns"
 *   — api-docs.deepseek.com/guides/thinking_mode
 *
 * The hosted API answers 400 when it is missing. Anthropic-to-OpenAI
 * translation layers drop it (Claude Code strips the thinking blocks, gateways
 * do not re-inject them), and SGLang accepts the request instead of rejecting
 * it — rendering each missing field as an empty <think></think>. Those
 * accumulate as few-shot evidence that "this assistant does not think", and the
 * model copies the pattern.
 *
 * So the proxy remembers the reasoning that came back with each tool call and
 * puts it back on the way in.
 */

const { contentKey } = require("../crypto");

/** Mirrors SGLang's find_last_user_index: only user/developer count. */
function findLastUserIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const r = messages[i] && messages[i].role;
    if (r === "user" || r === "developer") return i;
  }
  return -1;
}

/**
 * Restore reasoning_content on assistant turns that lost it.
 *
 * How far back to repair mirrors SGLang's own rule:
 *
 *   with tools    — it sets effective_drop_thinking=False and renders every
 *                   turn's thinking, so repair all of them
 *   without tools — it runs _drop_thinking_messages, which strips reasoning
 *                   from turns *before the last user message*; repairing those
 *                   is wasted prompt, but everything after is still rendered
 *
 * Note the index counts only role user/developer: tool results render as
 * <|User|> but do not move it, so an agent loop keeps a very early boundary and
 * nearly every turn stays worth repairing.
 *
 * Keys: tool_call_id when the turn called a tool, otherwise a hash of its
 * content — a turn that answered instead of calling a tool still needs its
 * reasoning replayed, and has no id to key on.
 *
 * @returns {Promise<{repaired: number, filled: Array}>}
 */
async function backfillReasoning(body, cache, opts) {
  const { maxTurns, contentKeyChars, collectFilled = 0 } = opts;
  if (!body || !Array.isArray(body.messages)) return { repaired: 0, filled: [] };

  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  const minIndex = hasTools ? 0 : findLastUserIndex(body.messages) + 1;
  const limit = maxTurns > 0 ? maxTurns : Infinity;

  // Pass 1: collect what needs repairing and which keys could supply it, so the
  // whole request costs one batched round trip instead of one per turn.
  const candidates = [];
  for (let i = body.messages.length - 1; i >= minIndex; i--) {
    const m = body.messages[i];
    if (!m || m.role !== "assistant") continue;
    if (m.reasoning_content) continue; // client kept its own
    if (!Array.isArray(m.tool_calls) || m.tool_calls.length === 0) {
      const ck = contentKey(
        typeof m.content === "string" ? m.content : "",
        contentKeyChars
      );
      if (ck) candidates.push({ msg: m, index: i, keys: [ck] });
      continue;
    }
    const ids = m.tool_calls.filter((tc) => tc && tc.id).map((tc) => tc.id);
    if (ids.length) candidates.push({ msg: m, index: i, keys: ids });
  }
  if (!candidates.length) return { repaired: 0, filled: [] };

  const found = await cache.getMany([
    ...new Set(candidates.flatMap((c) => c.keys)),
  ]);

  // Pass 2: apply. Candidates are newest-first, so a maxTurns cap keeps the
  // turns nearest the end.
  let repaired = 0;
  const filled = [];
  for (const c of candidates) {
    if (repaired >= limit) break;
    for (const k of c.keys) {
      const hit = found.get(k);
      if (hit) {
        c.msg.reasoning_content = hit;
        repaired++;
        if (filled.length < collectFilled) {
          filled.push({ key: k, index: c.index, text: hit });
        }
        break;
      }
    }
  }
  return { repaired, filled };
}

module.exports = { findLastUserIndex, backfillReasoning };
