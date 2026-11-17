// Unit tests for the proof module's fallback behavior.
// The circuit input signal schema is unknown (see README "Gaps"), so
// generateProof() must report "skipped" — never invent signal names.
import test from "node:test";
import assert from "node:assert/strict";
import { buildCircuitInput, generateProof, parseSchemaEnv, UNKNOWN_SCHEMA_REASON } from "../src/proof.js";

const TASK_INPUT = {
  registered_vk: "0x7d3a1111",
  proof_vk: "0x7d3a1111",
  minimum: "1000",
  public_balance: "1460",
  expiry_block: 19842201,
  current_block: 19832000,
  recipient: "0xDe42abc9f01",
  condition_recipient: "0xde42abc9f01",
  amount: "500",
  max_transfer: "1000",
  proof_tx: "0xa4c1tx001",
};

test("generateProof without a schema returns skipped, never throws or guesses", async () => {
  const res = await generateProof(TASK_INPUT, {
    wasmPath: "circuits/gatekeeper.wasm",
    zkeyPath: "circuits/gatekeeper_final.zkey",
    schema: null,
  });
  assert.equal(res.skipped, true);
  assert.equal(res.reason, UNKNOWN_SCHEMA_REASON);
});

test("buildCircuitInput without a schema throws the documented error code", () => {
  assert.throws(() => buildCircuitInput(TASK_INPUT, null), (err) => err.code === UNKNOWN_SCHEMA_REASON);
  assert.throws(() => buildCircuitInput(TASK_INPUT, {}), (err) => err.code === UNKNOWN_SCHEMA_REASON);
});

test("buildCircuitInput maps fields through a provided schema", () => {
  const schema = { registeredVk: "registered_vk", minimum: "minimum", amount: "amount" };
  const input = buildCircuitInput(TASK_INPUT, schema);
  assert.deepEqual(input, { registeredVk: "0x7d3a1111", minimum: "1000", amount: "500" });
});

test("buildCircuitInput throws naming the missing task field", () => {
  const schema = { someSignal: "nonexistent_field" };
  assert.throws(() => buildCircuitInput(TASK_INPUT, schema), /nonexistent_field/);
});

test("parseSchemaEnv: empty -> null, valid JSON -> object, bad JSON -> throws", () => {
  assert.equal(parseSchemaEnv(""), null);
  assert.equal(parseSchemaEnv("   "), null);
  assert.deepEqual(parseSchemaEnv('{"a":"b"}'), { a: "b" });
  assert.throws(() => parseSchemaEnv("{not json"), SyntaxError);
  assert.throws(() => parseSchemaEnv("[1,2]"), /JSON object/);
});
