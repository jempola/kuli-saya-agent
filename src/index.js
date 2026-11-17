// Entry point: start the Proof Gatekeeper agent server.
// The server refuses to start without AGENT_GAMES_HMAC_SECRET — a
// placeholder or missing secret would fail the platform preflight, so we
// fail fast here instead of silently serving unsigned/unverifiable traffic.
import { config } from "./config.js";
import { createServer } from "./server.js";
import { log } from "./logger.js";

if (!config.hmacSecret) {
  console.error(
    "FATAL: AGENT_GAMES_HMAC_SECRET is not set. Get it from the Agent Games " +
      "dashboard (\"Rotate Secret\") and set it in the environment. " +
      "Never commit it. See .env.example.",
  );
  process.exit(1);
}

const server = createServer(config);
server.listen(config.port, config.host, () => {
  log({
    level: "info",
    kind: "startup",
    service: "kuli-saya-agent",
    track: "proof-gatekeeper",
    host: config.host,
    port: config.port,
    kurierConfigured: Boolean(config.kurierApiKey),
  });
});

function shutdown(signal) {
  log({ level: "info", kind: "shutdown", signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
