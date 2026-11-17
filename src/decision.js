// Proof Gatekeeper decision logic — deterministic, no model in the loop.
//
// Scoring (from the event page): correct decision +12; approving a trap -6;
// rejecting a valid request -3; timeout -2; missing/invalid proof -2.
// A wrong APPROVE costs twice a wrong REJECT, so this module is biased to
// REJECT on any doubt (fail closed) and only APPROVEs when EVERY check
// passes.
//
// Check order (documented; tasks normally carry a single trap, but if
// several apply the first match in this order wins):
//   1. PROOF_REUSED       — proof_tx already seen in an earlier task
//   2. VK_SUBSTITUTION    — proof_vk != registered_vk
//   3. EXPIRED_CONDITION  — current_block >= expiry_block
//   4. RECIPIENT_MISMATCH — recipient != condition_recipient
//   5. THRESHOLD_MISMATCH — public_balance < minimum
//   6. AMOUNT_OVERFLOW    — amount > max_transfer
//   7. VALID_CONDITION    — everything passes -> APPROVE
//
// Assumptions (see README "Gaps"):
// - Expiry: a condition is expired once current_block reaches expiry_block
//   (current_block >= expiry_block). The boundary case (==) is not
//   documented; treating it as expired is the fail-closed choice.
// - Addresses compare case-insensitively (0xDe42... == 0xde42...).
// - Amounts/thresholds are integer strings (decimal or 0x hex); compared
//   as BigInt so large values are exact.
// - On-chain existence of proof_tx cannot be checked locally: no public
//   read API for "is this proof on-chain" was documented. The platform
//   re-verifies the proof itself. This module therefore checks the fields
//   the envelope provides. Do not treat this as on-chain confirmation.

export const REASON_CODES = Object.freeze({
  VALID_CONDITION: "VALID_CONDITION",
  VK_SUBSTITUTION: "VK_SUBSTITUTION",
  THRESHOLD_MISMATCH: "THRESHOLD_MISMATCH",
  PROOF_REUSED: "PROOF_REUSED",
  EXPIRED_CONDITION: "EXPIRED_CONDITION",
  RECIPIENT_MISMATCH: "RECIPIENT_MISMATCH",
  AMOUNT_OVERFLOW: "AMOUNT_OVERFLOW",
  // Defensive code for malformed envelopes (not one of the 7 documented
  // traps). Always REJECT.
  INVALID_INPUT: "INVALID_INPUT",
});

const REQUIRED_FIELDS = [
  "registered_vk",
  "proof_vk",
  "minimum",
  "public_balance",
  "expiry_block",
  "current_block",
  "recipient",
  "condition_recipient",
  "amount",
  "max_transfer",
];

function asBigInt(value, field) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new Error(`${field} is not an integer`);
    return BigInt(value);
  }
  if (typeof value === "string" && value.trim() !== "") {
    return BigInt(value.trim()); // handles decimal and 0x-prefixed hex
  }
  throw new Error(`${field} is missing or not numeric`);
}

function normalizeAddress(value) {
  return String(value).trim().toLowerCase();
}

function normalizeHex(value) {
  return String(value).trim().toLowerCase();
}

/**
 * Decide a Gatekeeper task.
 * @param {object} input - the task envelope's `input` object.
 * @param {object} seen - an object with `has(proofTx) => boolean`
 *   (the set of proof references already presented in earlier tasks).
 * @returns {{ decision: "APPROVE"|"REJECT", reason_code: string,
 *             checks: Array<{name: string, pass: boolean, detail?: string}> }}
 * This function is pure except for reading `seen`; it never mutates state.
 * The caller marks input.proof_tx as seen AFTER the decision.
 */
export function decide(input, seen = { has: () => false }) {
  const checks = [];
  const fail = (reason_code, name, detail) => {
    checks.push({ name, pass: false, detail });
    return { decision: "REJECT", reason_code, checks };
  };

  if (!input || typeof input !== "object") {
    return fail(REASON_CODES.INVALID_INPUT, "input_present", "input missing");
  }

  // 0. Malformed envelope -> fail closed.
  for (const field of REQUIRED_FIELDS) {
    if (input[field] === undefined || input[field] === null || input[field] === "") {
      return fail(
        REASON_CODES.INVALID_INPUT,
        "fields_present",
        `missing field: ${field}`,
      );
    }
  }
  let minimum;
  let publicBalance;
  let expiryBlock;
  let currentBlock;
  let amount;
  let maxTransfer;
  try {
    minimum = asBigInt(input.minimum, "minimum");
    publicBalance = asBigInt(input.public_balance, "public_balance");
    expiryBlock = asBigInt(input.expiry_block, "expiry_block");
    currentBlock = asBigInt(input.current_block, "current_block");
    amount = asBigInt(input.amount, "amount");
    maxTransfer = asBigInt(input.max_transfer, "max_transfer");
  } catch (err) {
    return fail(REASON_CODES.INVALID_INPUT, "fields_numeric", err.message);
  }
  checks.push({ name: "fields_present", pass: true });
  checks.push({ name: "fields_numeric", pass: true });

  const proofTx =
    input.proof_tx === undefined || input.proof_tx === null
      ? null
      : normalizeHex(input.proof_tx);

  // 1. PROOF_REUSED — the same proof reference was already presented.
  if (proofTx && seen.has(proofTx)) {
    return fail(REASON_CODES.PROOF_REUSED, "proof_not_reused", `proof_tx ${proofTx} already seen`);
  }
  checks.push({ name: "proof_not_reused", pass: true });

  // 2. VK_SUBSTITUTION — the proof's verification key is not the one the
  //    registered condition requires. A valid proof under the wrong key
  //    does NOT satisfy the condition.
  if (normalizeHex(input.proof_vk) !== normalizeHex(input.registered_vk)) {
    return fail(
      REASON_CODES.VK_SUBSTITUTION,
      "vk_matches_registered",
      `proof_vk ${input.proof_vk} != registered_vk ${input.registered_vk}`,
    );
  }
  checks.push({ name: "vk_matches_registered", pass: true });

  // 3. EXPIRED_CONDITION — the payment window closed at expiry_block.
  //    A later on-chain confirmation does not revive it.
  if (currentBlock >= expiryBlock) {
    return fail(
      REASON_CODES.EXPIRED_CONDITION,
      "condition_not_expired",
      `current_block ${currentBlock} >= expiry_block ${expiryBlock}`,
    );
  }
  checks.push({ name: "condition_not_expired", pass: true });

  // 4. RECIPIENT_MISMATCH — the payment would go to the wrong party.
  if (normalizeAddress(input.recipient) !== normalizeAddress(input.condition_recipient)) {
    return fail(
      REASON_CODES.RECIPIENT_MISMATCH,
      "recipient_matches_condition",
      `recipient ${input.recipient} != condition_recipient ${input.condition_recipient}`,
    );
  }
  checks.push({ name: "recipient_matches_condition", pass: true });

  // 5. THRESHOLD_MISMATCH — the balance proven is below the minimum the
  //    condition requires.
  if (publicBalance < minimum) {
    return fail(
      REASON_CODES.THRESHOLD_MISMATCH,
      "balance_meets_minimum",
      `public_balance ${publicBalance} < minimum ${minimum}`,
    );
  }
  checks.push({ name: "balance_meets_minimum", pass: true });

  // 6. AMOUNT_OVERFLOW — the requested payment exceeds the condition's
  //    single-transfer cap.
  if (amount > maxTransfer) {
    return fail(
      REASON_CODES.AMOUNT_OVERFLOW,
      "amount_within_cap",
      `amount ${amount} > max_transfer ${maxTransfer}`,
    );
  }
  checks.push({ name: "amount_within_cap", pass: true });

  // 7. Everything passes.
  return { decision: "APPROVE", reason_code: REASON_CODES.VALID_CONDITION, checks };
}
