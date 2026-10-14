// Parser for 1Password's .1pux export: a zip whose `export.data` member is JSON
// shaped accounts[].vaults[].items[]. Written from the publicly documented format;
// unknown value shapes fall back to text so nothing is silently dropped.
import { unzipSync, strFromU8 } from 'fflate';
import { randomId } from '../crypto/keys';
import type { Category, Field, FieldKind } from '../types';
import type { ImportedItem, ImportResult } from './types';

interface PuxField {
  title?: string;
  id?: string;
  value?: Record<string, unknown>;
}
interface PuxItem {
  uuid?: string;
  favIndex?: number;
  createdAt?: number;
  updatedAt?: number;
  state?: string;
  categoryUuid?: string;
  overview?: { title?: string; url?: string; urls?: { url?: string }[]; tags?: string[] };
  details?: {
    loginFields?: { value?: string; name?: string; fieldType?: string; designation?: string }[];
    notesPlain?: string;
    password?: string;
    sections?: { title?: string; fields?: PuxField[] }[];
    passwordHistory?: { value?: string; time?: number }[];
  };
}
interface PuxExport {
  accounts?: { vaults?: { attrs?: { name?: string }; items?: PuxItem[] }[] }[];
}

const CATEGORY: Record<string, Category> = {
  '001': 'login',
  '002': 'credit_card',
  '003': 'secure_note',
  '004': 'identity',
  '005': 'password',
  '112': 'api_credential',
};

// Types with no Keyvault equivalent become secure notes tagged with the original type.
const OTHER_TYPES: Record<string, string> = {
  '100': 'Software License',
  '101': 'Bank Account',
  '102': 'Database',
  '103': 'Driver License',
  '104': 'Outdoor License',
  '105': 'Membership',
  '106': 'Passport',
  '107': 'Reward Program',
  '108': 'Social Security Number',
  '109': 'Wireless Router',
  '110': 'Server',
  '111': 'Email Account',
  '113': 'Medical Record',
  '114': 'SSH Key',
  '115': 'Crypto Wallet',
};

// Field ids whose labels drive Keyvault's list subtitles and templates.
const LABEL_BY_ID: Record<string, string> = {
  cardholder: 'cardholder name',
  ccnum: 'number',
  cvv: 'verification number',
  expiry: 'expiry date',
  firstname: 'first name',
  lastname: 'last name',
  email: 'email',
  defphone: 'phone',
  credential: 'credential',
  username: 'username',
  hostname: 'hostname',
};

export function parse1pux(bytes: Uint8Array): ImportResult {
  let files: Record<string, Uint8Array>;
  try {
    // reason: filter keeps attachments compressed; exports with many files would otherwise balloon memory.
    files = unzipSync(bytes, { filter: (f) => f.name.split('/').pop() === 'export.data' });
  } catch {
    throw new Error("This doesn't look like a 1Password .1pux export (couldn't open the zip).");
  }
  const entry = Object.values(files)[0];
  if (!entry) throw new Error('No export.data found inside the .1pux file.');
  return parse1puxData(JSON.parse(strFromU8(entry)) as PuxExport);
}

export function parse1puxData(data: PuxExport): ImportResult {
  const result: ImportResult = { format: '1pux', items: [], skipped: [] };
  for (const account of data.accounts ?? []) {
    for (const vault of account.vaults ?? []) {
      const vaultName = vault.attrs?.name?.trim() || 'Imported';
      for (const raw of vault.items ?? []) {
        const item = convertItem(raw, vaultName, result.skipped);
        if (item) result.items.push(item);
      }
    }
  }
  return result;
}

function convertItem(raw: PuxItem, vaultName: string, skipped: ImportResult['skipped']): ImportedItem | null {
  const title = raw.overview?.title?.trim() || 'Untitled';
  const code = raw.categoryUuid ?? '';
  if (code === '006') {
    skipped.push({ title, reason: 'Document files are not imported' });
    return null;
  }
  const category: Category = CATEGORY[code] ?? 'secure_note';
  const tags = [...(raw.overview?.tags ?? [])];
  if (!CATEGORY[code]) tags.push(OTHER_TYPES[code] ?? 'Imported');
  if (raw.state === 'archived') tags.push('archived');

  const fields: Field[] = [];
  const push = (label: string, value: string, kind: FieldKind) => {
    if (value) fields.push({ id: randomId(), label, value, kind });
  };

  for (const lf of raw.details?.loginFields ?? []) {
    if (lf.designation === 'username') push('username', lf.value ?? '', 'text');
    else if (lf.designation === 'password') push('password', lf.value ?? '', 'concealed');
    else push(lf.name || 'field', lf.value ?? '', lf.fieldType === 'P' ? 'concealed' : lf.fieldType === 'E' ? 'email' : 'text');
  }
  if (raw.details?.password) push('password', raw.details.password, 'concealed');

  let attachments = 0;
  for (const section of raw.details?.sections ?? []) {
    for (const f of section.fields ?? []) {
      const label = LABEL_BY_ID[f.id ?? ''] ?? (f.title?.trim().toLowerCase() || f.id || 'field');
      const conv = convertValue(f.value ?? {});
      if (conv === 'file') attachments++;
      else if (conv) push(label, conv.value, conv.kind);
    }
  }
  if (attachments) skipped.push({ title, reason: `${attachments} file attachment(s) not imported` });

  const urls = [raw.overview?.url, ...(raw.overview?.urls ?? []).map((u) => u.url)]
    .map((u) => u?.trim() ?? '')
    .filter((u, i, all) => u && all.indexOf(u) === i);

  const now = Date.now();
  return {
    vaultName,
    category,
    title,
    urls,
    tags: [...new Set(tags)],
    fields,
    notes: raw.details?.notesPlain ?? '',
    favorite: (raw.favIndex ?? 0) > 0,
    trashed: false,
    passwordHistory: (raw.details?.passwordHistory ?? [])
      .filter((h) => h.value)
      .map((h) => ({ value: h.value!, changedAt: h.time ? h.time * 1000 : now })),
    createdAt: raw.createdAt ? raw.createdAt * 1000 : now,
    updatedAt: raw.updatedAt ? raw.updatedAt * 1000 : now,
  };
}

/** Each section field value is an object with a single type key, e.g. {concealed: "…"}. */
function convertValue(v: Record<string, unknown>): { value: string; kind: FieldKind } | 'file' | null {
  const [type, val] = Object.entries(v)[0] ?? [];
  if (type === undefined || val === null || val === undefined || val === '') return null;
  switch (type) {
    case 'file':
      return 'file';
    case 'concealed':
    case 'creditCardNumber':
      return { value: String(val), kind: 'concealed' };
    case 'totp':
      return { value: String(val), kind: 'totp' };
    case 'url':
      return { value: String(val), kind: 'url' };
    case 'phone':
      return { value: String(val), kind: 'phone' };
    case 'email': {
      const addr = typeof val === 'object' ? (val as { email_address?: string }).email_address : String(val);
      return addr ? { value: addr, kind: 'email' } : null;
    }
    case 'date':
      return typeof val === 'number' ? { value: new Date(val * 1000).toISOString().slice(0, 10), kind: 'date' } : null;
    case 'monthYear': {
      // 202512 → "2025-12"
      const s = String(val);
      return /^\d{6}$/.test(s) ? { value: `${s.slice(0, 4)}-${s.slice(4)}`, kind: 'date' } : null;
    }
    case 'address': {
      const a = val as Record<string, string>;
      const line = [a.street, a.city, a.state, a.zip, a.country].filter(Boolean).join(', ');
      return line ? { value: line, kind: 'text' } : null;
    }
    case 'sshKey': {
      const key = (val as { privateKey?: string }).privateKey;
      return key ? { value: key, kind: 'concealed' } : null;
    }
    default:
      return typeof val === 'object' ? { value: JSON.stringify(val), kind: 'text' } : { value: String(val), kind: 'text' };
  }
}
