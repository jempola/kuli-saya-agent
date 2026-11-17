// Configuration: environment variables only. No secrets are hardcoded.
// See .env.example for the full list.
import { fileURLToPath } from "node:url";
import path from "node:path";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid ${name}: ${raw}`);
  return n;
}

export const GATEKEEPER_VK_HASH =
  "0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0";

export const config = {
  rootDir,
  host: process.env.HOST || "0.0.0.0",
  port: intEnv("PORT", 3000),

  // Required. Server refuses to start without it (see src/index.js).
  hmacSecret: process.env.AGENT_GAMES_HMAC_SECRET || "",

  // Optional: if empty, Kurier submission is skipped (decision + local proof
  // are still returned).
  kurierApiKey: process.env.KURIER_API_KEY || "",
  kurierBaseUrl:
    process.env.KURIER_BASE_URL || "https://api.kurier.xyz/api/v1",

  // Circuit artifacts (bundled in ./circuits, downloaded from
  // https://agentgames.zkverify.io/circuits/). See scripts/download-circuits.sh.
  circuitWasmPath:
    process.env.CIRCUIT_WASM_PATH ||
    path.join(rootDir, "circuits", "gatekeeper.wasm"),
  circuitZkeyPath:
    process.env.CIRCUIT_ZKEY_PATH ||
    path.join(rootDir, "circuits", "gatekeeper_final.zkey"),
  circuitVkeyPath:
    process.env.CIRCUIT_VKEY_PATH ||
    path.join(rootDir, "circuits", "gatekeeper.vkey.json"),
  gatekeeperVkHash: GATEKEEPER_VK_HASH,

  // Persistent state: seen proof references (PROOF_REUSED) + idempotency
  // cache (task_id -> response). JSON file, written atomically.
  seenStorePath:
    process.env.SEEN_STORE_PATH || path.join(rootDir, "data", "state.json"),

  // Hard response deadline is 60s. We aim to answer within 50s so the
  // platform never sees a timeout from us.
  responseBudgetMs: intEnv("RESPONSE_BUDGET_MS", 50_000),
  // Max time spent polling Kurier for Finalized within one task.
  kurierPollBudgetMs: intEnv("KURIER_POLL_BUDGET_MS", 40_000),
  kurierPollIntervalMs: intEnv("KURIER_POLL_INTERVAL_MS", 5_000),

  // Max inbound body size (task envelopes are a few KB).
  maxBodyBytes: intEnv("MAX_BODY_BYTES", 1_048_576),
};
