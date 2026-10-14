import type { Session } from '../store/account';
import type { Item } from '../types';
import { parse1pux } from './onepassword';
import { parseCsv, hostOf } from './csv';
import type { ImportedItem, ImportResult } from './types';

export type { ImportedItem, ImportResult } from './types';

/** Detects the format from content (zip magic "PK") rather than trusting the extension. */
export function parseExport(bytes: Uint8Array): ImportResult {
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return parse1pux(bytes);
  return parseCsv(new TextDecoder().decode(bytes));
}

export interface ImportOptions {
  /** 'original' recreates the source vaults by name; otherwise a Keyvault vault id. */
  target: 'original' | string;
  skipDuplicates: boolean;
}

function dupKey(i: Pick<Item, 'title' | 'urls' | 'fields'>) {
  const user = i.fields.find((f) => f.label === 'username')?.value ?? '';
  return [i.title.trim().toLowerCase(), user.toLowerCase(), hostOf(i.urls[0])].join('\u0000');
}

export async function applyImport(
  session: Session,
  result: ImportResult,
  opts: ImportOptions,
  onProgress?: (done: number, total: number) => void,
): Promise<{ imported: number; duplicates: number; vaultsCreated: string[] }> {
  const seen = new Set(session.items.filter((i) => !i.trashed).map(dupKey));
  const todo: ImportedItem[] = [];
  let duplicates = 0;
  for (const item of result.items) {
    const k = dupKey(item);
    if (opts.skipDuplicates && seen.has(k)) {
      duplicates++;
      continue;
    }
    seen.add(k);
    todo.push(item);
  }

  const vaultsCreated: string[] = [];
  const vaultIdFor = new Map<string, string>();
  if (opts.target === 'original') {
    for (const name of new Set(todo.map((i) => i.vaultName))) {
      const existing = session.vaults.find((v) => v.name.toLowerCase() === name.toLowerCase());
      if (existing) vaultIdFor.set(name, existing.id);
      else {
        const v = await session.createVault({ name, description: 'Imported', color: '#6366f1' });
        vaultIdFor.set(name, v.id);
        vaultsCreated.push(name);
      }
    }
  }

  const items: Item[] = todo.map(({ vaultName, ...rest }) => ({
    ...rest,
    id: '',
    vaultId: opts.target === 'original' ? vaultIdFor.get(vaultName)! : opts.target,
  }));
  await session.saveItems(items, (n) => onProgress?.(n, items.length));
  return { imported: items.length, duplicates, vaultsCreated };
}
