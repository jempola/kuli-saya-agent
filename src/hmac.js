// HMAC signing / verification for the Agent Games contract.
// The platform signs every inbound request and expects every outbound
// response signed with the `x-agent-games-signature` header, computed over
// the RAW body.
//
// ⚠️ UNVERIFIED ASSUMPTION (see README "Gaps"):
// The public pages only say "HMAC" — they do not document the hash
// algorithm or the header encoding. This module uses HMAC-SHA256 and
// accepts the header as lowercase hex, falling back to base64 on verify.
// Confirm both against the preflight / practice mode before the first
// scored round; if the platform uses a different algorithm or encoding,
// change ALGORITHM / verify() here and nothing else.
import crypto from "node:crypto";

export const HMAC_ALGORITHM = "sha256";
export const HEADER_NAME = "x-agent-games-signature";

export function signBody(secret, rawBody) {
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody);
  return crypto
    .createHmac(HMAC_ALGORITHM, secret)
    .update(body)
    .digest("hex");
}

function safeEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function verifyBody(secret, rawBody, headerValue) {
  if (!secret || !headerValue) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody);
  const digest = crypto.createHmac(HMAC_ALGORITHM, secret).update(body).digest();
  const header = String(headerValue).trim();
  // Hex (expected) …
  if (safeEqual(digest.toString("hex"), header.toLowerCase())) return true;
  // … or base64 (fallback, in case the platform encodes it that way).
  if (safeEqual(digest.toString("base64"), header)) return true;
  return false;
}
