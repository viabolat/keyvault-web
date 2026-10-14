// RFC 6238 TOTP (HMAC-SHA1, 30 s, 6 digits) with RFC 4648 base32 secrets.
import type { Bytes } from './keys';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(input: string): Bytes {
  const clean = input.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** Accepts a raw base32 secret or an otpauth:// URI. */
export function parseTotpSecret(input: string): string {
  const trimmed = input.trim();
  if (trimmed.toLowerCase().startsWith('otpauth://')) {
    const secret = new URL(trimmed).searchParams.get('secret');
    if (!secret) throw new Error('otpauth URI has no secret');
    return secret;
  }
  return trimmed;
}

export async function totp(secret: string, now = Date.now(), step = 30, digits = 6): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    base32Decode(parseTotpSecret(secret)),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const counter = Math.floor(now / 1000 / step);
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setBigUint64(0, BigInt(counter));
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const offset = mac[mac.length - 1] & 0x0f;
  const bin =
    ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export function totpSecondsRemaining(now = Date.now(), step = 30): number {
  return step - (Math.floor(now / 1000) % step);
}
