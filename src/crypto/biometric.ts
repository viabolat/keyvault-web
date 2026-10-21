// Face ID / Touch ID unlock via a WebAuthn passkey with the PRF extension.
// The authenticator (Secure Enclave on iPhone) turns a stored salt into 32 secret bytes only after
// a biometric check. Those bytes derive a key that wraps the account key; the wrapped copy stays in
// this browser's storage. No server, account or fee is involved — WebAuthn is built into the browser.
import { b64, hkdf, importAesKey, randomBytes, unwrapKey, type Bytes } from './keys';
import type { AccountStore, Session } from '../store/account';

/** The two WebAuthn calls this feature needs, injectable so tests can run without a browser. */
export interface Authenticator {
  register(user: { id: Bytes; name: string; displayName: string }, salt: Bytes): Promise<{ credentialId: Bytes; prf?: Bytes }>;
  evaluate(credentialId: Bytes, salt: Bytes): Promise<Bytes>;
}

type PrfResults = { prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } } };

function prfOutput(cred: PublicKeyCredential): Bytes | undefined {
  const first = (cred.getClientExtensionResults() as PrfResults).prf?.results?.first;
  return first ? new Uint8Array(first) : undefined;
}

export const webAuthn: Authenticator = {
  async register(user, salt) {
    const cred = (await navigator.credentials.create({
      publicKey: {
        rp: { name: 'Keyvault' },
        user,
        challenge: randomBytes(32), // reason: local-only use; there is no server to verify an attestation
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'preferred', userVerification: 'required' },
        extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
    if (!cred) throw new Error('Face ID setup was cancelled');
    const ext = (cred.getClientExtensionResults() as PrfResults).prf;
    if (!ext?.enabled && !ext?.results?.first) throw new Error('This device or browser does not support Face ID unlock (needs iOS 18 or later)');
    return { credentialId: new Uint8Array(cred.rawId), prf: prfOutput(cred) };
  },
  async evaluate(credentialId, salt) {
    const cred = (await navigator.credentials.get({
      publicKey: {
        challenge: randomBytes(32),
        allowCredentials: [{ type: 'public-key', id: credentialId }],
        userVerification: 'required',
        extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
    const out = cred && prfOutput(cred);
    if (!out) throw new Error('Face ID did not return a key');
    return out;
  },
};

/** "Face ID" on iPhone/iPad, "Touch ID" on Mac, generic elsewhere. */
export function biometricLabel(ua = typeof navigator === 'undefined' ? '' : navigator.userAgent): string {
  if (/iPhone|iPad|iPod/.test(ua)) return 'Face ID';
  if (/Macintosh/.test(ua)) return navigator.maxTouchPoints > 1 ? 'Face ID' : 'Touch ID'; // iPadOS reports as Mac
  return 'biometric unlock';
}

/** True when a built-in authenticator (Face ID, Touch ID, Windows Hello) is available. PRF is checked at setup. */
export async function biometricAvailable(): Promise<boolean> {
  try {
    return typeof PublicKeyCredential !== 'undefined' && (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
  } catch {
    return false;
  }
}

function wrappingKey(prf: Bytes, accountId: string) {
  return hkdf(prf, new TextEncoder().encode(accountId), 'keyvault-biometric-v1').then((k) => importAesKey(k, false));
}

export async function enableBiometric(store: AccountStore, session: Session, auth: Authenticator = webAuthn) {
  const salt = randomBytes(32);
  const reg = await auth.register(
    { id: new TextEncoder().encode(session.accountId), name: session.email, displayName: session.name },
    salt,
  );
  // reason: iOS often reports PRF as enabled at creation without returning output; a second prompt gets it.
  const prf = reg.prf ?? (await auth.evaluate(reg.credentialId, salt));
  store.saveBiometric({
    accountId: session.accountId,
    credentialId: b64.encode(reg.credentialId),
    salt: b64.encode(salt),
    wrapped: await session.wrapAccountKey(await wrappingKey(prf, session.accountId)),
    confirmedAt: Date.now(),
  });
}

export async function unlockWithBiometric(store: AccountStore, accountId: string, auth: Authenticator = webAuthn) {
  const rec = store.biometric(accountId);
  if (!rec || !store.biometricUsable(accountId)) throw new Error('Enter your password to unlock');
  const prf = await auth.evaluate(b64.decode(rec.credentialId), b64.decode(rec.salt));
  let accountKey: CryptoKey;
  try {
    accountKey = await unwrapKey(await wrappingKey(prf, accountId), rec.wrapped);
  } catch {
    // reason: a deleted/replaced passkey yields different PRF bytes; the record can never work again.
    store.removeBiometric(accountId);
    throw new Error('Face ID unlock is no longer valid on this device. Enter your password, then turn it on again.');
  }
  return store.unlockWithAccountKey(accountId, accountKey);
}
