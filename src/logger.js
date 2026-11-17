// Structured JSON-lines logging to stdout. Never log secrets:
// the logger only ever receives the fields callers pass explicitly.
export function log(fields) {
  const line = { ts: new Date().toISOString(), ...fields };
  process.stdout.write(JSON.stringify(line) + "\n");
}

export function logDecision(entry) {
  log({ level: "info", kind: "decision", ...entry });
}

export function logError(entry) {
  log({ level: "error", kind: "error", ...entry });
}
