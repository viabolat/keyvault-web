// Two-secret key derivation + AES-GCM envelope helpers.
// Modeled on the publicly documented "2SKD" design: the account unlock key
// depends on BOTH the account password and a device-held Secret Key, so a
// server-side (here: storage-side) leak alone is not brute-forceable.

const enc = new TextEncoder();
const dec = new TextDecoder();

export const PBKDF2_ITERATIONS = 650_000;
export const SECRET_KEY_VERSION = 'K1';
// Unambiguous alphabet (no 0/O, 1/I/L).
const SK_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const SK_GROUPS = [6, 6, 5, 5, 5, 5, 5];

export type Bytes = Uint8Array<ArrayBuffer>;

export interface Envelope {
  iv: string; // base64
  data: string; // base64 ciphertext + GCM tag
}

export const b64 = {
  encode(bytes: Uint8Array): string {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  },
  decode(text: string): Bytes {
    const s = atob(text);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  },
};

export function randomBytes(n: number): Bytes {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function randomId(): string {
  return Array.from(randomBytes(13), (b) => SK_ALPHABET[b % SK_ALPHABET.length]).join('');
}

export function generateSecretKey(accountId: string): string {
  const groups = SK_GROUPS.map((len) =>
    Array.from(randomBytes(len), (b) => SK_ALPHABET[b % SK_ALPHABET.length]).join(''),
  );
  // First group embeds the account id prefix so a key is visibly tied to its account.
  groups[0] = accountId.slice(0, 6);
  return [SECRET_KEY_VERSION, ...groups].join('-');
}

export function normalizeSecretKey(input: string): string {
  const raw = input.toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (!raw.startsWith(SECRET_KEY_VERSION)) throw new Error('Secret Key must start with ' + SECRET_KEY_VERSION);
  const body = raw.slice(SECRET_KEY_VERSION.length);
  const total = SK_GROUPS.reduce((a, b) => a + b, 0);
  if (body.length !== total) throw new Error('Secret Key has the wrong length');
  for (const ch of body) if (!SK_ALPHABET.includes(ch)) throw new Error('Secret Key contains invalid characters');
  const parts: string[] = [];
  let i = 0;
  for (const len of SK_GROUPS) {
    parts.push(body.slice(i, i + len));
    i += len;
  }
  return [SECRET_KEY_VERSION, ...parts].join('-');
}

async function hkdf(ikm: Bytes, salt: Bytes, info: string, length = 32): Promise<Bytes> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(info) },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

/** Derive the Account Unlock Key (AUK) from password + Secret Key. */
export async function deriveUnlockKey(params: {
  password: string;
  secretKey: string;
  email: string;
  accountId: string;
  salt: Bytes;
  iterations: number;
}): Promise<CryptoKey> {
  const email = params.email.trim().toLowerCase();
  // reason: NFKD keeps visually-identical passwords typed on different keyboards equal.
  const password = enc.encode(params.password.trim().normalize('NFKD'));
  const saltForPbkdf = await hkdf(params.salt, enc.encode(email), 'PBES2g-HS256');
  const pwKey = await crypto.subtle.importKey('raw', password, 'PBKDF2', false, ['deriveBits']);
  const pwBits = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: saltForPbkdf, iterations: params.iterations },
      pwKey,
      256,
    ),
  );
  const skBytes = enc.encode(normalizeSecretKey(params.secretKey).replace(/-/g, ''));
  const skBits = await hkdf(skBytes, enc.encode(params.accountId), SECRET_KEY_VERSION);
  const auk = new Uint8Array(32);
  for (let i = 0; i < 32; i++) auk[i] = pwBits[i] ^ skBits[i];
  return importAesKey(auk, false);
}

export function importAesKey(raw: Bytes, extractable = true): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, extractable, ['encrypt', 'decrypt']);
}

export function generateAesKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

export async function encryptBytes(key: CryptoKey, plain: Bytes): Promise<Envelope> {
  const iv = randomBytes(12);
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
  return { iv: b64.encode(iv), data: b64.encode(data) };
}

export async function decryptBytes(key: CryptoKey, env: Envelope): Promise<Bytes> {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64.decode(env.iv) }, key, b64.decode(env.data));
  return new Uint8Array(plain);
}

export async function encryptJson(key: CryptoKey, value: unknown): Promise<Envelope> {
  return encryptBytes(key, enc.encode(JSON.stringify(value)));
}

export async function decryptJson<T>(key: CryptoKey, env: Envelope): Promise<T> {
  return JSON.parse(dec.decode(await decryptBytes(key, env))) as T;
}

export async function wrapKey(wrapping: CryptoKey, key: CryptoKey): Promise<Envelope> {
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key));
  return encryptBytes(wrapping, raw);
}

export async function unwrapKey(wrapping: CryptoKey, env: Envelope): Promise<CryptoKey> {
  return importAesKey(await decryptBytes(wrapping, env));
}

export const AUTH_ITERATIONS = 100_000;

/**
 * Login secret for the sync server, derived from password + Secret Key + email only (no stored salt),
 * so a brand-new device can compute it before downloading anything. Uses separate salts/info strings
 * from deriveUnlockKey, so the server learning this value tells it nothing about the AUK.
 */
export async function deriveAuthSecret(params: {
  password: string;
  secretKey: string;
  email: string;
  iterations?: number;
}): Promise<string> {
  const email = enc.encode(params.email.trim().toLowerCase());
  const password = enc.encode(params.password.trim().normalize('NFKD'));
  const skBytes = enc.encode(normalizeSecretKey(params.secretKey).replace(/-/g, ''));
  const salt = await hkdf(email, enc.encode('keyvault-auth-salt'), 'auth-salt');
  const pwKey = await crypto.subtle.importKey('raw', password, 'PBKDF2', false, ['deriveBits']);
  const pwBits = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: params.iterations ?? AUTH_ITERATIONS },
      pwKey,
      256,
    ),
  );
  const skBits = await hkdf(skBytes, email, `${SECRET_KEY_VERSION}-auth`);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = pwBits[i] ^ skBits[i];
  return b64.encode(out);
}
