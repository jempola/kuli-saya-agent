// Persistent state: seen proof references (PROOF_REUSED detection) and the
// idempotency cache (task_id -> response the platform may retry).
// Stored as one JSON file, written atomically (tmp file + rename) after
// every task so a restart never forgets a proof reference.
import fs from "node:fs";
import path from "node:path";

export class StateStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.seenProofTxs = new Set();
    this.responses = new Map(); // task_id -> response object
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const data = JSON.parse(raw);
      if (Array.isArray(data.seenProofTxs)) {
        for (const tx of data.seenProofTxs) this.seenProofTxs.add(String(tx));
      }
      if (data.responses && typeof data.responses === "object") {
        for (const [k, v] of Object.entries(data.responses)) {
          this.responses.set(k, v);
        }
      }
    } catch (err) {
      if (err.code !== "ENOENT") throw err; // missing file = fresh state
    }
  }

  save() {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    const data = {
      seenProofTxs: [...this.seenProofTxs],
      responses: Object.fromEntries(this.responses),
    };
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, this.filePath);
  }

  hasSeenProofTx(proofTx) {
    return this.seenProofTxs.has(String(proofTx).toLowerCase());
  }

  markProofTxSeen(proofTx) {
    if (proofTx === undefined || proofTx === null || proofTx === "") return;
    this.seenProofTxs.add(String(proofTx).toLowerCase());
  }

  getCachedResponse(taskId) {
    return this.responses.get(taskId);
  }

  cacheResponse(taskId, response) {
    this.responses.set(taskId, response);
  }
}
