import { useEffect, useState } from 'react';
import { CATEGORY_LABEL, CATEGORY_TEMPLATE, type Field, type FieldKind, type Item, type Vault } from '../types';
import { CategoryIcon, Icon } from './icons';
import { DEFAULT_GENERATOR, generatePassword, strength, type GeneratorOptions } from '../crypto/generator';
import { randomId } from '../crypto/keys';
import { totp, totpSecondsRemaining } from '../crypto/totp';
import { StrengthMeter } from './Auth';

export type CopyFn = (label: string, value: string) => void;

export function ItemDetail(props: {
  item: Item; vault?: Vault; onEdit: () => void; onCopy: CopyFn;
  onToggleFavorite: () => void; onTrash: () => void; onRestore: () => void; onDeleteForever: () => void; onBack: () => void;
}) {
  const { item } = props;
  return (
    <article className="detail" aria-label={item.title}>
      <header className="detail-head">
        <button className="icon-btn mobile-only" onClick={props.onBack} aria-label="Back"><Icon.back /></button>
        <CategoryIcon category={item.category} title={item.title} size={52} />
        <div className="detail-title">
          <h2>{item.title || 'Untitled'}</h2>
          <span className="muted">{CATEGORY_LABEL[item.category]} · {props.vault?.name}</span>
        </div>
        <div className="detail-actions">
          {item.trashed ? (
            <>
              <button className="btn" onClick={props.onRestore}>Restore</button>
              <button className="btn danger" onClick={props.onDeleteForever}>Delete permanently</button>
            </>
          ) : (
            <>
              <button className={`icon-btn ${item.favorite ? 'fav' : ''}`} onClick={props.onToggleFavorite}
                aria-label={item.favorite ? 'Remove from Favorites' : 'Add to Favorites'}><Icon.star filled={item.favorite} /></button>
              <button className="icon-btn" onClick={props.onTrash} aria-label="Move to Trash"><Icon.trash /></button>
              <button className="btn primary" onClick={props.onEdit}><Icon.edit size={16} /> Edit</button>
            </>
          )}
        </div>
      </header>

      {item.fields.length > 0 && (
        <section className="field-group">
          {item.fields.map((f) => <FieldRow key={f.id} field={f} onCopy={props.onCopy} />)}
        </section>
      )}

      {item.urls.length > 0 && (
        <section className="field-group">
          {item.urls.map((u, i) => (
            <div className="field-row" key={i}>
              <div className="field-label-sm">{i === 0 ? 'website' : 'website ' + (i + 1)}</div>
              <div className="field-value">
                <a href={/^https?:/i.test(u) ? u : 'https://' + u} target="_blank" rel="noreferrer noopener">{u} <Icon.external size={14} /></a>
              </div>
              <button className="icon-btn" onClick={() => props.onCopy('website', u)} aria-label="Copy website"><Icon.copy size={16} /></button>
            </div>
          ))}
        </section>
      )}

      {item.notes && (
        <section className="field-group">
          <div className="field-row notes">
            <div className="field-label-sm">notes</div>
            <div className="field-value pre">{item.notes}</div>
          </div>
        </section>
      )}

      {item.tags.length > 0 && (
        <div className="tags">{item.tags.map((t) => <span className="tag" key={t}><Icon.tag size={12} /> {t}</span>)}</div>
      )}

      {item.passwordHistory.length > 0 && (
        <details className="history">
          <summary>Password history ({item.passwordHistory.length})</summary>
          {item.passwordHistory.map((h, i) => (
            <FieldRow key={i} field={{ id: String(i), label: new Date(h.changedAt).toLocaleString(), value: h.value, kind: 'concealed' }} onCopy={props.onCopy} />
          ))}
        </details>
      )}

      <footer className="meta muted">
        Last edited {new Date(item.updatedAt).toLocaleString()} · Created {new Date(item.createdAt).toLocaleDateString()}
      </footer>
    </article>
  );
}

function FieldRow({ field, onCopy }: { field: Field; onCopy: CopyFn }) {
  const [revealed, setRevealed] = useState(false);
  if (field.kind === 'totp') return <TotpRow field={field} onCopy={onCopy} />;
  const concealed = field.kind === 'concealed';
  return (
    <div className="field-row">
      <div className="field-label-sm">{field.label}</div>
      <div className={`field-value ${concealed ? 'mono' : ''}`}>
        {concealed && !revealed ? '••••••••••' : <ColoredPassword value={field.value} enabled={concealed} />}
        {concealed && field.label === 'password' && revealed && <StrengthMeter value={strength(field.value)} />}
      </div>
      {concealed && (
        <button className="icon-btn" onClick={() => setRevealed(!revealed)} aria-label={revealed ? 'Hide' : 'Reveal'}>
          {revealed ? <Icon.eyeOff size={16} /> : <Icon.eye size={16} />}
        </button>
      )}
      <button className="icon-btn" onClick={() => onCopy(field.label, field.value)} aria-label={`Copy ${field.label}`}><Icon.copy size={16} /></button>
    </div>
  );
}

/** Digits and symbols in a contrasting color, a readability convention for revealed passwords. */
function ColoredPassword({ value, enabled }: { value: string; enabled: boolean }) {
  if (!enabled) return <>{value}</>;
  return (
    <>{[...value].map((c, i) => (
      <span key={i} className={/[0-9]/.test(c) ? 'pw-digit' : /[^A-Za-z]/.test(c) ? 'pw-symbol' : undefined}>{c}</span>
    ))}</>
  );
}

function TotpRow({ field, onCopy }: { field: Field; onCopy: CopyFn }) {
  const [code, setCode] = useState('');
  const [left, setLeft] = useState(totpSecondsRemaining());
  useEffect(() => {
    let alive = true;
    const tick = () => {
      setLeft(totpSecondsRemaining());
      totp(field.value).then((c) => alive && setCode(c)).catch(() => alive && setCode('invalid'));
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => { alive = false; clearInterval(t); };
  }, [field.value]);
  return (
    <div className="field-row">
      <div className="field-label-sm">{field.label || 'one-time password'}</div>
      <div className="field-value mono totp">
        {code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code}
        <svg className="totp-ring" viewBox="0 0 20 20" aria-label={`${left} seconds remaining`}>
          <circle cx="10" cy="10" r="8" fill="none" stroke="var(--border)" strokeWidth="3" />
          <circle cx="10" cy="10" r="8" fill="none" stroke={left <= 5 ? 'var(--danger)' : 'var(--accent)'} strokeWidth="3"
            strokeDasharray={`${(left / 30) * 50.3} 50.3`} transform="rotate(-90 10 10)" />
        </svg>
      </div>
      <button className="icon-btn" onClick={() => onCopy('one-time password', code)} aria-label="Copy one-time password"><Icon.copy size={16} /></button>
    </div>
  );
}

const KINDS: FieldKind[] = ['text', 'concealed', 'totp', 'email', 'url', 'phone', 'date'];
const KIND_LABEL: Record<FieldKind, string> = {
  text: 'Text', concealed: 'Password', totp: 'One-Time Password', email: 'Email', url: 'URL', phone: 'Phone', date: 'Date',
};

export function ItemEditor(props: { initial: Item; vaults: Vault[]; onSave: (i: Item) => void; onCancel: () => void }) {
  const isNew = !props.initial.id;
  const [item, setItem] = useState<Item>(() =>
    isNew && props.initial.fields.length === 0
      ? { ...props.initial, fields: CATEGORY_TEMPLATE[props.initial.category].map((f) => ({ ...f, id: randomId(), value: '' })) }
      : props.initial,
  );
  const [genFor, setGenFor] = useState<string | null>(null);
  const set = <K extends keyof Item>(k: K, v: Item[K]) => setItem((it) => ({ ...it, [k]: v }));
  const setField = (id: string, patch: Partial<Field>) =>
    set('fields', item.fields.map((f) => (f.id === id ? { ...f, ...patch } : f)));

  return (
    <form className="detail editor" onSubmit={(e) => { e.preventDefault(); props.onSave({ ...item, urls: item.urls.filter(Boolean) }); }}>
      <header className="detail-head">
        <CategoryIcon category={item.category} title={item.title} size={52} />
        <input className="title-input" placeholder={CATEGORY_LABEL[item.category]} value={item.title} autoFocus
          onChange={(e) => set('title', e.target.value)} aria-label="Title" required />
      </header>
      <label className="inline-label">Vault
        <select className="input" value={item.vaultId} onChange={(e) => set('vaultId', e.target.value)}>
          {props.vaults.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
      </label>

      <section className="field-group">
        {item.fields.map((f) => (
          <div className="edit-row" key={f.id}>
            <input className="label-input" value={f.label} onChange={(e) => setField(f.id, { label: e.target.value })} aria-label="Field label" />
            <div className="edit-value">
              <input className={`input ${f.kind === 'concealed' || f.kind === 'totp' ? 'mono' : ''}`} value={f.value}
                // reason: imported full dates (YYYY-MM-DD) render blank in a month input and would be wiped on save.
                type={f.kind === 'date' ? (!f.value || /^\d{4}-\d{2}$/.test(f.value) ? 'month' : 'date') : f.kind === 'email' ? 'email' : 'text'}
                placeholder={f.kind === 'totp' ? 'Base32 secret or otpauth:// URI' : ''}
                onChange={(e) => setField(f.id, { value: e.target.value })} aria-label={f.label} />
              {f.kind === 'concealed' && (
                <button type="button" className="icon-btn" onClick={() => setGenFor(genFor === f.id ? null : f.id)} aria-label="Generate password"><Icon.dice size={16} /></button>
              )}
              <button type="button" className="icon-btn" aria-label={`Remove ${f.label}`}
                onClick={() => set('fields', item.fields.filter((x) => x.id !== f.id))}><Icon.close size={16} /></button>
            </div>
            {f.kind === 'concealed' && f.value && f.label === 'password' && <StrengthMeter value={strength(f.value)} />}
            {genFor === f.id && <Generator onUse={(v) => { setField(f.id, { value: v }); setGenFor(null); }} />}
          </div>
        ))}
        <AddField onAdd={(kind) => set('fields', [...item.fields, { id: randomId(), kind, value: '', label: kind === 'totp' ? 'one-time password' : KIND_LABEL[kind].toLowerCase() }])} />
      </section>

      {(item.category === 'login' || item.category === 'password') && (
        <section className="field-group">
          {[...item.urls, ''].map((u, i) => (
            <div className="edit-row" key={i}>
              <span className="label-input static">website</span>
              <input className="input" placeholder="https://" value={u} aria-label="website"
                onChange={(e) => { const urls = [...item.urls]; urls[i] = e.target.value; set('urls', urls); }} />
            </div>
          ))}
        </section>
      )}

      <section className="field-group">
        <label className="edit-row">
          <span className="label-input static">notes</span>
          <textarea className="input" rows={4} value={item.notes} onChange={(e) => set('notes', e.target.value)} />
        </label>
        <label className="edit-row">
          <span className="label-input static">tags</span>
          <input className="input" placeholder="comma, separated" value={item.tags.join(', ')}
            onChange={(e) => set('tags', e.target.value.split(',').map((t) => t.trim()).filter(Boolean))} />
        </label>
      </section>

      <div className="row end">
        <button type="button" className="btn" onClick={props.onCancel}>Cancel</button>
        <button type="submit" className="btn primary">Save</button>
      </div>
    </form>
  );
}

function AddField({ onAdd }: { onAdd: (k: FieldKind) => void }) {
  return (
    <select className="add-field" value="" onChange={(e) => e.target.value && onAdd(e.target.value as FieldKind)} aria-label="Add field">
      <option value="">+ add more</option>
      {KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
    </select>
  );
}

export function Generator({ onUse, onCopy }: { onUse?: (v: string) => void; onCopy?: CopyFn }) {
  const [opts, setOpts] = useState<GeneratorOptions>(DEFAULT_GENERATOR);
  const [value, setValue] = useState(() => generatePassword(DEFAULT_GENERATOR));
  const update = (patch: Partial<GeneratorOptions>) => {
    const next = { ...opts, ...patch };
    if (patch.mode) next.length = patch.mode === 'memorable' ? 4 : patch.mode === 'pin' ? 6 : 20;
    setOpts(next);
    setValue(generatePassword(next));
  };
  const [min, max] = opts.mode === 'memorable' ? [3, 15] : opts.mode === 'pin' ? [4, 12] : [8, 100];
  return (
    <div className="generator">
      <div className="gen-value mono"><ColoredPassword value={value} enabled /></div>
      <StrengthMeter value={strength(value)} />
      <div className="seg" role="radiogroup" aria-label="Password type">
        {(['random', 'memorable', 'pin'] as const).map((m) => (
          <button type="button" key={m} role="radio" aria-checked={opts.mode === m} className={opts.mode === m ? 'on' : ''}
            onClick={() => update({ mode: m })}>{m === 'random' ? 'Random' : m === 'memorable' ? 'Memorable' : 'PIN'}</button>
        ))}
      </div>
      <label className="gen-row">
        <span>{opts.mode === 'memorable' ? 'Words' : 'Characters'}: {opts.length}</span>
        <input type="range" min={min} max={max} value={opts.length} onChange={(e) => update({ length: +e.target.value })} />
      </label>
      {opts.mode !== 'pin' && (
        <div className="gen-row toggles">
          <label className="check"><input type="checkbox" checked={opts.digits} onChange={(e) => update({ digits: e.target.checked })} />Numbers</label>
          {opts.mode === 'random' && (
            <label className="check"><input type="checkbox" checked={opts.symbols} onChange={(e) => update({ symbols: e.target.checked })} />Symbols</label>
          )}
          {opts.mode === 'memorable' && (
            <label className="check"><input type="checkbox" checked={opts.capitalize} onChange={(e) => update({ capitalize: e.target.checked })} />Capitalize</label>
          )}
        </div>
      )}
      <div className="row end">
        <button type="button" className="btn" onClick={() => setValue(generatePassword(opts))}><Icon.dice size={16} /> Regenerate</button>
        {onCopy && <button type="button" className="btn" onClick={() => onCopy('password', value)}><Icon.copy size={16} /> Copy</button>}
        {onUse && <button type="button" className="btn primary" onClick={() => onUse(value)}>Use password</button>}
      </div>
    </div>
  );
}
