// totp.mjs — RFC 6238 TOTP (HMAC-SHA1, 6 digits, 30s)
// Compatible with Google Authenticator, Authy, Microsoft Authenticator, Aegis, etc.
const ALPH = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes) {
  let bits = 0, value = 0, out = "";
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      out += ALPH[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPH[(value << (5 - bits)) & 31];
  // pad to multiple of 8 for apps that expect padding
  while (out.length % 8 !== 0) out += "=";
  return out;
}

export function base32Decode(str) {
  const cleaned = String(str).replace(/[\s=]+/g, "").toUpperCase();
  let bits = 0, value = 0;
  const bytes = [];
  for (let i = 0; i < cleaned.length; i++) {
    const idx = ALPH.indexOf(cleaned[i]);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(bytes);
}

/** 20-byte (160-bit) secret → standard Base32 (with = padding) */
export function generateSecret() {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return base32Encode(bytes);
}

/**
 * otpauth URI — format used by virtually every authenticator app.
 * HMAC-SHA1 is the default algorithm (what Google Authenticator / Authy use).
 * We omit algorithm/digits/period so apps use their defaults (SHA1 / 6 / 30).
 */
export function otpauthUrl(username, secret) {
  // Strip padding from secret in URI (spec allows either; unpadded is more widely accepted in QR)
  const sec = String(secret).replace(/=+$/g, "").toUpperCase();
  const label = encodeURIComponent("DurableChat:" + String(username));
  const issuer = encodeURIComponent("DurableChat");
  return "otpauth://totp/" + label + "?secret=" + sec + "&issuer=" + issuer;
}

export async function generateTOTP(secretBase32, windowOffset = 0) {
  const keyBytes = base32Decode(secretBase32);
  if (keyBytes.length < 10) throw new Error("Invalid secret");
  const counter = Math.floor(Date.now() / 1000 / 30) + windowOffset;
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  // 64-bit big-endian counter
  view.setUint32(0, Math.floor(counter / 0x100000000), false);
  view.setUint32(4, counter >>> 0, false);
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, buf));
  const off = sig[sig.length - 1] & 0x0f;
  const code =
    ((sig[off] & 0x7f) << 24) |
    ((sig[off + 1] & 0xff) << 16) |
    ((sig[off + 2] & 0xff) << 8) |
    (sig[off + 3] & 0xff);
  return String(code % 1000000).padStart(6, "0");
}

export async function verifyTOTP(secretBase32, token) {
  const clean = String(token).replace(/\s/g, "");
  if (!/^\d{6}$/.test(clean)) return false;
  // ±2 steps (±60s) — tolerates phone/server clock skew; code is still short-lived
  for (let i = -2; i <= 2; i++) {
    if ((await generateTOTP(secretBase32, i)) === clean) return true;
  }
  return false;
}
