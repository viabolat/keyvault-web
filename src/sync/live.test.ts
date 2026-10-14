// Live test against the real Supabase project. Skipped unless KEYVAULT_LIVE=1.
// Needs "Confirm email" off. Creates two throwaway auth users (delete them afterwards in the dashboard).
import { describe, expect, it } from 'vitest';
import { AccountStore, type KeyValueStore, type Session } from '../store/account';
import { SupabaseBackend } from './cloud';
import { SyncEngine, signUpAnywhere, unlockAnywhere, type SyncStatus } from './index';

const URL = process.env.VITE_SUPABASE_URL ?? '';
const KEY = process.env.VITE_SUPABASE_ANON_KEY ?? '';

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

const device = () => ({ store: new AccountStore(new MemoryKV(), 1000), cloud: new SupabaseBackend(URL, KEY) });

async function sync(session: Session, cloud: SupabaseBackend) {
  let last: SyncStatus = { state: 'off' };
  const engine = new SyncEngine(session, cloud, (s) => (last = s), () => {});
  await engine.syncNow();
  engine.stop();
  return last;
}

describe.skipIf(!process.env.KEYVAULT_LIVE)('live Supabase', () => {
  const stamp = Date.now();
  const creds = { name: 'Live Test', email: `keyvault-livetest-${stamp}@example.com`, password: 'live test password 123' };

  it('syncs two devices through the real project, ciphertext only, RLS-isolated', async () => {
    const a = device();
    const { session: sa, secretKey, sync: signup } = await signUpAnywhere(a.store, a.cloud, creds);
    expect(signup).toBe('ok');
    await sa.saveItem({ ...sa.blankItem('login'), title: 'LiveBank', fields: [{ id: 'p', label: 'password', value: 'pw-LIVE-SECRET', kind: 'concealed' }] });
    expect((await sync(sa, a.cloud)).state).toBe('synced');

    // What the server stores: no plaintext.
    const raw = JSON.stringify(await a.cloud.fetch());
    for (const s of ['LiveBank', 'pw-LIVE-SECRET', creds.password, secretKey, 'Live Test']) expect(raw).not.toContain(s);

    // Device B: wrong password refused; right one downloads and decrypts.
    const b = device();
    await expect(unlockAnywhere(b.store, b.cloud, { email: creds.email, password: 'wrong password 999', secretKey })).rejects.toThrow('Incorrect');
    const { session: sb } = await unlockAnywhere(b.store, b.cloud, { email: creds.email, password: creds.password, secretKey });
    expect(sb.items.find((i) => i.title === 'LiveBank')?.fields[0].value).toBe('pw-LIVE-SECRET');

    // Concurrent edits on both devices converge.
    await sa.saveItem({ ...sa.blankItem('secure_note'), title: 'From A' });
    await sb.saveItem({ ...sb.blankItem('secure_note'), title: 'From B' });
    await sync(sa, a.cloud);
    await sync(sb, b.cloud);
    await sync(sa, a.cloud);
    const titles = (s: Session) => s.items.map((i) => i.title).sort();
    expect(titles(sa)).toEqual(['From A', 'From B', 'LiveBank', 'Welcome to Keyvault']);
    expect(titles(sb)).toEqual(titles(sa));

    // Stale revision is rejected by the server (optimistic concurrency).
    const cur = (await a.cloud.fetch())!;
    expect(await a.cloud.push(sa.snapshot(), cur.rev - 1)).toBeNull();

    // A different user sees no row and cannot overwrite A's.
    const c = device();
    const other = await signUpAnywhere(c.store, c.cloud, { ...creds, email: `keyvault-livetest-${stamp}-other@example.com` });
    expect(other.sync).toBe('ok');
    expect(await c.cloud.fetch()).toBeNull();
    const after = (await a.cloud.fetch())!;
    expect(after.rev).toBe(cur.rev);

    // Cleanup: rows (auth users must be deleted in the dashboard).
    for (const cl of [a.cloud, c.cloud]) {
      // reason: SupabaseBackend has no delete; use its client directly for test cleanup only.
      const sbc = (cl as unknown as { sb: { from: (t: string) => { delete: () => { not: (c: string, o: string, v: null) => Promise<{ error: unknown }> } } } }).sb;
      const { error } = await sbc.from('vault_accounts').delete().not('user_id', 'is', null);
      expect(error).toBeNull();
    }
    expect(await a.cloud.fetch()).toBeNull();
    console.log('LIVE TEST USERS:', creds.email, `keyvault-livetest-${stamp}-other@example.com`);
  }, 120_000);
});
