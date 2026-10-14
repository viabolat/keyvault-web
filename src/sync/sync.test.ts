import { describe, expect, it } from 'vitest';
import { AccountStore, type KeyValueStore, type Session, type StoredAccount } from '../store/account';
import type { CloudBackend, Remote, SignInResult, SignUpResult } from './cloud';
import { SyncEngine, signUpAnywhere, unlockAnywhere, type SyncStatus } from './index';
import { mergeAccounts } from './merge';

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

/** In-memory stand-in for Supabase: auth users + one row per user, with RLS-like scoping. */
class FakeServer {
  users = new Map<string, { secret: string; confirmed: boolean }>();
  rows = new Map<string, Remote>(); // by email
  requireConfirm = false;
  log: string[] = []; // everything the server ever received
}

class FakeClient implements CloudBackend {
  private server: FakeServer;
  me: string | null = null;
  constructor(server: FakeServer) {
    this.server = server;
  }
  async currentEmail() {
    return this.me;
  }
  async signIn(email: string, secret: string): Promise<SignInResult> {
    this.server.log.push(email, secret);
    const u = this.server.users.get(email);
    if (!u || u.secret !== secret) return 'invalid';
    if (!u.confirmed) return 'confirm-email';
    this.me = email;
    return 'ok';
  }
  async signUp(email: string, secret: string): Promise<SignUpResult> {
    this.server.log.push(email, secret);
    if (this.server.users.has(email)) return 'exists';
    this.server.users.set(email, { secret, confirmed: !this.server.requireConfirm });
    if (this.server.requireConfirm) return 'confirm-email';
    this.me = email;
    return 'ok';
  }
  async signOut() {
    this.me = null;
  }
  async fetch() {
    if (!this.me) throw new Error('not signed in');
    const r = this.server.rows.get(this.me);
    return r ? (JSON.parse(JSON.stringify(r)) as Remote) : null;
  }
  async push(blob: StoredAccount, expectedRev: number | null) {
    if (!this.me) throw new Error('not signed in');
    const json = JSON.stringify(blob);
    this.server.log.push(json);
    const cur = this.server.rows.get(this.me);
    if ((cur?.rev ?? null) !== expectedRev) return null;
    const rev = (expectedRev ?? 0) + 1;
    this.server.rows.set(this.me, { blob: JSON.parse(json), rev });
    return rev;
  }
}

const ITER = 1000;
const AUTH_ITER = 1000;
const creds = { name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' };

function device(server: FakeServer) {
  const kv = new MemoryKV();
  return { kv, store: new AccountStore(kv, ITER), cloud: new FakeClient(server) };
}

async function engineFor(session: Session, cloud: CloudBackend) {
  const statuses: SyncStatus[] = [];
  const engine = new SyncEngine(session, cloud, (s) => statuses.push(s), () => {});
  await engine.syncNow();
  engine.stop();
  return { engine, statuses };
}

describe('sync', () => {
  it('signs up, uploads ciphertext only, and signs in on a new device with the Secret Key', async () => {
    const server = new FakeServer();
    const a = device(server);
    const { session, secretKey, sync } = await signUpAnywhere(a.store, a.cloud, creds, AUTH_ITER);
    expect(sync).toBe('ok');
    await session.saveItem({ ...session.blankItem('login'), title: 'Bank', fields: [{ id: 'p', label: 'password', value: 'pw-TOPSECRET', kind: 'concealed' }] });
    const { statuses } = await engineFor(session, a.cloud);
    expect(statuses[statuses.length - 1]?.state).toBe('synced');

    const sent = server.log.join('\n');
    for (const secret of ['pw-TOPSECRET', 'Bank', creds.password, secretKey, secretKey.replace(/-/g, '')]) expect(sent).not.toContain(secret);

    const b = device(server);
    await expect(unlockAnywhere(b.store, b.cloud, { email: creds.email, password: 'wrong password!!', secretKey }, AUTH_ITER)).rejects.toThrow(
      'Incorrect email, password or Secret Key',
    );
    expect(b.store.findAccount(creds.email)).toBeUndefined();

    const { session: sb } = await unlockAnywhere(b.store, b.cloud, { email: creds.email, password: creds.password, secretKey }, AUTH_ITER);
    expect(sb.items.find((i) => i.title === 'Bank')?.fields[0].value).toBe('pw-TOPSECRET');
    // Device B is now trusted: password alone unlocks locally.
    await expect(unlockAnywhere(b.store, b.cloud, { email: creds.email, password: creds.password }, AUTH_ITER)).resolves.toBeTruthy();
  });

  it('merges concurrent edits, keeps deletes deleted, and follows vault moves', async () => {
    const server = new FakeServer();
    const a = device(server);
    const { session: sa, secretKey } = await signUpAnywhere(a.store, a.cloud, creds, AUTH_ITER);
    const keep = await sa.saveItem({ ...sa.blankItem('login'), title: 'Keep' });
    const doomed = await sa.saveItem({ ...sa.blankItem('login'), title: 'Doomed' });
    const mover = await sa.saveItem({ ...sa.blankItem('login'), title: 'Mover' });
    await engineFor(sa, a.cloud);

    const b = device(server);
    const { session: sb } = await unlockAnywhere(b.store, b.cloud, { ...creds, secretKey }, AUTH_ITER);

    // A: delete forever + create a vault and move an item into it. B: edit another item, add one.
    sa.deleteItemForever(doomed.id);
    const work = await sa.createVault({ name: 'Work', description: '', color: '#f60' });
    await sa.saveItem({ ...sa.items.find((i) => i.id === mover.id)!, vaultId: work.id });
    await new Promise((r) => setTimeout(r, 2));
    await sb.saveItem({ ...sb.items.find((i) => i.id === keep.id)!, title: 'Keep (edited on B)' });
    await sb.saveItem({ ...sb.blankItem('secure_note'), title: 'From B' });

    await engineFor(sa, a.cloud);
    await engineFor(sb, b.cloud);
    await engineFor(sa, a.cloud);

    for (const s of [sa, sb]) {
      expect(s.items.map((i) => i.title).sort()).toEqual(['From B', 'Keep (edited on B)', 'Mover', 'Welcome to Keyvault']);
      expect(s.items.find((i) => i.id === mover.id)?.vaultId).toBe(work.id);
      expect(s.vaults.map((v) => v.name).sort()).toEqual(['Personal', 'Work']);
    }
    // Survives a reload from local storage on B.
    const again = await b.store.unlock({ email: creds.email, password: creds.password });
    expect(again.items).toHaveLength(4);
  });

  it('retries when another device wrote between fetch and push', async () => {
    const server = new FakeServer();
    const a = device(server);
    const { session: sa, secretKey } = await signUpAnywhere(a.store, a.cloud, creds, AUTH_ITER);
    await engineFor(sa, a.cloud);
    const b = device(server);
    const { session: sb } = await unlockAnywhere(b.store, b.cloud, { ...creds, secretKey }, AUTH_ITER);

    await sa.saveItem({ ...sa.blankItem('login'), title: 'A item' });
    // After A fetches, B saves and syncs, so A's first push carries a stale rev and must be rejected.
    const realFetch = a.cloud.fetch.bind(a.cloud);
    let pushes = 0;
    const realPush = a.cloud.push.bind(a.cloud);
    a.cloud.push = async (blob, rev) => {
      pushes++;
      return realPush(blob, rev);
    };
    let first = true;
    a.cloud.fetch = async () => {
      const r = await realFetch();
      if (first) {
        first = false;
        await sb.saveItem({ ...sb.blankItem('login'), title: 'B item' });
        await engineFor(sb, b.cloud);
      }
      return r;
    };
    const { statuses } = await engineFor(sa, a.cloud);
    expect(pushes).toBe(2);
    expect(statuses[statuses.length - 1]?.state).toBe('synced');
    await engineFor(sb, b.cloud);
    for (const s of [sa, sb]) expect(s.items.map((i) => i.title).sort()).toEqual(['A item', 'B item', 'Welcome to Keyvault']);
  });

  it('registers an existing local-only account on first unlock, and handles email confirmation', async () => {
    const server = new FakeServer();
    server.requireConfirm = true;
    const a = device(server);
    const { secretKey } = await a.store.createAccount(creds); // created before sync existed
    const { sync } = await unlockAnywhere(a.store, a.cloud, { email: creds.email, password: creds.password }, AUTH_ITER);
    expect(await sync).toBe('confirm-email');
    server.users.get(creds.email)!.confirmed = true;
    const r = await unlockAnywhere(a.store, a.cloud, { email: creds.email, password: creds.password }, AUTH_ITER);
    expect(await r.sync).toBe('ok');
    await engineFor(r.session, a.cloud);
    expect(server.rows.get(creds.email)?.blob.accountId).toBe(r.session.accountId);
    expect(secretKey).toBeTruthy();
  });

  it('refuses sign-up when the email is already registered and leaves no local account', async () => {
    const server = new FakeServer();
    const a = device(server);
    await signUpAnywhere(a.store, a.cloud, creds, AUTH_ITER);
    const b = device(server);
    await expect(signUpAnywhere(b.store, b.cloud, creds, AUTH_ITER)).rejects.toThrow('already exists');
    expect(b.store.findAccount(creds.email)).toBeUndefined();

    const c = device(server);
    c.cloud.signUp = async () => {
      throw new Error('Sync sign-up failed: Email address not authorized');
    };
    await expect(signUpAnywhere(c.store, c.cloud, { ...creds, email: 'new@example.com' }, AUTH_ITER)).rejects.toThrow('not authorized');
    expect(c.store.findAccount('new@example.com')).toBeUndefined();
  });
});

describe('mergeAccounts', () => {
  it('lets an edit made after a delete win', () => {
    const base = { version: 1, accountId: 'x', email: 'e', salt: '', iterations: 1, keyset: { iv: '', data: '' }, profile: { iv: '', data: '' } } as const;
    const item = (updatedAt: number) => ({ id: 'i', createdAt: 0, updatedAt, overview: { iv: '', data: String(updatedAt) }, details: { iv: '', data: '' } });
    const vault = (items: ReturnType<typeof item>[]) => ({ id: 'v', attrs: { iv: '', data: '' }, key: { iv: '', data: '' }, items });
    const local: StoredAccount = { ...base, vaults: [vault([])], tombstones: [{ id: 'i', deletedAt: 10 }] };
    expect(mergeAccounts(local, { ...base, vaults: [vault([item(5)])] }).vaults[0].items).toHaveLength(0);
    expect(mergeAccounts(local, { ...base, vaults: [vault([item(20)])] }).vaults[0].items).toHaveLength(1);
  });
});
