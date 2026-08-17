"use strict";
/**
 * Loop scrubbing.
 *
 * Turns that stop reasoning emit far more repetition — HF discussion #58
 * measured 0-8 loop fragments on turns that reasoned versus 50-488 on turns
 * that did not — and because the client replays the whole transcript, every
 * fragment is fed back and reinforces the attractor. In real agents the loops
 * fragment into 1-8k character bursts between tool calls, so length-based
 * detectors miss them while the history keeps accumulating.
 *
 * Mitigation reported to work gateway-side: collapse repeated sentences inside
 * assistant messages only, keeping the first occurrence, and apply a small
 * frequency penalty on requests where something was actually removed.
 */

/** Split into lines, breaking overlong lines on sentence boundaries. */
function splitUnits(text, maxUnitChars) {
  const out = [];
  for (const line of text.split("\n")) {
    if (line.length <= maxUnitChars) out.push(line);
    else out.push(...line.split(/(?<=[.!?。！？])\s+/));
  }
  return out;
}

function normalizeUnit(s) {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * A unit is loop-like only if it reads as prose or code. Code fences,
 * horizontal rules, bare brackets and separators repeat by design — an early
 * version stripped ``` occurring 6 times and broke every code block pairing in
 * the replayed history.
 */
function isDedupable(k, minUnitChars) {
  if (k.length < minUnitChars) return false;
  return /[a-zA-Z0-9一-鿿]/.test(k);
}

/**
 * Drop repeats of any short unit occurring minRepeats+ times, keeping its first
 * occurrence.
 *
 * @returns {string|null} cleaned text, or null when there was nothing loop-like
 *   — so callers can distinguish "scrubbed" from "unchanged" without comparing.
 */
function scrubLoops(text, opts) {
  const { minRepeats, minUnitChars, maxUnitChars, onDetect } = opts;
  if (typeof text !== "string" || text.length < 200) return null;
  const units = splitUnits(text, maxUnitChars);
  const counts = new Map();
  for (const u of units) {
    const k = normalizeUnit(u);
    if (!k || k.length > maxUnitChars) continue;
    if (!isDedupable(k, minUnitChars)) continue;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const loopy = new Set();
  for (const [k, c] of counts) if (c >= minRepeats) loopy.add(k);
  if (loopy.size === 0) return null;
  if (onDetect) for (const k of loopy) onDetect(k, counts.get(k));

  const seen = new Set();
  const kept = [];
  for (const u of units) {
    const k = normalizeUnit(u);
    if (loopy.has(k)) {
      if (seen.has(k)) continue;
      seen.add(k);
    }
    kept.push(u);
  }
  const out = kept.join("\n");
  return out.length < text.length ? out : null;
}

/**
 * Scrub every assistant message in place. User and tool messages are never
 * touched. Returns the number of characters removed, which also signals whether
 * to add the frequency penalty.
 */
function scrubAssistantLoops(body, opts) {
  if (!body || !Array.isArray(body.messages)) return 0;
  let removed = 0;
  for (const m of body.messages) {
    if (!m || m.role !== "assistant") continue;
    for (const field of ["content", "reasoning_content"]) {
      const cleaned = scrubLoops(m[field], opts);
      if (cleaned !== null) {
        removed += m[field].length - cleaned.length;
        m[field] = cleaned;
      }
    }
  }
  return removed;
}

module.exports = {
  splitUnits,
  normalizeUnit,
  isDedupable,
  scrubLoops,
  scrubAssistantLoops,
};
