// Zero-knowledge local account store.
// Persisted shape holds only ciphertext + public metadata (email, salt, ids, timestamps).
// Key hierarchy: AUK (password + Secret Key) → account key → vault keys → items.

import {
  PBKDF2_ITERATIONS,
  b64,
  decryptJson,
  deriveUnlockKey,
  encryptJson,
  generateAesKey,
  generateSecretKey,
  normalizeSecretKey,
  randomBytes,
  randomId,
  unwrapKey,
  wrapKey,
  type Envelope,
} from '../crypto/keys';
import type { Item, Vault } from '../types';
import { mergeAccounts } from '../sync/merge';

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}

export interface StoredItem {
  id: string;
  createdAt: number;
  updatedAt: number;
  overview: Envelope; // title, urls, tags, category, favorite, trashed
  details: Envelope; // fields, notes, password history
}

export interface StoredVault {
  id: string;
  updatedAt?: number; // attrs edit time; absent on vaults created before sync existed
  attrs: Envelope; // name, description, color — encrypted with the vault key
  key: Envelope; // vault key wrapped by the account key
  items: StoredItem[];
}

export interface Tombstone {
  id: string; // item or vault id
  deletedAt: number;
}

export interface StoredAccount {
  version: 1;
  accountId: string;
  email: string;
  salt: string;
  iterations: number;
  keyset: Envelope; // account key wrapped by AUK
  profile: Envelope; // { name }
  vaults: StoredVault[];
  tombstones?: Tombstone[]; // so a permanent delete on one device isn't undone by another device's copy
}

interface DeviceRecord {
  accountId: string;
  email: string;
  secretKey?: string; // absent when signed in on a public/shared computer
}

/** Face ID / biometric unlock for one account on this device. Never synced. */
export interface BiometricRecord {
  accountId: string;
  credentialId: string; // base64 WebAuthn credential id
  salt: string; // base64 PRF input
  wrapped: Envelope; // account key wrapped by a key derived from the PRF output
  confirmedAt: number; // last password unlock; biometric unlock expires after BIOMETRIC_MAX_AGE_MS
}

export const BIOMETRIC_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

const ACCOUNT_PREFIX = 'keyvault:account:';
const DEVICE_KEY = 'keyvault:device';
const BIOMETRIC_PREFIX = 'keyvault:biometric:';

type Overview = Pick<Item, 'title' | 'urls' | 'tags' | 'category' | 'favorite' | 'trashed'>;
type Details = Pick<Item, 'fields' | 'notes' | 'passwordHistory'>;

export class AccountStore {
  private kv: KeyValueStore;
  private iterations: number;

  constructor(kv: KeyValueStore, iterations = PBKDF2_ITERATIONS) {
    this.kv = kv;
    this.iterations = iterations;
  }

  knownDevices(): DeviceRecord[] {
    try {
      return JSON.parse(this.kv.getItem(DEVICE_KEY) ?? '[]') as DeviceRecord[];
    } catch {
      return [];
    }
  }

  private rememberDevice(rec: DeviceRecord) {
    const rest = this.knownDevices().filter((d) => d.accountId !== rec.accountId);
    this.kv.setItem(DEVICE_KEY, JSON.stringify([rec, ...rest]));
  }

  forgetDevice(accountId: string) {
    this.kv.setItem(DEVICE_KEY, JSON.stringify(this.knownDevices().filter((d) => d.accountId !== accountId)));
    this.removeBiometric(accountId);
  }

  biometric(accountId: string): BiometricRecord | undefined {
    try {
      const raw = this.kv.getItem(BIOMETRIC_PREFIX + accountId);
      return raw ? (JSON.parse(raw) as BiometricRecord) : undefined;
    } catch {
      return undefined;
    }
  }

  /** A record that exists but is past its password re-check date is treated as unusable, not deleted. */
  biometricUsable(accountId: string, now = Date.now()): boolean {
    const rec = this.biometric(accountId);
    return !!rec && now - rec.confirmedAt < BIOMETRIC_MAX_AGE_MS;
  }

  saveBiometric(rec: BiometricRecord) {
    this.kv.setItem(BIOMETRIC_PREFIX + rec.accountId, JSON.stringify(rec));
  }

  removeBiometric(accountId: string) {
    this.kv.removeItem(BIOMETRIC_PREFIX + accountId);
  }

  findAccount(email: string): StoredAccount | undefined {
    const wanted = email.trim().toLowerCase();
    for (let i = 0; i < this.kv.length; i++) {
      const k = this.kv.key(i);
      if (!k?.startsWith(ACCOUNT_PREFIX)) continue;
      const acct = JSON.parse(this.kv.getItem(k)!) as StoredAccount;
      if (acct.email === wanted) return acct;
    }
    return undefined;
  }

  async createAccount(input: { name: string; email: string; password: string }) {
    const email = input.email.trim().toLowerCase();
    if (this.findAccount(email)) throw new Error('An account with that email already exists on this device');
    if (input.password.length < 10) throw new Error('Use at least 10 characters for your password');
    const accountId = randomId();
    const secretKey = generateSecretKey(accountId);
    const salt = randomBytes(16);
    const auk = await deriveUnlockKey({
      password: input.password,
      secretKey,
      email,
      accountId,
      salt,
      iterations: this.iterations,
    });
    const accountKey = await generateAesKey();
    const stored: StoredAccount = {
      version: 1,
      accountId,
      email,
      salt: b64.encode(salt),
      iterations: this.iterations,
      keyset: await wrapKey(auk, accountKey),
      profile: await encryptJson(accountKey, { name: input.name.trim() }),
      vaults: [],
    };
    this.write(stored);
    // reason: the creating device is trusted; without this, Lock fell back to the email step.
    this.rememberDevice({ accountId, email, secretKey });
    const session = new Session(this, stored, accountKey, input.name.trim(), new Map());
    await session.createVault({ name: 'Personal', description: 'Your private vault', color: '#1a8cff' });
    await session.saveItem({
      ...session.blankItem('secure_note'),
      title: 'Welcome to Keyvault',
      notes:
        'Everything in this vault is encrypted with keys derived from your account password AND your Secret Key.\n\n' +
        'Save your Emergency Kit somewhere safe — without the Secret Key nobody (including you) can decrypt this data.',
    });
    return { accountId, secretKey, session };
  }

  async unlock(input: { email: string; password: string; secretKey?: string; publicComputer?: boolean }) {
    const acct = this.findAccount(input.email);
    if (!acct) throw new Error('No account with that email on this device');
    const device = this.knownDevices().find((d) => d.accountId === acct.accountId);
    const secretKey = input.secretKey?.trim() ? normalizeSecretKey(input.secretKey) : device?.secretKey;
    if (!secretKey) throw new Error('Enter your Secret Key to sign in on this device');
    const auk = await deriveUnlockKey({
      password: input.password,
      secretKey,
      email: acct.email,
      accountId: acct.accountId,
      salt: b64.decode(acct.salt),
      iterations: acct.iterations,
    });
    let accountKey: CryptoKey;
    try {
      accountKey = await unwrapKey(auk, acct.keyset);
    } catch {
      // reason: AES-GCM tag failure is the only signal; never reveal which secret was wrong.
      throw new Error('Incorrect password or Secret Key');
    }
    this.rememberDevice({
      accountId: acct.accountId,
      email: acct.email,
      secretKey: input.publicComputer ? undefined : secretKey,
    });
    // reason: a public/shared sign-in must not leave a biometric shortcut from an earlier trusted session.
    if (input.publicComputer) this.removeBiometric(acct.accountId);
    else {
      const bio = this.biometric(acct.accountId);
      if (bio) this.saveBiometric({ ...bio, confirmedAt: Date.now() });
    }
    return this.open(acct, accountKey);
  }

  /** Unlock with an account key recovered by biometric unlock (no password involved). */
  async unlockWithAccountKey(accountId: string, accountKey: CryptoKey) {
    const raw = this.kv.getItem(ACCOUNT_PREFIX + accountId);
    if (!raw) throw new Error('No account with that id on this device');
    return this.open(JSON.parse(raw) as StoredAccount, accountKey);
  }

  private async open(acct: StoredAccount, accountKey: CryptoKey) {
    const { name } = await decryptJson<{ name: string }>(accountKey, acct.profile);
    const vaultKeys = new Map<string, CryptoKey>();
    for (const v of acct.vaults) vaultKeys.set(v.id, await unwrapKey(accountKey, v.key));
    const session = new Session(this, acct, accountKey, name, vaultKeys);
    await session.load();
    return session;
  }

  /** Store an account downloaded from the sync server (new device). Contains only ciphertext. */
  importAccount(acct: StoredAccount) {
    if (this.findAccount(acct.email)) throw new Error('An account with that email already exists on this device');
    this.write(acct);
  }

  write(acct: StoredAccount) {
    this.kv.setItem(ACCOUNT_PREFIX + acct.accountId, JSON.stringify(acct));
  }

  deleteAccount(accountId: string) {
    this.kv.removeItem(ACCOUNT_PREFIX + accountId);
    this.forgetDevice(accountId); // also drops the biometric record
  }
}

export class Session {
  vaults: Vault[] = [];
  items: Item[] = [];
  /** Called after every local write; the sync engine hooks this to schedule an upload. */
  onChange?: () => void;

  readonly name: string;
  private store: AccountStore;
  private acct: StoredAccount;
  private accountKey: CryptoKey;
  private vaultKeys: Map<string, CryptoKey>;

  constructor(store: AccountStore, acct: StoredAccount, accountKey: CryptoKey, name: string, vaultKeys: Map<string, CryptoKey>) {
    this.store = store;
    this.acct = acct;
    this.accountKey = accountKey;
    this.name = name;
    this.vaultKeys = vaultKeys;
  }

  get email() {
    return this.acct.email;
  }
  get accountId() {
    return this.acct.accountId;
  }

  async load() {
    // Build then assign, so a save that lands mid-decrypt isn't clobbered by a half-built list.
    const vaults: Vault[] = [];
    const items: Item[] = [];
    for (const sv of this.acct.vaults) {
      const key = this.vaultKeys.get(sv.id)!;
      const attrs = await decryptJson<Omit<Vault, 'id'>>(key, sv.attrs);
      vaults.push({ id: sv.id, ...attrs });
      for (const si of sv.items) {
        const ov = await decryptJson<Overview>(key, si.overview);
        const det = await decryptJson<Details>(key, si.details);
        items.push({ id: si.id, vaultId: sv.id, createdAt: si.createdAt, updatedAt: si.updatedAt, ...ov, ...det });
      }
    }
    this.vaults = vaults;
    this.items = items;
  }

  blankItem(category: Item['category'], vaultId = this.vaults[0]?.id ?? ''): Item {
    const now = Date.now();
    return {
      id: '',
      vaultId,
      category,
      title: '',
      urls: [],
      tags: [],
      fields: [],
      notes: '',
      favorite: false,
      trashed: false,
      passwordHistory: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  async createVault(attrs: Omit<Vault, 'id'>): Promise<Vault> {
    const id = randomId();
    const key = await generateAesKey();
    this.vaultKeys.set(id, key);
    this.acct.vaults.push({ id, updatedAt: Date.now(), attrs: await encryptJson(key, attrs), key: await wrapKey(this.accountKey, key), items: [] });
    this.persist();
    const vault = { id, ...attrs };
    this.vaults.push(vault);
    return vault;
  }

  async updateVault(vault: Vault) {
    const sv = this.storedVault(vault.id);
    const { name, description, color } = vault;
    sv.attrs = await encryptJson(this.vaultKeys.get(vault.id)!, { name, description, color });
    sv.updatedAt = Date.now();
    this.persist();
    this.vaults = this.vaults.map((v) => (v.id === vault.id ? vault : v));
  }

  deleteVault(vaultId: string) {
    if (this.acct.vaults.length <= 1) throw new Error('You need at least one vault');
    this.acct.vaults = this.acct.vaults.filter((v) => v.id !== vaultId);
    this.vaultKeys.delete(vaultId);
    this.tombstone(vaultId);
    this.persist();
    this.vaults = this.vaults.filter((v) => v.id !== vaultId);
    this.items = this.items.filter((i) => i.vaultId !== vaultId);
  }

  async saveItem(input: Item): Promise<Item> {
    const prev = input.id ? this.items.find((i) => i.id === input.id) : undefined;
    const item: Item = { ...input, id: input.id || randomId(), updatedAt: Date.now() };
    // Keep history of the primary password when it changes.
    const oldPw = prev?.fields.find((f) => f.label === 'password')?.value;
    const newPw = item.fields.find((f) => f.label === 'password')?.value;
    if (oldPw && oldPw !== newPw) item.passwordHistory = [{ value: oldPw, changedAt: Date.now() }, ...item.passwordHistory];

    // Moving vaults: remove from the old vault and re-encrypt under the new vault key.
    if (prev && prev.vaultId !== item.vaultId) {
      const old = this.storedVault(prev.vaultId);
      old.items = old.items.filter((s) => s.id !== item.id);
    }
    const key = this.vaultKeys.get(item.vaultId);
    if (!key) throw new Error('Unknown vault');
    const { title, urls, tags, category, favorite, trashed, fields, notes, passwordHistory } = item;
    const stored: StoredItem = {
      id: item.id,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      overview: await encryptJson(key, { title, urls, tags, category, favorite, trashed } satisfies Overview),
      details: await encryptJson(key, { fields, notes, passwordHistory } satisfies Details),
    };
    const sv = this.storedVault(item.vaultId);
    const idx = sv.items.findIndex((s) => s.id === item.id);
    if (idx >= 0) sv.items[idx] = stored;
    else sv.items.push(stored);
    this.persist();
    this.items = prev ? this.items.map((i) => (i.id === item.id ? item : i)) : [...this.items, item];
    return item;
  }

  /** Bulk-insert new items (import). Encrypts each item but writes storage once. */
  async saveItems(inputs: Item[], onProgress?: (done: number) => void): Promise<Item[]> {
    const saved: Item[] = [];
    for (const input of inputs) {
      const key = this.vaultKeys.get(input.vaultId);
      if (!key) throw new Error('Unknown vault');
      const item: Item = { ...input, id: randomId() };
      const { title, urls, tags, category, favorite, trashed, fields, notes, passwordHistory } = item;
      this.storedVault(item.vaultId).items.push({
        id: item.id,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        overview: await encryptJson(key, { title, urls, tags, category, favorite, trashed } satisfies Overview),
        details: await encryptJson(key, { fields, notes, passwordHistory } satisfies Details),
      });
      saved.push(item);
      onProgress?.(saved.length);
    }
    this.persist();
    this.items = [...this.items, ...saved];
    return saved;
  }

  deleteItemForever(itemId: string) {
    const item = this.items.find((i) => i.id === itemId);
    if (!item) return;
    const sv = this.storedVault(item.vaultId);
    sv.items = sv.items.filter((s) => s.id !== itemId);
    this.tombstone(itemId);
    this.persist();
    this.items = this.items.filter((i) => i.id !== itemId);
  }

  emptyTrash() {
    for (const i of this.items.filter((x) => x.trashed)) this.deleteItemForever(i.id);
  }

  private storedVault(id: string): StoredVault {
    const sv = this.acct.vaults.find((v) => v.id === id);
    if (!sv) throw new Error('Unknown vault');
    return sv;
  }

  /** Wrap the account key for biometric unlock. The raw key never leaves this method. */
  wrapAccountKey(wrapping: CryptoKey): Promise<Envelope> {
    return wrapKey(wrapping, this.accountKey);
  }

  /** Encrypted account as stored; safe to upload. */
  snapshot(): StoredAccount {
    return this.acct;
  }

  /**
   * Replace local state with an already-merged account (from the sync engine), unwrapping keys
   * for vaults that arrived from another device. Does not fire onChange.
   */
  async adopt(incoming: StoredAccount) {
    if (incoming.accountId !== this.acct.accountId) throw new Error('Sync data belongs to a different account');
    const fresh = new Map<string, CryptoKey>();
    for (const v of incoming.vaults) if (!this.vaultKeys.has(v.id)) fresh.set(v.id, await unwrapKey(this.accountKey, v.key));
    // reason: re-merge against the current state after the awaits above, or a local save made
    // meanwhile would be overwritten by the older snapshot the caller merged from.
    const merged = mergeAccounts(this.acct, incoming);
    const keys = new Map<string, CryptoKey>();
    for (const v of merged.vaults) keys.set(v.id, this.vaultKeys.get(v.id) ?? fresh.get(v.id)!);
    this.acct = merged;
    this.vaultKeys = keys;
    this.store.write(this.acct);
    await this.load();
  }

  private tombstone(id: string) {
    this.acct.tombstones = [...(this.acct.tombstones ?? []).filter((t) => t.id !== id), { id, deletedAt: Date.now() }];
  }

  private persist() {
    this.store.write(this.acct);
    this.onChange?.();
  }
}
