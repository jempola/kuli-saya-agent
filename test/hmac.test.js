// Unit tests for HMAC sign/verify.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { signBody, verifyBody } from "../src/hmac.js";

const SECRET = "test-secret-32-bytes-long-value!";
const BODY = Buffer.from(JSON.stringify({ type: "agent-games.preflight.v1", nonce: "abc123" }));

test("sign then verify round-trips (hex header)", () => {
  const sig = signBody(SECRET, BODY);
  assert.match(sig, /^[0-9a-f]{64}$/);
  assert.equal(verifyBody(SECRET, BODY, sig), true);
});

test("tampered body fails verification", () => {
  const sig = signBody(SECRET, BODY);
  assert.equal(verifyBody(SECRET, Buffer.from("tampered"), sig), false);
});

test("wrong secret fails verification", () => {
  const sig = signBody(SECRET, BODY);
  assert.equal(verifyBody("other-secret", BODY, sig), false);
});

test("missing header fails verification", () => {
  assert.equal(verifyBody(SECRET, BODY, undefined), false);
  assert.equal(verifyBody(SECRET, BODY, ""), false);
});

test("base64-encoded digest is accepted as a fallback", () => {
  const b64 = crypto.createHmac("sha256", SECRET).update(BODY).digest("base64");
  assert.equal(verifyBody(SECRET, BODY, b64), true);
});

test("uppercase hex header is accepted", () => {
  const sig = signBody(SECRET, BODY).toUpperCase();
  assert.equal(verifyBody(SECRET, BODY, sig), true);
});
