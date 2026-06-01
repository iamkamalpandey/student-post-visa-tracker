// RFC 6238 TOTP with HMAC-SHA1, 30-second time step, 6-digit codes, ±1 step skew.
//
// Implemented with node:crypto only — no third-party TOTP library. Secrets are
// represented as RFC 4648 Base32 (no padding) so they can be displayed to humans
// and consumed by any standard authenticator app (Google Authenticator, Authy,
// 1Password, etc.).

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const STEP_SECONDS = 30;
const DIGITS = 6;
const ALG = 'sha1';
const SKEW = 1; // accept previous and next 30s window

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 Base32 encode (no padding). Suitable for otpauth:// URIs. */
function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return out;
}

/** RFC 4648 Base32 decode. Tolerates lowercase and stripped padding/whitespace. */
function base32Decode(input: string): Buffer {
  const cleaned = input.replace(/=+$/g, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) {
      throw new Error('base32: invalid character');
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** HOTP per RFC 4226 — generate the digit code for an arbitrary 64-bit counter. */
function hotp(secret: Buffer, counter: bigint): string {
  // 8-byte big-endian counter
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(counter);

  const mac = createHmac(ALG, secret).update(counterBuf).digest();

  // Dynamic truncation (RFC 4226 §5.3).
  const offset = mac[mac.length - 1]! & 0x0f;
  const binCode =
    ((mac[offset]! & 0x7f) << 24) |
    ((mac[offset + 1]! & 0xff) << 16) |
    ((mac[offset + 2]! & 0xff) << 8) |
    (mac[offset + 3]! & 0xff);

  const mod = 10 ** DIGITS;
  return String(binCode % mod).padStart(DIGITS, '0');
}

/** Generate a fresh 160-bit (20-byte) TOTP secret encoded as Base32. */
export function generateTotpSecret(): string {
  // 20 bytes = HMAC-SHA1 block-aligned secret length recommended by RFC 4226.
  return base32Encode(randomBytes(20));
}

/**
 * Verify a 6-digit code against a Base32 secret using ±1 step skew (90s effective window).
 * Constant-time comparison guards against timing oracles.
 */
export function verifyTotp(secret: string, code: string): boolean {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return false;

  let secretBytes: Buffer;
  try {
    secretBytes = base32Decode(secret);
  } catch {
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  const counter = BigInt(Math.floor(now / STEP_SECONDS));
  const submitted = Buffer.from(code, 'utf8');

  for (let drift = -SKEW; drift <= SKEW; drift++) {
    const candidate = hotp(secretBytes, counter + BigInt(drift));
    const candBuf = Buffer.from(candidate, 'utf8');
    if (candBuf.length === submitted.length && timingSafeEqual(candBuf, submitted)) {
      return true;
    }
  }
  return false;
}

/**
 * Build an otpauth:// URI suitable for QR-code provisioning into authenticator apps.
 * @see https://github.com/google/google-authenticator/wiki/Key-Uri-Format
 */
export function totpUri(secret: string, account: string, issuer: string): string {
  const enc = (s: string) => encodeURIComponent(s);
  const label = `${enc(issuer)}:${enc(account)}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
