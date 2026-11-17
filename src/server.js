// HTTP server: GET /health, POST /agent.
// Built on Node's http module only — no framework dependency.
//
// Contract (from research.md):
// - The platform POSTs signed JSON to the full registered path (/agent).
// - Verify HMAC over the RAW body against `x-agent-games-signature`
//   BEFORE parsing JSON. Reject (401) on mismatch.
// - Preflight ({type: "agent-games.preflight.v1"}) -> {ok:true, protocolVersion:"v1"}.
// - Gatekeeper task ({type: "agent-games.proof-gatekeeper.v1"}) ->
//   {decision, reason_code, proof_tx[, proof, public_signals]}, signed.
// - Hard response deadline: 60s. Fail closed: any doubt/error -> REJECT.
// - task_id is the idempotency key: a retry of the same task_id returns
//   the cached response without re-deciding.
import http from "node:http";
import { decide, REASON_CODES } from "./decision.js";
import { signBody, verifyBody, HEADER_NAME } from "./hmac.js";
import { StateStore } from "./seen.js";
import { generateProof, parseSchemaEnv, UNKNOWN_SCHEMA_REASON } from "./proof.js";
import { KurierClient } from "./kurier.js";
import { log, logDecision, logError } from "./logger.js";

const PREFLIGHT_TYPE = "agent-games.preflight.v1";
const GATEKEEPER_TYPE = "agent-games.proof-gatekeeper.v1";

export function createServer(cfg) {
  const state = new StateStore(cfg.seenStorePath);
  const schema = parseSchemaEnv(process.env.GATEKEEPER_INPUT_SCHEMA_JSON || "");
  const kurier = cfg.kurierApiKey
    ? new KurierClient({ apiKey: cfg.kurierApiKey, baseUrl: cfg.kurierBaseUrl })
    : null;
  const startedAt = Date.now();
  let tasksProcessed = 0;

  function readRawBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let total = 0;
      req.on("data", (chunk) => {
        total += chunk.length;
        if (total > cfg.maxBodyBytes) {
          reject(new Error("body too large"));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  function sendSigned(res, status, obj) {
    const body = Buffer.from(JSON.stringify(obj));
    res.writeHead(status, {
      "content-type": "application/json",
      [HEADER_NAME]: signBody(cfg.hmacSecret, body),
    });
    res.end(body);
  }

  function sendUnsigned(res, status, obj) {
    const body = Buffer.from(JSON.stringify(obj));
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body);
  }

  async function handleGatekeeperTask(envelope, receivedAt) {
    const taskId = envelope.task_id;
    const input = envelope.input || {};
    const started = Date.now();

    // Idempotency: the platform may retry after a network failure.
    const cached = state.getCachedResponse(taskId);
    if (cached) {
      logDecision({ task_id: taskId, replay: true, decision: cached.decision, reason_code: cached.reason_code });
      return cached;
    }

    // Effective deadline: platform deadline_at if present, else our budget.
    let budgetMs = cfg.responseBudgetMs;
    if (envelope.deadline_at) {
      const platformDeadline = Date.parse(envelope.deadline_at);
      if (Number.isFinite(platformDeadline)) {
        budgetMs = Math.min(budgetMs, Math.max(5_000, platformDeadline - receivedAt));
      }
    }
    const deadline = receivedAt + budgetMs;

    // 1. Decision (pure, deterministic, fail closed).
    const { decision, reason_code, checks } = decide(input, {
      has: (tx) => state.hasSeenProofTx(tx),
    });

    // 2. Proof. PROOF_REUSED has no proof to submit (per the event page)
    //    and is excluded from the proof requirement. For every other
    //    decision we attempt proof generation when the circuit schema is
    //    known; while it is unknown, generateProof() reports "skipped"
    //    and the response carries decision + reason_code + proof_tx only.
    let proof = null;
    let publicSignals = null;
    let proofStatus = "not_attempted";
    let kurierResult = null;
    const proofTx = input.proof_tx ?? null;
    if (reason_code !== REASON_CODES.PROOF_REUSED) {
      try {
        const gen = await generateProof(input, {
          wasmPath: cfg.circuitWasmPath,
          zkeyPath: cfg.circuitZkeyPath,
          schema,
        });
        if (gen.skipped) {
          proofStatus = `skipped:${gen.reason}`;
        } else {
          proof = gen.proof;
          publicSignals = gen.publicSignals;
          proofStatus = "generated";
        }
      } catch (err) {
        proofStatus = `failed:${err.message}`;
        logError({ task_id: taskId, kind: "proof_generation", error: err.message });
      }
    } else {
      proofStatus = "not_applicable:PROOF_REUSED";
    }

    // 3. Kurier submission (only when we have a proof and a key).
    //    Poll with whatever budget remains, keeping a 5s reserve to
    //    build and send the response. If Finalized is not reached in
    //    time, we still answer with the local proof — the platform
    //    re-verifies the proof itself against its own registered key.
    if (proof && kurier) {
      const remaining = deadline - Date.now();
      const pollBudget = Math.min(cfg.kurierPollBudgetMs, Math.max(0, remaining - 5_000));
      try {
        kurierResult = await kurier.submitAndWait({
          proof,
          publicSignals,
          vkHash: cfg.gatekeeperVkHash,
          pollBudgetMs: pollBudget,
          pollIntervalMs: cfg.kurierPollIntervalMs,
        });
      } catch (err) {
        kurierResult = { status: "ERROR", error: err.message };
        logError({ task_id: taskId, kind: "kurier", error: err.message });
      }
    } else if (proof && !kurier) {
      kurierResult = { status: "SKIPPED_NO_API_KEY" };
    }

    // 4. Build the response. Keep it to the documented shape:
    //    { decision, reason_code, proof_tx } plus proof/public_signals
    //    when a proof was generated.
    const response = { decision, reason_code, proof_tx: proofTx };
    if (proof) {
      response.proof = proof;
      response.public_signals = publicSignals;
    }

    // 5. Persist: mark the proof reference seen, cache the response.
    state.markProofTxSeen(proofTx);
    state.cacheResponse(taskId, response);
    try {
      state.save();
    } catch (err) {
      logError({ task_id: taskId, kind: "state_save", error: err.message });
    }

    tasksProcessed += 1;
    logDecision({
      task_id: taskId,
      decision,
      reason_code,
      proof_status: proofStatus,
      kurier_status: kurierResult ? kurierResult.status : "not_attempted",
      kurier_job_id: kurierResult?.jobId ?? null,
      kurier_tx_hash: kurierResult?.txHash ?? null,
      ms: Date.now() - started,
      checks: checks.map((c) => `${c.name}:${c.pass ? "pass" : "fail"}`).join(","),
    });
    return response;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    try {
      // GET health: /health is the canonical probe. Also answer GET on
      // /agent and / with 200 — the platform's health check may probe the
      // registered URL (or the bare domain) with GET, and a 404 there fails
      // preflight even though POST /agent works. Signed POST /agent below
      // is the real task path; these GETs only prove liveness.
      if (
        req.method === "GET" &&
        (url.pathname === "/health" ||
          url.pathname === "/agent" ||
          url.pathname === "/")
      ) {
        return sendUnsigned(res, 200, {
          ok: true,
          service: "kuli-saya-agent",
          track: "proof-gatekeeper",
          protocolVersion: "v1",
          uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
          tasksProcessed,
          seenProofs: state.seenProofTxs.size,
          proofSchemaKnown: Boolean(schema),
          kurierConfigured: Boolean(kurier),
        });
      }

      if (req.method === "POST" && url.pathname === "/agent") {
        const receivedAt = Date.now();
        const rawBody = await readRawBody(req);

        // HMAC BEFORE parsing — a mismatch is rejected outright.
        const signature = req.headers[HEADER_NAME];
        if (!verifyBody(cfg.hmacSecret, rawBody, signature)) {
          logError({ kind: "hmac_mismatch", path: "/agent" });
          return sendUnsigned(res, 401, { error: "invalid signature" });
        }

        let envelope;
        try {
          envelope = JSON.parse(rawBody.toString("utf8"));
        } catch {
          return sendSigned(res, 400, { error: "invalid json" });
        }

        if (envelope.type === PREFLIGHT_TYPE) {
          log({ level: "info", kind: "preflight", agent_id: envelope.agent_id ?? null });
          return sendSigned(res, 200, { ok: true, protocolVersion: "v1" });
        }

        if (envelope.type === GATEKEEPER_TYPE) {
          if (!envelope.task_id || !envelope.input || typeof envelope.input !== "object") {
            return sendSigned(res, 400, { error: "invalid envelope: task_id and input required" });
          }
          try {
            const response = await handleGatekeeperTask(envelope, receivedAt);
            return sendSigned(res, 200, response);
          } catch (err) {
            // Fail closed on any unexpected error.
            logError({ task_id: envelope.task_id ?? null, kind: "handler", error: err.message });
            const fallback = {
              decision: "REJECT",
              reason_code: REASON_CODES.INVALID_INPUT,
              proof_tx: envelope.input?.proof_tx ?? null,
            };
            return sendSigned(res, 200, fallback);
          }
        }

        return sendSigned(res, 400, { error: `unknown type: ${envelope.type ?? null}` });
      }

      return sendUnsigned(res, 404, { error: "not found" });
    } catch (err) {
      logError({ kind: "server", error: err.message });
      if (!res.headersSent) sendUnsigned(res, 500, { error: "internal error" });
    }
  });

  return server;
}
