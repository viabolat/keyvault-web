import { describe, expect, it } from 'vitest';
import { AccountStore, BIOMETRIC_MAX_AGE_MS, type KeyValueStore } from '../store/account';
import { enableBiometric, unlockWithBiometric, type Authenticator } from './biometric';
import { hkdf, randomBytes, type Bytes } from './keys';

class MemoryKV implements KeyValueStore {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  get length() { return this.m.size; }
}

/** Stands in for the Secure Enclave: PRF = HKDF(device secret, salt). */
function fakeAuthenticator(opts: { prfAtCreate?: boolean } = {}): Authenticator & { secret: Bytes; prompts: number } {
  const a = {
    secret: randomBytes(32),
    prompts: 0,
    async register(_user: unknown, salt: Bytes) {
      a.prompts++;
      return { credentialId: randomBytes(16), prf: opts.prfAtCreate ? await hkdf(a.secret, salt, 'prf') : undefined };
    },
    async evaluate(_id: Bytes, salt: Bytes) {
      a.prompts++;
      return hkdf(a.secret, salt, 'prf');
    },
  };
  return a;
}

const creds = { name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' };

async function setup(opts?: { prfAtCreate?: boolean }) {
  const kv = new MemoryKV();
  const store = new AccountStore(kv, 1000);
  const { session } = await store.createAccount(creds);
  await session.saveItem({ ...session.blankItem('login'), title: 'Mail' });
  const auth = fakeAuthenticator(opts);
  await enableBiometric(store, session, auth);
  return { kv, store, session, auth };
}

describe('biometric unlock', () => {
  it('unlocks the same vault without a password and stores no raw key', async () => {
    const { kv, store, session, auth } = await setup();
    expect(auth.prompts).toBe(2); // create gave no PRF output, so a second prompt fetched it
    const s2 = await unlockWithBiometric(store, session.accountId, auth);
    expect(s2.items.map((i) => i.title)).toContain('Mail');
    expect(s2.name).toBe('Ada');
    expect([...kv.m.values()].join('')).not.toContain('Mail');
  });

  it('needs only one prompt when PRF output comes back at creation', async () => {
    const { auth } = await setup({ prfAtCreate: true });
    expect(auth.prompts).toBe(1);
  });

  it('rejects a different authenticator and removes the dead record', async () => {
    const { store, session } = await setup();
    await expect(unlockWithBiometric(store, session.accountId, fakeAuthenticator())).rejects.toThrow(/no longer valid/);
    expect(store.biometric(session.accountId)).toBeUndefined();
  });

  it('expires after 14 days until a password unlock refreshes it', async () => {
    const { store, session, auth } = await setup();
    const rec = store.biometric(session.accountId)!;
    store.saveBiometric({ ...rec, confirmedAt: Date.now() - BIOMETRIC_MAX_AGE_MS - 1 });
    await expect(unlockWithBiometric(store, session.accountId, auth)).rejects.toThrow(/password/);
    await store.unlock({ email: creds.email, password: creds.password });
    await expect(unlockWithBiometric(store, session.accountId, auth)).resolves.toBeTruthy();
  });

  it('is removed by sign-out and by a public-computer sign-in', async () => {
    const { store, session } = await setup();
    await store.unlock({ email: creds.email, password: creds.password, publicComputer: true });
    expect(store.biometric(session.accountId)).toBeUndefined();
    const again = await setup();
    again.store.forgetDevice(again.session.accountId);
    expect(again.store.biometric(again.session.accountId)).toBeUndefined();
  });
});
