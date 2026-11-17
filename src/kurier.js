// Kurier REST client (https://api.kurier.xyz/api/v1) — the recommended
// path for submitting proofs to zkVerify mainnet.
// Flow: register-vk (once) -> submit-proof -> poll job-status until
// Finalized. The game circuits are already registered on mainnet (their
// vk hashes are published at /api/circuit-info), so submit-proof is sent
// with vkRegistered: true and the published vk hash; registerVk() is kept
// for the standard flow and for re-registration if ever needed.
//
// All calls use the global fetch (Node >= 18). No axios dependency.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class KurierClient {
  /**
   * @param {object} opts - { apiKey, baseUrl, fetchImpl? }
   */
  constructor(opts) {
    if (!opts.apiKey) throw new Error("KurierClient requires an apiKey");
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl || "https://api.kurier.xyz/api/v1").replace(/\/$/, "");
    this.fetch = opts.fetchImpl || globalThis.fetch;
  }

  async #post(path, body) {
    const res = await this.fetch(`${this.baseUrl}${path}/${this.apiKey}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      throw new Error(`Kurier ${path} failed: HTTP ${res.status} ${JSON.stringify(data).slice(0, 500)}`);
    }
    return data;
  }

  async #get(path) {
    const res = await this.fetch(`${this.baseUrl}${path}/${this.apiKey}`, {
      method: "GET",
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      throw new Error(`Kurier ${path} failed: HTTP ${res.status} ${JSON.stringify(data).slice(0, 500)}`);
    }
    return data;
  }

  /** Register a verification key once. Returns the response (contains vkHash). */
  async registerVk(vkJson) {
    return this.#post("/register-vk", {
      proofType: "groth16",
      proofOptions: { library: "snarkjs", curve: "bn128" },
      vk: vkJson,
    });
  }

  /**
   * Submit a proof. `vkHash` is the registered vk hash (for the game:
   * the published gatekeeper vkHash).
   * Returns the job object, e.g. { jobId, optimisticVerify: "success" }.
   */
  async submitProof({ proof, publicSignals, vkHash }) {
    return this.#post("/submit-proof", {
      proofType: "groth16",
      vkRegistered: true,
      proofOptions: { library: "snarkjs", curve: "bn128" },
      proofData: { proof, publicSignals, vk: vkHash },
    });
  }

  /** GET /job-status/{key}/{jobId} — returns e.g. { jobId, status, txHash }. */
  async getJobStatus(jobId) {
    return this.#get(`/job-status/${jobId}`);
  }

  /**
   * Submit a proof and poll until Finalized / Failed / budget exhausted.
   * @param {object} args - { proof, publicSignals, vkHash,
   *   pollBudgetMs, pollIntervalMs }
   * @returns {Promise<{status: string, jobId: string|null,
   *   txHash: string|null, optimisticVerify: string|null, timedOut: boolean,
   *   last: object|null}>}
   * status is "Finalized" | "Failed" | "OPTIMISTIC_VERIFY_FAILED" |
   * "TIMEOUT" (still pending when the budget ran out).
   */
  async submitAndWait({ proof, publicSignals, vkHash, pollBudgetMs = 40_000, pollIntervalMs = 5_000 }) {
    const job = await this.submitProof({ proof, publicSignals, vkHash });
    const jobId = job.jobId || null;
    const optimisticVerify = job.optimisticVerify ?? null;
    if (optimisticVerify !== null && optimisticVerify !== "success") {
      // Per Kurier docs: do not continue to polling when optimistic
      // verification did not succeed — check the proof artifacts instead.
      return { status: "OPTIMISTIC_VERIFY_FAILED", jobId, txHash: null, optimisticVerify, timedOut: false, last: job };
    }
    const started = Date.now();
    let last = job;
    for (;;) {
      const statusRes = await this.getJobStatus(jobId);
      last = statusRes;
      const status = statusRes.status;
      if (status === "Finalized" || status === "Failed") {
        return {
          status,
          jobId,
          txHash: statusRes.txHash || null,
          optimisticVerify,
          timedOut: false,
          last: statusRes,
        };
      }
      if (Date.now() - started >= pollBudgetMs) {
        return { status: "TIMEOUT", jobId, txHash: statusRes.txHash || null, optimisticVerify, timedOut: true, last: statusRes };
      }
      await sleep(pollIntervalMs);
    }
  }
}
