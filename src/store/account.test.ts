import { describe, expect, it } from 'vitest';
import { AccountStore, type KeyValueStore } from './account';
import { normalizeSecretKey } from '../crypto/keys';
import { totp } from '../crypto/totp';
import { generatePassword, strength, DEFAULT_GENERATOR } from '../crypto/generator';

class MemoryKV implements KeyValueStore {
  m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  get length() {
    return this.m.size;
  }
}

const ITER = 1000; // fast test iterations; production uses 650k
const creds = { name: 'Ada', email: 'Ada@Example.com', password: 'correct horse battery' };

describe('account store', () => {
  it('round-trips items and stores only ciphertext', async () => {
    const kv = new MemoryKV();
    const store = new AccountStore(kv, ITER);
    const { secretKey, session } = await store.createAccount(creds);
    expect(normalizeSecretKey(secretKey)).toBe(secretKey);
    const item = await session.saveItem({
      ...session.blankItem('login'),
      title: 'Mail',
      fields: [{ id: 'p', label: 'password', value: 'hunter2-SECRET', kind: 'concealed' }],
    });
    const raw = [...kv.m.values()].join('');
    expect(raw).not.toContain('hunter2-SECRET');
    expect(raw).not.toContain('Mail');

    const again = await new AccountStore(kv, ITER).unlock({ email: 'ada@example.com', password: creds.password, secretKey });
    expect(again.items.find((i) => i.id === item.id)?.fields[0].value).toBe('hunter2-SECRET');
    expect(again.vaults.map((v) => v.name)).toEqual(['Personal']);
  });

  it('rejects wrong password and wrong Secret Key identically', async () => {
    const kv = new MemoryKV();
    const store = new AccountStore(kv, ITER);
    const { secretKey } = await store.createAccount(creds);
    store.forgetDevice(store.findAccount(creds.email)!.accountId);
    await expect(store.unlock({ email: creds.email, password: 'nope', secretKey })).rejects.toThrow(
      'Incorrect password or Secret Key',
    );
    const other = secretKey.slice(0, -1) + (secretKey.endsWith('A') ? 'B' : 'A');
    await expect(store.unlock({ email: creds.email, password: creds.password, secretKey: other })).rejects.toThrow(
      'Incorrect password or Secret Key',
    );
  });

  it('remembers the Secret Key on trusted devices only', async () => {
    const kv = new MemoryKV();
    const store = new AccountStore(kv, ITER);
    const { secretKey, accountId } = await store.createAccount(creds);
    // Creating the account trusts this device.
    await expect(store.unlock({ email: creds.email, password: creds.password })).resolves.toBeTruthy();
    await store.unlock({ email: creds.email, password: creds.password, secretKey, publicComputer: true });
    expect(store.knownDevices().find((d) => d.accountId === accountId)?.secretKey).toBeUndefined();
    await expect(store.unlock({ email: creds.email, password: creds.password })).rejects.toThrow('Secret Key');
    await store.unlock({ email: creds.email, password: creds.password, secretKey });
    await expect(store.unlock({ email: creds.email, password: creds.password })).resolves.toBeTruthy();
  });

  it('moves items between vaults and records password history', async () => {
    const store = new AccountStore(new MemoryKV(), ITER);
    const { session, secretKey } = await store.createAccount(creds);
    const work = await session.createVault({ name: 'Work', description: '', color: '#f60' });
    let item = await session.saveItem({
      ...session.blankItem('login'),
      title: 'VPN',
      fields: [{ id: 'p', label: 'password', value: 'one', kind: 'concealed' }],
    });
    item = await session.saveItem({ ...item, vaultId: work.id, fields: [{ ...item.fields[0], value: 'two' }] });
    expect(item.passwordHistory[0].value).toBe('one');
    const s2 = await store.unlock({ email: creds.email, password: creds.password, secretKey });
    const reloaded = s2.items.find((i) => i.id === item.id)!;
    expect(reloaded.vaultId).toBe(work.id);
    expect(s2.items.filter((i) => i.id === item.id)).toHaveLength(1);
  });
});

describe('totp', () => {
  // RFC 6238 Appendix B, SHA-1 seed "12345678901234567890" → base32.
  const seed = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  it('matches RFC 6238 vectors (6-digit truncation)', async () => {
    expect(await totp(seed, 59_000)).toBe('287082');
    expect(await totp(seed, 1111111109_000)).toBe('081804');
    expect(await totp(seed, 20000000000_000)).toBe('353130');
  });
  it('accepts otpauth URIs', async () => {
    expect(await totp(`otpauth://totp/x?secret=${seed}`, 59_000)).toBe('287082');
  });
});

describe('generator', () => {
  it('honors length and classes', () => {
    const pw = generatePassword({ ...DEFAULT_GENERATOR, length: 32 });
    expect(pw).toHaveLength(32);
    expect(pw).toMatch(/[0-9]/);
    expect(pw).toMatch(/[^A-Za-z0-9]/);
    expect(generatePassword({ ...DEFAULT_GENERATOR, mode: 'pin', length: 6 })).toMatch(/^\d{6}$/);
    expect(generatePassword({ ...DEFAULT_GENERATOR, mode: 'memorable', length: 4 }).split('-')).toHaveLength(4);
  });
  it('rates strength', () => {
    expect(strength('password')).toBe('weak');
    expect(strength('password123')).toBe('weak');
    expect(strength('123456789')).toBe('terrible');
    expect(strength('aaaaaaaa')).toBe('terrible');
    expect(strength(generatePassword(DEFAULT_GENERATOR))).toMatch(/excellent|fantastic/);
  });
});
