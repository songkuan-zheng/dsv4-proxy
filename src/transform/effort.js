"use strict";
/**
 * reasoning_effort injection.
 *
 * DeepSeek-V4 realises the effort level as a text prefix prepended to the
 * prompt, and SGLang treats a missing reasoning_effort as "none" — no thinking
 * block at all. Clients unaware of the parameter therefore get zero reasoning,
 * so a default is injected here.
 *
 * Verified reaching the model by prompt-token delta on this deployment:
 * low=17, high=96 (+79), max=109 (+92), matching the model card's prefix texts.
 */

/**
 * @param {object} body       parsed chat-completions body, mutated in place
 * @param {string|number|null} effort  value to inject; null disables
 * @param {boolean} override  also overwrite a client-supplied value
 * @returns {boolean} whether the body changed
 */
function injectEffort(body, effort, override) {
  if (effort === null || effort === undefined) return false;
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  // null and undefined both mean "not supplied" upstream.
  const supplied =
    body.reasoning_effort !== undefined && body.reasoning_effort !== null;
  if (supplied && !override) return false;
  if (body.reasoning_effort === effort) return false;
  body.reasoning_effort = effort;
  return true;
}

module.exports = { injectEffort };
