// Unit tests for the Gatekeeper decision logic: one case per trap + valid.
import test from "node:test";
import assert from "node:assert/strict";
import { decide, REASON_CODES } from "../src/decision.js";

function validInput(overrides = {}) {
  return {
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
    ...overrides,
  };
}

const emptySeen = { has: () => false };

test("VALID_CONDITION -> APPROVE (addresses compare case-insensitively)", () => {
  const r = decide(validInput(), emptySeen);
  assert.equal(r.decision, "APPROVE");
  assert.equal(r.reason_code, REASON_CODES.VALID_CONDITION);
  assert.ok(r.checks.every((c) => c.pass));
});

test("boundary: balance == minimum and amount == max_transfer still APPROVE", () => {
  const r = decide(validInput({ public_balance: "1000", amount: "1000" }), emptySeen);
  assert.equal(r.decision, "APPROVE");
  assert.equal(r.reason_code, REASON_CODES.VALID_CONDITION);
});

test("VK_SUBSTITUTION -> REJECT", () => {
  const r = decide(validInput({ proof_vk: "0x9999different" }), emptySeen);
  assert.equal(r.decision, "REJECT");
  assert.equal(r.reason_code, REASON_CODES.VK_SUBSTITUTION);
});

test("THRESHOLD_MISMATCH -> REJECT when balance below minimum", () => {
  const r = decide(validInput({ public_balance: "999" }), emptySeen);
  assert.equal(r.decision, "REJECT");
  assert.equal(r.reason_code, REASON_CODES.THRESHOLD_MISMATCH);
});

test("PROOF_REUSED -> REJECT when proof_tx already seen", () => {
  const seen = { has: (tx) => tx === "0xa4c1tx001" };
  const r = decide(validInput(), seen);
  assert.equal(r.decision, "REJECT");
  assert.equal(r.reason_code, REASON_CODES.PROOF_REUSED);
});

test("EXPIRED_CONDITION -> REJECT when current_block past expiry", () => {
  const r = decide(validInput({ current_block: 19842202 }), emptySeen);
  assert.equal(r.decision, "REJECT");
  assert.equal(r.reason_code, REASON_CODES.EXPIRED_CONDITION);
});

test("EXPIRED_CONDITION -> REJECT at the boundary current_block == expiry_block (fail closed)", () => {
  const r = decide(validInput({ current_block: 19842201 }), emptySeen);
  assert.equal(r.decision, "REJECT");
  assert.equal(r.reason_code, REASON_CODES.EXPIRED_CONDITION);
});

test("RECIPIENT_MISMATCH -> REJECT", () => {
  const r = decide(validInput({ recipient: "0xdeadbeef000" }), emptySeen);
  assert.equal(r.decision, "REJECT");
  assert.equal(r.reason_code, REASON_CODES.RECIPIENT_MISMATCH);
});

test("AMOUNT_OVERFLOW -> REJECT when amount exceeds max_transfer", () => {
  const r = decide(validInput({ amount: "1001" }), emptySeen);
  assert.equal(r.decision, "REJECT");
  assert.equal(r.reason_code, REASON_CODES.AMOUNT_OVERFLOW);
});

test("INVALID_INPUT -> REJECT when a required field is missing", () => {
  const input = validInput();
  delete input.minimum;
  const r = decide(input, emptySeen);
  assert.equal(r.decision, "REJECT");
  assert.equal(r.reason_code, REASON_CODES.INVALID_INPUT);
});

test("INVALID_INPUT -> REJECT when a numeric field is not numeric", () => {
  const r = decide(validInput({ minimum: "abc" }), emptySeen);
  assert.equal(r.decision, "REJECT");
  assert.equal(r.reason_code, REASON_CODES.INVALID_INPUT);
});

test("hex amounts are compared as BigInt (0x3e8 == 1000)", () => {
  const r = decide(validInput({ minimum: "0x3e8", public_balance: "0x3e8" }), emptySeen);
  assert.equal(r.decision, "APPROVE");
});

test("decide() does not mutate the seen set (caller marks seen after)", () => {
  const seenSet = new Set();
  const seen = { has: (tx) => seenSet.has(tx) };
  decide(validInput(), seen);
  assert.equal(seenSet.size, 0);
});

test("first matching trap in check order wins when several apply", () => {
  // VK mismatch AND expired: VK_SUBSTITUTION is checked first.
  const r = decide(
    validInput({ proof_vk: "0x9999different", current_block: 99999999 }),
    emptySeen,
  );
  assert.equal(r.reason_code, REASON_CODES.VK_SUBSTITUTION);
});
