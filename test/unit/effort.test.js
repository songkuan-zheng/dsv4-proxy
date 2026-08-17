"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { injectEffort } = require("../../src/transform/effort");
const { resolveEffort } = require("../../src/config");

test("injects when the client sent nothing", () => {
  const body = { model: "m" };
  assert.strictEqual(injectEffort(body, "max", false), true);
  assert.strictEqual(body.reasoning_effort, "max");
});

test("null counts as not supplied", () => {
  // null and undefined mean the same thing upstream.
  const body = { reasoning_effort: null };
  assert.strictEqual(injectEffort(body, "max", false), true);
  assert.strictEqual(body.reasoning_effort, "max");
});

test("client value wins unless override is set", () => {
  const body = { reasoning_effort: "low" };
  assert.strictEqual(injectEffort(body, "max", false), false);
  assert.strictEqual(body.reasoning_effort, "low");
  assert.strictEqual(injectEffort(body, "max", true), true);
  assert.strictEqual(body.reasoning_effort, "max");
});

test("no-op when the value already matches", () => {
  const body = { reasoning_effort: "max" };
  assert.strictEqual(injectEffort(body, "max", true), false);
});

test("disabled when effort is null", () => {
  const body = { model: "m" };
  assert.strictEqual(injectEffort(body, null, false), false);
  assert.ok(!("reasoning_effort" in body));
});

test("resolveEffort accepts named levels, numbers, and off switches", () => {
  assert.strictEqual(resolveEffort("max"), "max");
  assert.strictEqual(resolveEffort("low"), "low");
  assert.strictEqual(resolveEffort("0.5"), 0.5);
  assert.strictEqual(resolveEffort("off"), null);
  assert.strictEqual(resolveEffort(""), null);
  assert.strictEqual(resolveEffort(undefined), "max", "defaults to max");
  const errors = [];
  assert.strictEqual(resolveEffort("bogus", (m) => errors.push(m)), null);
  assert.strictEqual(errors.length, 1, "misconfiguration is reported");
});
