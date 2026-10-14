// Merge two encrypted copies of the same account without decrypting anything.
// Rules: newest updatedAt wins per item (across vaults, so moves don't duplicate) and per
// vault's attrs; a tombstone removes anything not edited after it; a deleted vault takes its
// items with it. Ties keep the local copy, so merging is stable on repeated syncs.
import type { StoredAccount, StoredItem, StoredVault, Tombstone } from '../store/account';

export function mergeAccounts(local: StoredAccount, remote: StoredAccount): StoredAccount {
  if (local.accountId !== remote.accountId) throw new Error('Sync data belongs to a different account');

  const tombs = new Map<string, number>();
  for (const t of [...(local.tombstones ?? []), ...(remote.tombstones ?? [])]) {
    tombs.set(t.id, Math.max(tombs.get(t.id) ?? 0, t.deletedAt));
  }

  // Vaults: union by id, newer attrs win. Vault keys are identical on both sides (same vault).
  const vaults = new Map<string, StoredVault>();
  for (const v of [...local.vaults, ...remote.vaults]) {
    if (tombs.has(v.id)) continue;
    const prev = vaults.get(v.id);
    if (!prev || (v.updatedAt ?? 0) > (prev.updatedAt ?? 0)) vaults.set(v.id, { ...v, items: [] });
  }

  // Items: union by id across all vaults; newest wins (this is what carries vault moves).
  const items = new Map<string, { vaultId: string; item: StoredItem }>();
  for (const acct of [local, remote]) {
    for (const v of acct.vaults) {
      for (const item of v.items) {
        const prev = items.get(item.id);
        if (!prev || item.updatedAt > prev.item.updatedAt) items.set(item.id, { vaultId: v.id, item });
      }
    }
  }
  for (const { vaultId, item } of items.values()) {
    const deletedAt = tombs.get(item.id);
    // reason: an edit made after a permanent delete on another device revives the item instead of losing it.
    if (deletedAt !== undefined && deletedAt >= item.updatedAt) continue;
    vaults.get(vaultId)?.items.push(item);
  }

  const tombstones: Tombstone[] = [...tombs].map(([id, deletedAt]) => ({ id, deletedAt }));
  return { ...local, vaults: [...vaults.values()], tombstones };
}

/** Key-order-independent JSON, because Postgres jsonb does not preserve object key order. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sameAccount(a: StoredAccount, b: StoredAccount): boolean {
  return canonical(normalize(a)) === canonical(normalize(b));
}

// Order of vaults/items/tombstones carries no meaning; sort so equal sets compare equal.
function normalize(a: StoredAccount): StoredAccount {
  const byId = <T extends { id: string }>(xs: T[]) => [...xs].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return {
    ...a,
    vaults: byId(a.vaults).map((v) => ({ ...v, items: byId(v.items) })),
    tombstones: byId(a.tombstones ?? []),
  };
}
