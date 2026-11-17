// Local Groth16 proof generation with snarkjs + the gatekeeper circuit.
//
// ⚠️ BLOCKER — CIRCUIT INPUT SIGNAL SCHEMA UNKNOWN (see README "Gaps"):
// The gatekeeper circuit's input signal NAMES are not published anywhere
// public. The .wasm / .zkey files were inspected (strings, verification
// key): they contain no signal names — only obfuscated component symbols —
// so the names cannot be extracted from the artifacts. Without the names,
// `groth16.fullProve(input, wasm, zkey)` cannot be called.
//
// This module therefore NEVER invents signal names. `generateProof()`:
//   - returns { skipped: true, reason: "UNKNOWN_CIRCUIT_INPUT_SCHEMA" }
//     while no schema is configured, and the agent answers with its
//     decision + reason_code + proof_tx only (a missing proof costs -2,
//     but a fabricated proof would be worse — it would fail verification
//     and could be treated as an invalid proof);
//   - once the official schema is known (practice mode / dashboard /
//     Discord), set GATEKEEPER_INPUT_SCHEMA_JSON to a JSON object mapping
//     circuit signal names -> task input field names, and proof generation
//     runs for real.
//
// The schema mapping is deliberately data, not code: e.g.
//   {"registeredVk":"registered_vk","proofVk":"proof_vk","minimum":"minimum", ...}
// Values in the input are converted to the field types the circuit
// expects (decimal strings for field elements; hex addresses are passed
// through as 0x-prefixed strings — adjust the mapping/converters once the
// real schema and its types are known).

import { groth16 } from "snarkjs";
import fs from "node:fs";

export const UNKNOWN_SCHEMA_REASON = "UNKNOWN_CIRCUIT_INPUT_SCHEMA";

/**
 * Build the witness input object from a task input, using a schema
 * mapping { signalName: taskFieldName }.
 * @throws {Error} with code UNKNOWN_CIRCUIT_INPUT_SCHEMA when no schema
 *   is configured, or a plain Error naming the missing field.
 */
export function buildCircuitInput(taskInput, schema) {
  if (!schema || typeof schema !== "object" || Object.keys(schema).length === 0) {
    const err = new Error(
      "Gatekeeper circuit input signal schema is unknown. " +
        "Obtain the official signal names (practice mode / dashboard / Discord) " +
        "and set GATEKEEPER_INPUT_SCHEMA_JSON. Signal names must never be guessed.",
    );
    err.code = UNKNOWN_SCHEMA_REASON;
    throw err;
  }
  const input = {};
  for (const [signal, field] of Object.entries(schema)) {
    if (taskInput[field] === undefined || taskInput[field] === null) {
      throw new Error(`Cannot build circuit input: task field "${field}" (signal "${signal}") is missing`);
    }
    input[signal] = String(taskInput[field]);
  }
  return input;
}

/**
 * Generate a Groth16 proof for a task input.
 * @param {object} taskInput - the task envelope's `input` object.
 * @param {object} opts - { wasmPath, zkeyPath, schema }
 * @returns {Promise<{skipped: true, reason: string, detail: string}>} when
 *   the schema is unknown, or
 *   { proof, publicSignals } on success.
 * @throws on snarkjs failure (bad artifacts, bad input values).
 */
export async function generateProof(taskInput, opts) {
  const { wasmPath, zkeyPath, schema } = opts;
  let witnessInput;
  try {
    witnessInput = buildCircuitInput(taskInput, schema);
  } catch (err) {
    if (err.code === UNKNOWN_SCHEMA_REASON) {
      return { skipped: true, reason: UNKNOWN_SCHEMA_REASON, detail: err.message };
    }
    throw err;
  }
  if (!fs.existsSync(wasmPath)) throw new Error(`Circuit wasm not found: ${wasmPath}`);
  if (!fs.existsSync(zkeyPath)) throw new Error(`Circuit zkey not found: ${zkeyPath}`);
  const { proof, publicSignals } = await groth16.fullProve(witnessInput, wasmPath, zkeyPath);
  return { proof, publicSignals };
}

/** Verify a proof locally against the bundled verification key. */
export async function verifyProofLocally(vkeyPath, publicSignals, proof) {
  const vkey = JSON.parse(fs.readFileSync(vkeyPath, "utf8"));
  return groth16.verify(vkey, publicSignals, proof);
}

/** Parse GATEKEEPER_INPUT_SCHEMA_JSON (env) into a mapping or null. */
export function parseSchemaEnv(raw) {
  if (!raw || raw.trim() === "") return null;
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("GATEKEEPER_INPUT_SCHEMA_JSON must be a JSON object");
  }
  return parsed;
}
