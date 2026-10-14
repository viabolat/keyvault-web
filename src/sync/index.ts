// Account-level sync flows (sign-up, unlock on any device) and the background sync engine.
// Local storage stays the source of truth; the server holds one encrypted copy per account.
import { deriveAuthSecret, normalizeSecretKey } from '../crypto/keys';
import type { AccountStore, Session } from '../store/account';
import type { CloudBackend } from './cloud';
import { mergeAccounts, sameAccount } from './merge';

export type ConnectResult = 'ok' | 'confirm-email' | 'mismatch' | 'offline';

export type SyncStatus =
  | { state: 'off' }
  | { state: 'connecting' }
  | { state: 'syncing' }
  | { state: 'synced'; at: number }
  | { state: 'offline' }
  | { state: 'confirm-email' }
  | { state: 'error'; message: string };

interface Secrets {
  email: string;
  password: string;
  secretKey?: string;
  publicComputer?: boolean;
}

function isNetworkError(err: unknown) {
  return err instanceof TypeError || /fetch|network/i.test((err as Error)?.message ?? '');
}

/**
 * Get a server session for an account whose secrets were already verified locally. Registers
 * the account on the server if it isn't there yet (created offline, or before sync existed).
 */
export async function connect(cloud: CloudBackend, s: Required<Pick<Secrets, 'email' | 'password' | 'secretKey'>>, authIterations?: number): Promise<ConnectResult> {
  const email = s.email.trim().toLowerCase();
  try {
    const current = await cloud.currentEmail();
    if (current === email) return 'ok';
    if (current) await cloud.signOut();
    const secret = await deriveAuthSecret({ ...s, email, iterations: authIterations });
    const r = await cloud.signIn(email, secret);
    if (r !== 'invalid') return r;
    // reason: safe only because the caller already proved these secrets by unlocking locally.
    const up = await cloud.signUp(email, secret);
    return up === 'exists' ? 'mismatch' : up;
  } catch (err) {
    if (isNetworkError(err)) return 'offline';
    throw err;
  }
}

export async function signUpAnywhere(
  store: AccountStore,
  cloud: CloudBackend | null,
  input: { name: string; email: string; password: string },
  authIterations?: number,
) {
  const created = await store.createAccount(input);
  if (!cloud) return { ...created, sync: null };
  const email = input.email.trim().toLowerCase();
  const secret = await deriveAuthSecret({ email, password: input.password, secretKey: created.secretKey, iterations: authIterations });
  let sync: ConnectResult;
  try {
    const current = await cloud.currentEmail();
    if (current) await cloud.signOut();
    const r = await cloud.signUp(email, secret);
    if (r === 'exists') {
      store.deleteAccount(created.accountId);
      throw new Error('An account with this email already exists. Sign in with your Secret Key instead.');
    }
    sync = r;
  } catch (err) {
    if (!isNetworkError(err)) {
      // reason: a server-side rejection (e.g. email not allowed) left an orphaned local account
      // whose email could then never be signed up again on this device.
      if (store.findAccount(email)) store.deleteAccount(created.accountId);
      throw err;
    }
    sync = 'offline'; // registered on a later unlock via connect()
  }
  return { ...created, sync };
}

export async function unlockAnywhere(store: AccountStore, cloud: CloudBackend | null, input: Secrets, authIterations?: number) {
  const email = input.email.trim().toLowerCase();
  const local = store.findAccount(email);
  if (!local && cloud) {
    // New device: authenticate to the server, download the encrypted account, then unlock it locally.
    if (!input.secretKey?.trim()) throw new Error('Enter your Secret Key to sign in on this device');
    const secretKey = normalizeSecretKey(input.secretKey);
    const secret = await deriveAuthSecret({ email, password: input.password, secretKey, iterations: authIterations });
    const current = await cloud.currentEmail();
    if (current && current !== email) await cloud.signOut();
    const r = await cloud.signIn(email, secret);
    if (r === 'confirm-email') throw new Error('Confirm your email address first (check your inbox), then sign in again.');
    if (r === 'invalid') throw new Error('Incorrect email, password or Secret Key');
    const remote = await cloud.fetch();
    if (!remote) throw new Error('No synced data for this account yet. Unlock it once on the device where you created it.');
    store.importAccount(remote.blob);
    try {
      const session = await store.unlock({ ...input, secretKey });
      return { session, sync: Promise.resolve<ConnectResult>('ok') };
    } catch (err) {
      store.deleteAccount(remote.blob.accountId);
      throw err;
    }
  }

  const session = await store.unlock(input);
  if (!cloud) return { session, sync: null };
  const secretKey = input.secretKey?.trim() || store.knownDevices().find((d) => d.accountId === session.accountId)?.secretKey;
  // Connecting runs after unlock so a slow or offline server never blocks opening the vault.
  const sync = secretKey ? connect(cloud, { email, password: input.password, secretKey }, authIterations) : Promise.resolve<ConnectResult>('mismatch');
  return { session, sync };
}

const DEBOUNCE_MS = 1500;
const POLL_MS = 30_000;

export class SyncEngine {
  private session: Session;
  private cloud: CloudBackend;
  private onStatus: (s: SyncStatus) => void;
  private onRemoteChange: () => void;
  private debounce?: ReturnType<typeof setTimeout>;
  private poll?: ReturnType<typeof setInterval>;
  private running: Promise<void> | null = null;
  private again = false;
  private stopped = false;

  constructor(session: Session, cloud: CloudBackend, onStatus: (s: SyncStatus) => void, onRemoteChange: () => void) {
    this.session = session;
    this.cloud = cloud;
    this.onStatus = onStatus;
    this.onRemoteChange = onRemoteChange;
  }

  private readonly kick = () => void this.syncNow();

  start() {
    this.session.onChange = () => {
      clearTimeout(this.debounce);
      this.debounce = setTimeout(this.kick, DEBOUNCE_MS);
    };
    this.poll = setInterval(this.kick, POLL_MS);
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', this.kick);
      window.addEventListener('online', this.kick);
    }
    return this.syncNow();
  }

  stop() {
    this.stopped = true;
    this.session.onChange = undefined;
    clearTimeout(this.debounce);
    clearInterval(this.poll);
    if (typeof window !== 'undefined') {
      window.removeEventListener('focus', this.kick);
      window.removeEventListener('online', this.kick);
    }
  }

  /** Runs one sync; calls made while one is running coalesce into a single follow-up run. */
  syncNow(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.run().finally(() => {
      this.running = null;
      if (this.again && !this.stopped) {
        this.again = false;
        void this.syncNow();
      }
    });
    return this.running;
  }

  private async run() {
    if (this.stopped) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return this.onStatus({ state: 'offline' });
    this.onStatus({ state: 'syncing' });
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const remote = await this.cloud.fetch();
        if (remote) {
          const local = this.session.snapshot();
          const merged = mergeAccounts(local, remote.blob);
          if (!sameAccount(merged, local)) {
            await this.session.adopt(merged);
            this.onRemoteChange();
          }
          if (sameAccount(this.session.snapshot(), remote.blob)) return this.onStatus({ state: 'synced', at: Date.now() });
        }
        const rev = await this.cloud.push(this.session.snapshot(), remote?.rev ?? null);
        if (rev !== null) return this.onStatus({ state: 'synced', at: Date.now() });
        // Another device wrote between our fetch and push: fetch again and re-merge.
      }
      this.onStatus({ state: 'error', message: 'Too many simultaneous changes; will retry' });
    } catch (err) {
      this.onStatus(isNetworkError(err) ? { state: 'offline' } : { state: 'error', message: (err as Error).message });
    }
  }
}
