"use strict";
/**
 * Request-side rewriting, in the order it must happen:
 *
 *   1. backfill — restore reasoning the client dropped
 *   2. scrub    — remove loop fragments the model emitted earlier
 *   3. nudge    — break a confirmed deadlock (reads response history)
 *   4. effort   — inject reasoning_effort
 *
 * Backfill runs before scrub so restored traces are scrubbed too; nudge runs
 * after both because its own trigger is response-based and unaffected by them.
 */

const { injectEffort } = require("./effort");
const { backfillReasoning } = require("./backfill");
const { scrubAssistantLoops } = require("./scrub");
const { nudgeToolResult } = require("./nudge");
const { sessionKey } = require("../crypto");

async function applyRequestTransforms(body, ctx) {
  const { config, cache, tracker, log } = ctx;
  const result = {
    backfilled: 0,
    scrubbed: 0,
    nudged: false,
    injected: false,
    sessionKey: null,
    filled: [],
  };

  if (config.backfill && cache) {
    const { repaired, filled } = await backfillReasoning(body, cache, {
      maxTurns: config.backfillMaxTurns,
      contentKeyChars: config.contentKeyChars,
      collectFilled: config.dumpBackfillChars > 0 ? config.dumpBackfillLimit : 0,
    });
    result.backfilled = repaired;
    result.filled = filled;
  }

  if (config.scrub) {
    result.scrubbed = scrubAssistantLoops(body, {
      minRepeats: config.scrubMinRepeats,
      minUnitChars: config.scrubMinUnitChars,
      maxUnitChars: config.scrubMaxUnitChars,
      onDetect:
        config.dumpScrubChars > 0
          ? (unit, count) => log.scrubDetected(unit, count)
          : null,
    });
    // Only on requests that actually contained loops, per the reported recipe —
    // a blanket penalty would distort healthy generations.
    if (
      result.scrubbed > 0 &&
      config.loopFrequencyPenalty > 0 &&
      body.frequency_penalty === undefined
    ) {
      body.frequency_penalty = config.loopFrequencyPenalty;
    }
  }

  result.sessionKey = sessionKey(body.messages);
  if (config.nudgeText && tracker) {
    result.nudged = nudgeToolResult(body, {
      text: config.nudgeText,
      minTurns: config.nudgeMinTurns,
      deadlocked: tracker.isDeadlocked(result.sessionKey),
    });
  }

  result.injected = injectEffort(body, config.effort, config.effortOverride);
  return result;
}

module.exports = { applyRequestTransforms };
