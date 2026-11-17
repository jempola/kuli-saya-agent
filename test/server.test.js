// End-to-end tests for the HTTP server: preflight, HMAC enforcement,
// Gatekeeper decisions, signed responses, idempotency, and PROOF_REUSED
// across two tasks. Uses a temp state file and NO Kurier key (Kurier step
// is skipped), NO real network.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "../src/server.js";
import { signBody, verifyBody } from "../src/hmac.js";

const SECRET = "test-secret-32-bytes-long-value!";

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

async function startTestServer(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kuli-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cfg = {
    hmacSecret: SECRET,
    kurierApiKey: "",
    kurierBaseUrl: "https://api.kurier.xyz/api/v1",
    circuitWasmPath: path.join(process.cwd(), "circuits", "gatekeeper.wasm"),
    circuitZkeyPath: path.join(process.cwd(), "circuits", "gatekeeper_final.zkey"),
    circuitVkeyPath: path.join(process.cwd(), "circuits", "gatekeeper.vkey.json"),
    gatekeeperVkHash: "0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0",
    seenStorePath: path.join(dir, "state.json"),
    responseBudgetMs: 50_000,
    kurierPollBudgetMs: 1_000,
    kurierPollIntervalMs: 10,
    maxBodyBytes: 1_048_576,
  };
  const server = createServer(cfg);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  t.after(() => server.close());
  return { base: `http://127.0.0.1:${port}`, dir };
}

async function postAgent(base, envelope, secret = SECRET) {
  const raw = JSON.stringify(envelope);
  const res = await fetch(`${base}/agent`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-agent-games-signature": signBody(secret, Buffer.from(raw)),
    },
    body: raw,
  });
  const text = await res.text();
  return { res, body: text ? JSON.parse(text) : null, rawResponse: text };
}

test("GET /health returns ok with service info", async (t) => {
  const { base } = await startTestServer(t);
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.service, "kuli-saya-agent");
  assert.equal(data.track, "proof-gatekeeper");
  assert.equal(data.protocolVersion, "v1");
});

test("preflight returns {ok:true, protocolVersion:'v1'} with a valid signature", async (t) => {
  const { base } = await startTestServer(t);
  const { res, body, rawResponse } = await postAgent(base, {
    type: "agent-games.preflight.v1",
    agent_id: "agt_test",
    issued_at: new Date().toISOString(),
    nonce: "abc123",
  });
  assert.equal(res.status, 200);
  assert.deepEqual(body, { ok: true, protocolVersion: "v1" });
  assert.equal(verifyBody(SECRET, Buffer.from(rawResponse), res.headers.get("x-agent-games-signature")), true);
});

test("unsigned / wrongly signed requests are rejected with 401", async (t) => {
  const { base } = await startTestServer(t);
  const raw = JSON.stringify({ type: "agent-games.preflight.v1" });
  const res = await fetch(`${base}/agent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-agent-games-signature": "deadbeef" },
    body: raw,
  });
  assert.equal(res.status, 401);
  const noSig = await fetch(`${base}/agent`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw,
  });
  assert.equal(noSig.status, 401);
});

test("valid Gatekeeper task -> APPROVE, signed, proof_tx echoed", async (t) => {
  const { base } = await startTestServer(t);
  const { res, body, rawResponse } = await postAgent(base, {
    type: "agent-games.proof-gatekeeper.v1",
    task_id: "gk_test_1",
    mode: "competition",
    issued_at: new Date().toISOString(),
    deadline_at: new Date(Date.now() + 60_000).toISOString(),
    input: validInput(),
  });
  assert.equal(res.status, 200);
  assert.equal(body.decision, "APPROVE");
  assert.equal(body.reason_code, "VALID_CONDITION");
  assert.equal(body.proof_tx, "0xa4c1tx001");
  // Proof is skipped while the circuit schema is unknown (documented gap).
  assert.equal("proof" in body, false);
  assert.equal(verifyBody(SECRET, Buffer.from(rawResponse), res.headers.get("x-agent-games-signature")), true);
});

test("trap task -> REJECT with the right reason_code", async (t) => {
  const { base } = await startTestServer(t);
  const { res, body } = await postAgent(base, {
    type: "agent-games.proof-gatekeeper.v1",
    task_id: "gk_test_2",
    mode: "competition",
    issued_at: new Date().toISOString(),
    deadline_at: new Date(Date.now() + 60_000).toISOString(),
    input: validInput({ proof_vk: "0x9999different", proof_tx: "0xa4c1tx002" }),
  });
  assert.equal(res.status, 200);
  assert.equal(body.decision, "REJECT");
  assert.equal(body.reason_code, "VK_SUBSTITUTION");
});

test("replaying the same task_id returns the cached response (idempotency)", async (t) => {
  const { base } = await startTestServer(t);
  const envelope = {
    type: "agent-games.proof-gatekeeper.v1",
    task_id: "gk_test_3",
    mode: "competition",
    issued_at: new Date().toISOString(),
    deadline_at: new Date(Date.now() + 60_000).toISOString(),
    input: validInput({ proof_tx: "0xa4c1tx003" }),
  };
  const first = await postAgent(base, envelope);
  const second = await postAgent(base, envelope);
  assert.deepEqual(second.body, first.body);
});

test("a reused proof_tx in a NEW task is rejected as PROOF_REUSED", async (t) => {
  const { base } = await startTestServer(t);
  const mk = (taskId) => ({
    type: "agent-games.proof-gatekeeper.v1",
    task_id: taskId,
    mode: "competition",
    issued_at: new Date().toISOString(),
    deadline_at: new Date(Date.now() + 60_000).toISOString(),
    input: validInput({ proof_tx: "0xa4c1tx004" }),
  });
  const first = await postAgent(base, mk("gk_test_4a"));
  assert.equal(first.body.decision, "APPROVE");
  const second = await postAgent(base, mk("gk_test_4b"));
  assert.equal(second.body.decision, "REJECT");
  assert.equal(second.body.reason_code, "PROOF_REUSED");
});

test("unknown envelope type -> 400, unknown path -> 404", async (t) => {
  const { base } = await startTestServer(t);
  const { res } = await postAgent(base, { type: "agent-games.something-else.v1" });
  assert.equal(res.status, 400);
  const notFound = await fetch(`${base}/nope`);
  assert.equal(notFound.status, 404);
});
