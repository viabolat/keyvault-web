export type Category = 'login' | 'password' | 'secure_note' | 'credit_card' | 'identity' | 'api_credential';

export type FieldKind = 'text' | 'concealed' | 'totp' | 'email' | 'url' | 'phone' | 'date';

export interface Field {
  id: string;
  label: string;
  value: string;
  kind: FieldKind;
}

export interface Item {
  id: string;
  vaultId: string;
  category: Category;
  title: string;
  urls: string[];
  tags: string[];
  fields: Field[];
  notes: string;
  favorite: boolean;
  trashed: boolean;
  passwordHistory: { value: string; changedAt: number }[];
  createdAt: number;
  updatedAt: number;
}

export interface Vault {
  id: string;
  name: string;
  description: string;
  color: string;
}

export const CATEGORY_LABEL: Record<Category, string> = {
  login: 'Login',
  password: 'Password',
  secure_note: 'Secure Note',
  credit_card: 'Credit Card',
  identity: 'Identity',
  api_credential: 'API Credential',
};

/** Default field template per category (new-item editor). */
export const CATEGORY_TEMPLATE: Record<Category, Omit<Field, 'id' | 'value'>[]> = {
  login: [
    { label: 'username', kind: 'text' },
    { label: 'password', kind: 'concealed' },
  ],
  password: [{ label: 'password', kind: 'concealed' }],
  secure_note: [],
  credit_card: [
    { label: 'cardholder name', kind: 'text' },
    { label: 'number', kind: 'concealed' },
    { label: 'expiry date', kind: 'date' },
    { label: 'verification number', kind: 'concealed' },
  ],
  identity: [
    { label: 'first name', kind: 'text' },
    { label: 'last name', kind: 'text' },
    { label: 'email', kind: 'email' },
    { label: 'phone', kind: 'phone' },
  ],
  api_credential: [
    { label: 'username', kind: 'text' },
    { label: 'credential', kind: 'concealed' },
    { label: 'hostname', kind: 'url' },
  ],
};

/** Subtitle shown in the item list, mirroring the list-row convention of the source app. */
export function itemSubtitle(item: Item): string {
  const f = (label: string) => item.fields.find((x) => x.label === label)?.value ?? '';
  switch (item.category) {
    case 'login':
    case 'api_credential':
      return f('username');
    case 'credit_card': {
      const n = f('number').replace(/\s/g, '');
      return n ? '•••• ' + n.slice(-4) : '';
    }
    case 'identity':
      return [f('first name'), f('last name')].filter(Boolean).join(' ');
    case 'secure_note':
      return item.notes.split('\n')[0].slice(0, 60);
    default:
      return '';
  }
}

export function primaryPassword(item: Item): string | undefined {
  return item.fields.find((f) => f.kind === 'concealed' && f.label === 'password')?.value;
}
