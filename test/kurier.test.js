// Unit tests for the Kurier client against a local mock Kurier server.
// No real API key, no network calls to api.kurier.xyz.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { KurierClient } from "../src/kurier.js";

function mockKurier(handler) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const out = handler(req.method, req.url, body ? JSON.parse(body) : null);
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(JSON.stringify(out.body));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}/api/v1` });
    });
  });
}

const FAKE_PROOF = { pi_a: ["1", "2", "1"], pi_b: [["1", "2"], ["3", "4"], ["1", "0"]], pi_c: ["5", "6", "1"], protocol: "groth16", curve: "bn128" };
const VK_HASH = "0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0";

test("submit-proof sends the documented body shape and returns the job", async (t) => {
  let seenBody = null;
  const { server, baseUrl } = await mockKurier((method, url, body) => {
    seenBody = body;
    assert.equal(method, "POST");
    assert.match(url, /\/submit-proof\/test-key$/);
    return { status: 200, body: { jobId: "job-1", optimisticVerify: "success" } };
  });
  t.after(() => server.close());
  const client = new KurierClient({ apiKey: "test-key", baseUrl });
  const job = await client.submitProof({ proof: FAKE_PROOF, publicSignals: ["1", "2"], vkHash: VK_HASH });
  assert.equal(job.jobId, "job-1");
  assert.equal(seenBody.proofType, "groth16");
  assert.equal(seenBody.vkRegistered, true);
  assert.deepEqual(seenBody.proofOptions, { library: "snarkjs", curve: "bn128" });
  assert.equal(seenBody.proofData.vk, VK_HASH);
  assert.deepEqual(seenBody.proofData.proof, FAKE_PROOF);
});

test("register-vk posts the verification key", async (t) => {
  const { server, baseUrl } = await mockKurier((method, url, body) => {
    assert.equal(method, "POST");
    assert.match(url, /\/register-vk\/test-key$/);
    assert.equal(body.proofType, "groth16");
    assert.equal(body.vk.protocol, "groth16");
    return { status: 200, body: { vkHash: VK_HASH } };
  });
  t.after(() => server.close());
  const client = new KurierClient({ apiKey: "test-key", baseUrl });
  const res = await client.registerVk({ protocol: "groth16", curve: "bn128", nPublic: 13, vk_alpha_1: [] });
  assert.equal(res.vkHash, VK_HASH);
});

test("submitAndWait polls job-status until Finalized and returns txHash", async (t) => {
  let polls = 0;
  const { server, baseUrl } = await mockKurier((method, url) => {
    if (url.includes("/submit-proof/")) {
      return { status: 200, body: { jobId: "job-9", optimisticVerify: "success" } };
    }
    polls += 1;
    if (polls < 3) return { status: 200, body: { jobId: "job-9", status: "Submitted" } };
    return { status: 200, body: { jobId: "job-9", status: "Finalized", txHash: "0xabc123" } };
  });
  t.after(() => server.close());
  const client = new KurierClient({ apiKey: "test-key", baseUrl });
  const res = await client.submitAndWait({
    proof: FAKE_PROOF,
    publicSignals: ["1"],
    vkHash: VK_HASH,
    pollBudgetMs: 10_000,
    pollIntervalMs: 10,
  });
  assert.equal(res.status, "Finalized");
  assert.equal(res.jobId, "job-9");
  assert.equal(res.txHash, "0xabc123");
  assert.equal(polls, 3);
});

test("submitAndWait stops early when optimisticVerify is not success", async (t) => {
  let polls = 0;
  const { server, baseUrl } = await mockKurier((method, url) => {
    if (url.includes("/submit-proof/")) {
      return { status: 200, body: { jobId: "job-2", optimisticVerify: "failed" } };
    }
    polls += 1;
    return { status: 200, body: { jobId: "job-2", status: "Queued" } };
  });
  t.after(() => server.close());
  const client = new KurierClient({ apiKey: "test-key", baseUrl });
  const res = await client.submitAndWait({ proof: FAKE_PROOF, publicSignals: ["1"], vkHash: VK_HASH });
  assert.equal(res.status, "OPTIMISTIC_VERIFY_FAILED");
  assert.equal(polls, 0);
});

test("submitAndWait reports Failed status", async (t) => {
  const { server, baseUrl } = await mockKurier((method, url) => {
    if (url.includes("/submit-proof/")) {
      return { status: 200, body: { jobId: "job-3", optimisticVerify: "success" } };
    }
    return { status: 200, body: { jobId: "job-3", status: "Failed" } };
  });
  t.after(() => server.close());
  const client = new KurierClient({ apiKey: "test-key", baseUrl });
  const res = await client.submitAndWait({
    proof: FAKE_PROOF, publicSignals: ["1"], vkHash: VK_HASH, pollIntervalMs: 10,
  });
  assert.equal(res.status, "Failed");
});

test("non-2xx Kurier responses throw with the HTTP status", async (t) => {
  const { server, baseUrl } = await mockKurier(() => ({
    status: 401, body: { error: "invalid api key" },
  }));
  t.after(() => server.close());
  const client = new KurierClient({ apiKey: "bad-key", baseUrl });
  await assert.rejects(
    () => client.submitProof({ proof: FAKE_PROOF, publicSignals: ["1"], vkHash: VK_HASH }),
    /HTTP 401/,
  );
});
