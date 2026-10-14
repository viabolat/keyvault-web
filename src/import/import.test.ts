import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { parseExport, applyImport } from './index';
import { parseCsvRows } from './csv';
import { AccountStore, type KeyValueStore } from '../store/account';

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

// Hand-built fixture following the published 1PUX layout.
const PUX = {
  accounts: [
    {
      attrs: { name: 'Ada' },
      vaults: [
        {
          attrs: { name: 'Personal' },
          items: [
            {
              uuid: 'a1', favIndex: 1, createdAt: 1700000000, updatedAt: 1700000100, state: 'active', categoryUuid: '001',
              overview: { title: 'Mail', url: 'https://mail.example.com', urls: [{ url: 'https://mail.example.com' }, { url: 'https://alt.example.com' }], tags: ['email'] },
              details: {
                loginFields: [
                  { value: 'ada', designation: 'username', fieldType: 'T' },
                  { value: 's3cret!', designation: 'password', fieldType: 'P' },
                ],
                notesPlain: 'hello',
                sections: [{ title: '', fields: [{ title: 'one-time password', id: 'TOTP_x', value: { totp: 'otpauth://totp/x?secret=GEZDGNBVGY3TQOJQ' } }] }],
                passwordHistory: [{ value: 'old-pw', time: 1690000000 }],
              },
            },
            {
              uuid: 'a2', categoryUuid: '002', state: 'archived',
              overview: { title: 'Visa' },
              details: {
                sections: [{ fields: [
                  { id: 'cardholder', title: 'cardholder name', value: { string: 'Ada L' } },
                  { id: 'ccnum', title: 'number', value: { creditCardNumber: '4111111111111111' } },
                  { id: 'expiry', title: 'expiry date', value: { monthYear: 202812 } },
                  { id: 'scan', title: 'scan', value: { file: { fileName: 'x.png' } } },
                ] }],
              },
            },
            { uuid: 'a3', categoryUuid: '006', overview: { title: 'Passport scan' }, details: {} },
            {
              uuid: 'a4', categoryUuid: '101', overview: { title: 'Bank' },
              details: { sections: [{ fields: [
                { id: 'acct', title: 'Account Number', value: { string: '12345' } },
                { id: 'addr', title: 'Branch', value: { address: { street: '1 Main', city: 'Town', zip: '999' } } },
                { id: 'em', title: 'Contact', value: { email: { email_address: 'b@bank.test' } } },
                { id: 'd', title: 'Opened', value: { date: 0 } },
              ] }] },
            },
          ],
        },
        { attrs: { name: 'Work' }, items: [{ uuid: 'b1', categoryUuid: '005', overview: { title: 'Wifi' }, details: { password: 'wifi-pw' } }] },
      ],
    },
  ],
};

const pux = () => zipSync({ 'export.attributes': strToU8('{}'), 'export.data': strToU8(JSON.stringify(PUX)), 'files/x.png': new Uint8Array(10) });

describe('1pux import', () => {
  it('maps items, fields, vaults and skips documents/attachments', () => {
    const r = parseExport(pux());
    expect(r.format).toBe('1pux');
    expect(r.items.map((i) => i.title)).toEqual(['Mail', 'Visa', 'Bank', 'Wifi']);
    const mail = r.items[0];
    expect(mail).toMatchObject({ category: 'login', favorite: true, notes: 'hello', vaultName: 'Personal', tags: ['email'] });
    expect(mail.urls).toEqual(['https://mail.example.com', 'https://alt.example.com']);
    expect(mail.fields.map((f) => [f.label, f.kind, f.value])).toEqual([
      ['username', 'text', 'ada'],
      ['password', 'concealed', 's3cret!'],
      ['one-time password', 'totp', 'otpauth://totp/x?secret=GEZDGNBVGY3TQOJQ'],
    ]);
    expect(mail.passwordHistory).toEqual([{ value: 'old-pw', changedAt: 1690000000000 }]);
    expect(mail.createdAt).toBe(1700000000000);

    const visa = r.items[1];
    expect(visa.category).toBe('credit_card');
    expect(visa.tags).toContain('archived');
    expect(visa.fields.find((f) => f.label === 'number')).toMatchObject({ kind: 'concealed', value: '4111111111111111' });
    expect(visa.fields.find((f) => f.label === 'expiry date')?.value).toBe('2028-12');

    const bank = r.items[2];
    expect(bank).toMatchObject({ category: 'secure_note', tags: ['Bank Account'] });
    expect(bank.fields.map((f) => f.value)).toEqual(['12345', '1 Main, Town, 999', 'b@bank.test', '1970-01-01']);

    expect(r.items[3]).toMatchObject({ category: 'password', vaultName: 'Work' });
    expect(r.skipped.map((s) => s.title)).toEqual(['Visa', 'Passport scan']);
  });

  it('rejects a zip without export.data', () => {
    expect(() => parseExport(zipSync({ 'a.txt': strToU8('x') }))).toThrow('export.data');
  });
});

describe('csv import', () => {
  it('parses quotes, embedded newlines and CRLF', () => {
    expect(parseCsvRows('\uFEFFa,b\r\n"x, ""y""","line1\nline2"\r\n')).toEqual([
      ['a', 'b'],
      ['x, "y"', 'line1\nline2'],
    ]);
  });

  it('reads 1Password CSV columns', () => {
    const csv = 'Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes\n' +
      'Mail,https://mail.example.com,ada,pw1,,true,false,"a;b","multi\nline"\n' +
      'PIN,,,1234,,false,true,,\n' +
      'Thoughts,,,,,,,,just a note\n';
    const r = parseExport(new TextEncoder().encode(csv));
    expect(r.format).toBe('csv');
    expect(r.items.map((i) => [i.title, i.category])).toEqual([
      ['Mail', 'login'],
      ['PIN', 'password'],
      ['Thoughts', 'secure_note'],
    ]);
    expect(r.items[0]).toMatchObject({ favorite: true, tags: ['a', 'b'], notes: 'multi\nline' });
    expect(r.items[1].tags).toEqual(['archived']);
  });

  it('reads Bitwarden/browser style columns', () => {
    const csv = 'folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n' +
      'Work,1,login,,,,0,https://www.git.example,dev,pw,JBSWY3DPEHPK3PXP\n';
    const [item] = parseExport(new TextEncoder().encode(csv)).items;
    expect(item).toMatchObject({ title: 'git.example', vaultName: 'Work', favorite: true, category: 'login' });
    expect(item.fields.map((f) => f.kind)).toEqual(['text', 'concealed', 'totp']);
  });

  it('rejects unrelated CSVs', () => {
    expect(() => parseExport(new TextEncoder().encode('foo,bar\n1,2\n'))).toThrow('Unrecognized CSV');
  });
});

describe('applyImport', () => {
  it('creates vaults by name, skips duplicates and persists once', async () => {
    const kv = new MemoryKV();
    let writes = 0;
    const set = kv.setItem.bind(kv);
    kv.setItem = (k, v) => {
      writes++;
      set(k, v);
    };
    const store = new AccountStore(kv, 1000);
    const { session, secretKey } = await store.createAccount({ name: 'Ada', email: 'ada@x.test', password: 'correct horse battery' });
    const r = parseExport(pux());

    writes = 0;
    const first = await applyImport(session, r, { target: 'original', skipDuplicates: true });
    expect(first).toMatchObject({ imported: 4, duplicates: 0, vaultsCreated: ['Work'] });
    // one createVault write + one bulk write
    expect(writes).toBe(2);

    const second = await applyImport(session, r, { target: 'original', skipDuplicates: true });
    expect(second).toMatchObject({ imported: 0, duplicates: 4 });

    const reloaded = await store.unlock({ email: 'ada@x.test', password: 'correct horse battery', secretKey });
    const work = reloaded.vaults.find((v) => v.name === 'Work')!;
    expect(reloaded.items.find((i) => i.title === 'Wifi')?.vaultId).toBe(work.id);
    expect(reloaded.items.find((i) => i.title === 'Mail')?.fields[1].value).toBe('s3cret!');
    expect([...kv.m.values()].join('')).not.toContain('s3cret!');

    const third = await applyImport(reloaded, r, { target: work.id, skipDuplicates: false });
    expect(third.imported).toBe(4);
    expect(reloaded.items.filter((i) => i.vaultId === work.id)).toHaveLength(5);
  });
});
