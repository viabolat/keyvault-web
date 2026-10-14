// Header-driven CSV import. Column aliases cover 1Password's CSV export and the
// common Bitwarden / browser password-export layouts.
import { randomId } from '../crypto/keys';
import type { Category, Field } from '../types';
import type { ImportedItem, ImportResult } from './types';

const ALIASES = {
  title: ['title', 'name'],
  url: ['url', 'urls', 'website', 'login_uri', 'uri'],
  username: ['username', 'login_username', 'user', 'login'],
  password: ['password', 'login_password'],
  totp: ['otpauth', 'totp', 'login_totp', 'one-time password'],
  favorite: ['favorite', 'favourite'],
  archived: ['archived'],
  tags: ['tags'],
  notes: ['notes', 'note', 'notesplain', 'extra'],
  vault: ['vault', 'folder'],
  type: ['type'],
} as const;

/** RFC 4180 parser: quoted fields, escaped quotes, embedded newlines, CRLF. */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const s = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

export function parseCsv(text: string): ImportResult {
  const [header, ...rows] = parseCsvRows(text);
  if (!header) throw new Error('The CSV file is empty.');
  const cols = header.map((h) => h.trim().toLowerCase());
  const idx = Object.fromEntries(
    Object.entries(ALIASES).map(([k, names]) => [k, cols.findIndex((c) => (names as readonly string[]).includes(c))]),
  ) as Record<keyof typeof ALIASES, number>;
  if (idx.title < 0 && idx.password < 0 && idx.username < 0) {
    throw new Error('Unrecognized CSV: expected a header row with Title, Username or Password columns.');
  }

  const result: ImportResult = { format: 'csv', items: [], skipped: [] };
  const now = Date.now();
  rows.forEach((r, n) => {
    const get = (k: keyof typeof ALIASES) => (idx[k] >= 0 ? (r[idx[k]] ?? '').trim() : '');
    const username = get('username');
    const password = get('password');
    const totp = get('totp');
    const notes = idx.notes >= 0 ? (r[idx.notes] ?? '') : '';
    const urls = get('url').split(/[\s,]+/).filter(Boolean);
    const title = get('title') || hostOf(urls[0]) || username || `Imported item ${n + 1}`;
    if (!username && !password && !totp && !notes.trim() && !urls.length) {
      result.skipped.push({ title, reason: 'Row has no data' });
      return;
    }
    const fields: Field[] = [];
    if (username) fields.push({ id: randomId(), label: 'username', value: username, kind: 'text' });
    if (password) fields.push({ id: randomId(), label: 'password', value: password, kind: 'concealed' });
    if (totp) fields.push({ id: randomId(), label: 'one-time password', value: totp, kind: 'totp' });

    const type = get('type').toLowerCase();
    const category: Category =
      type === 'note' || (!fields.length && !urls.length) ? 'secure_note' : !username && !urls.length ? 'password' : 'login';
    const tags = get('tags').split(/[;,]/).map((t) => t.trim()).filter(Boolean);
    if (truthy(get('archived'))) tags.push('archived');

    const item: ImportedItem = {
      vaultName: get('vault') || 'Imported',
      category,
      title,
      urls,
      tags: [...new Set(tags)],
      fields,
      notes,
      favorite: truthy(get('favorite')),
      trashed: false,
      passwordHistory: [],
      createdAt: now,
      updatedAt: now,
    };
    result.items.push(item);
  });
  return result;
}

function truthy(v: string) {
  return /^(1|true|yes|y)$/i.test(v);
}

export function hostOf(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url.includes('://') ? url : `https://${url}`).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}
