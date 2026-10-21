import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AccountStore, Session } from '../store/account';
import { biometricAvailable, biometricLabel, enableBiometric } from '../crypto/biometric';
import { CATEGORY_LABEL, itemSubtitle, primaryPassword, type Category, type Item, type Vault } from '../types';
import { CategoryGlyph, CategoryIcon, Icon, Logo } from './icons';
import { Generator, ItemDetail, ItemEditor } from './Item';
import { strength } from '../crypto/generator';
import { ImportPanel } from './Import';
import type { CloudBackend } from '../sync/cloud';
import { SyncEngine, type ConnectResult, type SyncStatus } from '../sync';

type Filter =
  | { kind: 'all' } | { kind: 'favorites' } | { kind: 'trash' } | { kind: 'watchtower' }
  | { kind: 'vault'; id: string } | { kind: 'category'; id: Category } | { kind: 'tag'; id: string };

const AUTO_LOCK_MS = 10 * 60 * 1000;
const CLIPBOARD_CLEAR_MS = 90 * 1000;
const VAULT_COLORS = ['#1a8cff', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#64748b'];

export function Unlocked({ session, cloud, connecting, onLock, onSignOut, onShowKit, biometricStore }: {
  session: Session; cloud: CloudBackend | null; connecting: Promise<ConnectResult> | null; onLock: () => void; onSignOut: () => void;
  onShowKit?: () => void; biometricStore?: AccountStore;
}) {
  const [, rerender] = useState(0);
  const refresh = () => rerender((n) => n + 1);
  const [filter, setFilter] = useState<Filter>({ kind: 'all' });
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Item | null>(null);
  const [toast, setToast] = useState('');
  const [modal, setModal] = useState<null | 'new-item' | 'generator' | 'import' | { vault: Vault | null }>(null);
  const [navOpen, setNavOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useAutoLock(onLock);
  const syncStatus = useSync(session, cloud, connecting, refresh);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement).closest('input, textarea, select');
      if (e.key === '/' && !typing) { e.preventDefault(); searchRef.current?.focus(); }
      if (e.key.toLowerCase() === 'l' && e.shiftKey && (e.ctrlKey || e.metaKey)) { e.preventDefault(); onLock(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onLock]);

  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((t) => (t === msg ? '' : t)), 2500);
  };

  const copy = useCallback((label: string, value: string) => {
    navigator.clipboard.writeText(value).then(() => {
      setToast(`Copied ${label}`);
      // Clear the clipboard later only if it still holds what we put there.
      setTimeout(async () => {
        try { if ((await navigator.clipboard.readText()) === value) await navigator.clipboard.writeText(''); } catch { /* permission denied: leave it */ }
      }, CLIPBOARD_CLEAR_MS);
    });
  }, []);

  const items = session.items;
  const tags = useMemo(() => [...new Set(items.filter((i) => !i.trashed).flatMap((i) => i.tags))].sort(), [items]);
  const report = useMemo(() => watchtower(items.filter((i) => !i.trashed)), [items]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items
      .filter((i) => (filter.kind === 'trash' ? i.trashed : !i.trashed))
      .filter((i) => {
        switch (filter.kind) {
          case 'favorites': return i.favorite;
          case 'vault': return i.vaultId === filter.id;
          case 'category': return i.category === filter.id;
          case 'tag': return i.tags.includes(filter.id);
          default: return true;
        }
      })
      .filter((i) => !q || [i.title, itemSubtitle(i), ...i.urls, ...i.tags].some((s) => s.toLowerCase().includes(q)))
      .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
  }, [items, filter, query]);

  const selected = items.find((i) => i.id === selectedId);
  const vaultOf = (id: string) => session.vaults.find((v) => v.id === id);

  const save = async (item: Item) => {
    const saved = await session.saveItem(item);
    setEditing(null);
    setSelectedId(saved.id);
    refresh();
    flash('Saved');
  };

  const startNew = (category: Category) => {
    const vaultId = filter.kind === 'vault' ? filter.id : session.vaults[0].id;
    setModal(null);
    setSelectedId(null);
    setEditing(session.blankItem(category, vaultId));
  };

  const title =
    filter.kind === 'all' ? 'All Items' : filter.kind === 'favorites' ? 'Favorites' : filter.kind === 'trash' ? 'Trash'
    : filter.kind === 'watchtower' ? 'Watchtower' : filter.kind === 'vault' ? vaultOf(filter.id)?.name ?? ''
    : filter.kind === 'category' ? CATEGORY_LABEL[filter.id] + 's' : '#' + filter.id;

  const nav = (f: Filter) => { setFilter(f); setSelectedId(null); setEditing(null); setNavOpen(false); };
  const isActive = (f: Filter) => JSON.stringify(f) === JSON.stringify(filter);
  const counts = (pred: (i: Item) => boolean) => items.filter((i) => !i.trashed && pred(i)).length;

  return (
    <div className={`app ${selected || editing ? 'has-detail' : ''}`}>
      <header className="topbar">
        <button className="icon-btn mobile-only" onClick={() => setNavOpen(!navOpen)} aria-label="Menu"><Icon.menu /></button>
        <div className="brand"><Logo size={28} /><span>Keyvault</span></div>
        <div className="search">
          <Icon.search size={16} />
          <input ref={searchRef} placeholder={filter.kind === 'watchtower' ? 'Search all items' : `Search in ${title}`} value={query} onChange={(e) => { setQuery(e.target.value); if (filter.kind === 'watchtower') setFilter({ kind: 'all' }); }} aria-label="Search" />
          <kbd>/</kbd>
        </div>
        <button className="btn" onClick={() => setModal('generator')}><Icon.dice size={16} /><span className="hide-sm"> Generate</span></button>
        <SyncBadge status={syncStatus} />
        <AccountMenu session={session} onLock={onLock} onSignOut={onSignOut} onImport={() => setModal('import')} onShowKit={onShowKit} biometricStore={biometricStore} />
      </header>

      <nav className={`sidebar ${navOpen ? 'open' : ''}`} aria-label="Vaults and categories">
        <button className="btn primary new-item" onClick={() => setModal('new-item')}><Icon.plus size={16} /> New Item</button>
        <NavRow active={isActive({ kind: 'all' })} onClick={() => nav({ kind: 'all' })} icon={<Icon.grid />} label="All Items" count={counts(() => true)} />
        <NavRow active={isActive({ kind: 'favorites' })} onClick={() => nav({ kind: 'favorites' })} icon={<Icon.star />} label="Favorites" count={counts((i) => i.favorite)} />
        <NavRow active={isActive({ kind: 'watchtower' })} onClick={() => nav({ kind: 'watchtower' })} icon={<Icon.shield />} label="Watchtower"
          count={report.weak.length + report.reused.length || undefined} alert={report.weak.length + report.reused.length > 0} />

        <div className="nav-heading">Vaults <button className="icon-btn sm" onClick={() => setModal({ vault: null })} aria-label="New vault"><Icon.plus size={14} /></button></div>
        {session.vaults.map((v) => (
          <NavRow key={v.id} active={isActive({ kind: 'vault', id: v.id })} onClick={() => nav({ kind: 'vault', id: v.id })}
            icon={<span className="vault-dot" style={{ background: v.color }}><Icon.vault size={14} /></span>} label={v.name}
            count={counts((i) => i.vaultId === v.id)} onEdit={() => setModal({ vault: v })} />
        ))}

        <div className="nav-heading">Categories</div>
        {(Object.keys(CATEGORY_LABEL) as Category[]).filter((c) => counts((i) => i.category === c) > 0).map((c) => (
          <NavRow key={c} active={isActive({ kind: 'category', id: c })} onClick={() => nav({ kind: 'category', id: c })}
            icon={<CategoryGlyph category={c} />} label={CATEGORY_LABEL[c] + 's'} count={counts((i) => i.category === c)} />
        ))}

        {tags.length > 0 && <div className="nav-heading">Tags</div>}
        {tags.map((t) => (
          <NavRow key={t} active={isActive({ kind: 'tag', id: t })} onClick={() => nav({ kind: 'tag', id: t })} icon={<Icon.tag />} label={t}
            count={counts((i) => i.tags.includes(t))} />
        ))}

        <div className="nav-spacer" />
        <NavRow active={isActive({ kind: 'trash' })} onClick={() => nav({ kind: 'trash' })} icon={<Icon.trash />} label="Trash"
          count={items.filter((i) => i.trashed).length || undefined} />
      </nav>
      {navOpen && <div className="scrim" onClick={() => setNavOpen(false)} />}

      {filter.kind === 'watchtower' ? (
        <Watchtower report={report} onOpen={(id) => { setFilter({ kind: 'all' }); setSelectedId(id); }} />
      ) : (
        <section className="list" aria-label={title}>
          <div className="list-head">
            <h1>{title}</h1>
            <span className="muted">{visible.length} {visible.length === 1 ? 'item' : 'items'}</span>
            {filter.kind === 'trash' && visible.length > 0 && (
              <button className="btn sm danger" onClick={() => { if (confirm('Permanently delete all items in Trash?')) { session.emptyTrash(); refresh(); } }}>Empty Trash</button>
            )}
          </div>
          {visible.length === 0 ? (
            <div className="empty">
              <Icon.vault size={40} />
              <p>{query ? `No items match “${query}”` : filter.kind === 'trash' ? 'Trash is empty' : 'No items here yet'}</p>
              {!query && filter.kind !== 'trash' && <button className="btn primary" onClick={() => setModal('new-item')}>New Item</button>}
            </div>
          ) : (
            <ul role="listbox" aria-label="Items">
              {visible.map((i) => (
                <li key={i.id} role="option" aria-selected={i.id === selectedId} className={i.id === selectedId ? 'selected' : ''}
                  tabIndex={0} onClick={() => { setSelectedId(i.id); setEditing(null); }}
                  onKeyDown={(e) => e.key === 'Enter' && setSelectedId(i.id)}>
                  <CategoryIcon category={i.category} title={i.title} />
                  <div className="row-text">
                    <span className="row-title">{i.title || 'Untitled'}{i.favorite && <Icon.star size={12} filled />}</span>
                    <span className="muted">{itemSubtitle(i)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {filter.kind !== 'watchtower' && (
        <section className="pane">
          {editing ? (
            <ItemEditor key={editing.id || 'new'} initial={editing} vaults={session.vaults} onSave={save} onCancel={() => setEditing(null)} />
          ) : selected ? (
            <ItemDetail item={selected} vault={vaultOf(selected.vaultId)} onCopy={copy} onBack={() => setSelectedId(null)}
              onEdit={() => setEditing(selected)}
              onToggleFavorite={async () => { await session.saveItem({ ...selected, favorite: !selected.favorite }); refresh(); }}
              onTrash={async () => { await session.saveItem({ ...selected, trashed: true }); setSelectedId(null); refresh(); flash('Moved to Trash'); }}
              onRestore={async () => { await session.saveItem({ ...selected, trashed: false }); refresh(); flash('Restored'); }}
              onDeleteForever={() => { if (confirm(`Permanently delete “${selected.title}”?`)) { session.deleteItemForever(selected.id); setSelectedId(null); refresh(); } }} />
          ) : (
            <div className="empty pane-empty"><Logo size={56} /><p className="muted">Select an item to view its details</p></div>
          )}
        </section>
      )}

      {modal === 'new-item' && (
        <Modal title="What would you like to add?" onClose={() => setModal(null)}>
          <div className="cat-grid">
            {(Object.keys(CATEGORY_LABEL) as Category[]).map((c) => (
              <button key={c} className="cat-tile" onClick={() => startNew(c)}><CategoryIcon category={c} size={40} /><span>{CATEGORY_LABEL[c]}</span></button>
            ))}
          </div>
        </Modal>
      )}
      {modal === 'generator' && (
        <Modal title="Password Generator" onClose={() => setModal(null)}><Generator onCopy={copy} /></Modal>
      )}
      {modal === 'import' && (
        <Modal title="Import items" onClose={() => setModal(null)}><ImportPanel session={session} onImported={refresh} /></Modal>
      )}
      {modal && typeof modal === 'object' && (
        <VaultModal vault={modal.vault} canDelete={session.vaults.length > 1} onClose={() => setModal(null)}
          onSave={async (v) => {
            if (v.id) await session.updateVault(v);
            else { const created = await session.createVault(v); nav({ kind: 'vault', id: created.id }); }
            setModal(null); refresh();
          }}
          onDelete={(v) => {
            const n = counts((i) => i.vaultId === v.id);
            if (confirm(`Delete vault “${v.name}”${n ? ` and its ${n} items` : ''}? This can't be undone.`)) {
              session.deleteVault(v.id); setModal(null); nav({ kind: 'all' });
            }
          }} />
      )}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

function NavRow(p: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string; count?: number; alert?: boolean; onEdit?: () => void }) {
  return (
    <div className={`nav-row ${p.active ? 'active' : ''}`}>
      <button className="nav-main" onClick={p.onClick} aria-current={p.active ? 'page' : undefined}>
        {p.icon}<span className="nav-label">{p.label}</span>
        {p.count !== undefined && <span className={`count ${p.alert ? 'alert' : ''}`}>{p.count}</span>}
      </button>
      {p.onEdit && <button className="icon-btn sm nav-edit" onClick={p.onEdit} aria-label={`Edit ${p.label}`}><Icon.edit size={13} /></button>}
    </div>
  );
}

function AccountMenu({ session, onLock, onSignOut, onImport, onShowKit, biometricStore }: {
  session: Session; onLock: () => void; onSignOut: () => void; onImport: () => void; onShowKit?: () => void;
  biometricStore?: AccountStore;
}) {
  const [open, setOpen] = useState(false);
  const bio = useBiometricToggle(session, biometricStore);
  return (
    <div className="account-menu">
      <button className="avatar-btn" onClick={() => setOpen(!open)} aria-expanded={open} aria-label="Account">
        <span className="avatar">{session.name[0]?.toUpperCase()}</span>
      </button>
      {open && (
        <div className="menu" role="menu" onMouseLeave={() => setOpen(false)}>
          <div className="menu-id"><strong>{session.name}</strong><span className="muted">{session.email}</span></div>
          <button role="menuitem" onClick={onLock}><Icon.lock size={16} /> Lock <kbd>Ctrl ⇧ L</kbd></button>
          {onShowKit && <button role="menuitem" onClick={() => { setOpen(false); onShowKit(); }}>Emergency Kit…</button>}
          {bio.available && (
            <button role="menuitem" onClick={bio.toggle} disabled={bio.busy}>
              {bio.enabled ? `Turn off ${bio.label}` : `Turn on ${bio.label}…`}
            </button>
          )}
          {bio.error && <p className="error menu-note" role="alert">{bio.error}</p>}
          <button role="menuitem" onClick={() => { setOpen(false); onImport(); }}>Import from 1Password…</button>
          <button role="menuitem" onClick={onSignOut}>Sign out of this device</button>
        </div>
      )}
    </div>
  );
}

/** Only offered on trusted devices (biometricStore is undefined on public/shared sign-ins). */
function useBiometricToggle(session: Session, store?: AccountStore) {
  const [available, setAvailable] = useState(false);
  const [enabled, setEnabled] = useState(() => !!store?.biometric(session.accountId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (store) void biometricAvailable().then(setAvailable);
  }, [store]);
  const toggle = async () => {
    if (!store) return;
    setError('');
    if (enabled) {
      store.removeBiometric(session.accountId);
      return setEnabled(false);
    }
    setBusy(true);
    try {
      await enableBiometric(store, session);
      setEnabled(true);
    } catch (err) {
      if ((err as Error).name !== 'NotAllowedError') setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { available, enabled, busy, error, toggle, label: biometricLabel() };
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <header><h2>{title}</h2><button className="icon-btn" onClick={onClose} aria-label="Close"><Icon.close /></button></header>
        {children}
      </div>
    </div>
  );
}

function VaultModal(p: { vault: Vault | null; canDelete: boolean; onClose: () => void; onSave: (v: Vault) => void; onDelete: (v: Vault) => void }) {
  const [v, setV] = useState<Vault>(p.vault ?? { id: '', name: '', description: '', color: VAULT_COLORS[1] });
  return (
    <Modal title={p.vault ? 'Edit vault' : 'New vault'} onClose={p.onClose}>
      <form onSubmit={(e) => { e.preventDefault(); p.onSave(v); }}>
        <label className="field-label" htmlFor="vn">Name</label>
        <input id="vn" className="input" required autoFocus value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />
        <label className="field-label" htmlFor="vd">Description</label>
        <input id="vd" className="input" value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} />
        <div className="field-label">Color</div>
        <div className="swatches">
          {VAULT_COLORS.map((c) => (
            <button type="button" key={c} className={`swatch ${v.color === c ? 'on' : ''}`} style={{ background: c }}
              onClick={() => setV({ ...v, color: c })} aria-label={`Color ${c}`} />
          ))}
        </div>
        <div className="row end">
          {p.vault && p.canDelete && <button type="button" className="btn danger" onClick={() => p.onDelete(v)}>Delete vault</button>}
          <button type="submit" className="btn primary">{p.vault ? 'Save' : 'Create vault'}</button>
        </div>
      </form>
    </Modal>
  );
}

interface Report { weak: Item[]; reused: Item[][]; noTotp: Item[] }

function watchtower(items: Item[]): Report {
  const logins = items.filter((i) => primaryPassword(i));
  const weak = logins.filter((i) => ['terrible', 'weak', 'fair'].includes(strength(primaryPassword(i)!)));
  const groups = new Map<string, Item[]>();
  for (const i of logins) groups.set(primaryPassword(i)!, [...(groups.get(primaryPassword(i)!) ?? []), i]);
  const reused = [...groups.values()].filter((g) => g.length > 1);
  const noTotp = items.filter((i) => i.category === 'login' && i.urls.length && !i.fields.some((f) => f.kind === 'totp'));
  return { weak, reused, noTotp };
}

function Watchtower({ report, onOpen }: { report: Report; onOpen: (id: string) => void }) {
  const score = Math.max(0, 100 - report.weak.length * 15 - report.reused.flat().length * 10 - report.noTotp.length * 2);
  const Row = ({ i }: { i: Item }) => (
    <li tabIndex={0} onClick={() => onOpen(i.id)} onKeyDown={(e) => e.key === 'Enter' && onOpen(i.id)}>
      <CategoryIcon category={i.category} title={i.title} size={28} />
      <div className="row-text"><span className="row-title">{i.title}</span><span className="muted">{itemSubtitle(i)}</span></div>
    </li>
  );
  return (
    <section className="watchtower" aria-label="Watchtower">
      <div className="wt-score">
        <div className="wt-ring" style={{ ['--p' as string]: score }}><strong>{score}</strong><span>/100</span></div>
        <div><h1>Watchtower</h1><p className="muted">Security checks run locally on your decrypted items. Nothing is sent anywhere.</p></div>
      </div>
      <div className="wt-cards">
        <div className="wt-card"><h3><span className="badge danger">{report.weak.length}</span> Weak passwords</h3>
          {report.weak.length ? <ul>{report.weak.map((i) => <Row key={i.id} i={i} />)}</ul> : <p className="muted">None. Nice.</p>}</div>
        <div className="wt-card"><h3><span className="badge warn">{report.reused.flat().length}</span> Reused passwords</h3>
          {report.reused.length ? report.reused.map((g, n) => <ul key={n} className="group">{g.map((i) => <Row key={i.id} i={i} />)}</ul>) : <p className="muted">Every password is unique.</p>}</div>
        <div className="wt-card"><h3><span className="badge info">{report.noTotp.length}</span> No two-factor code stored</h3>
          {report.noTotp.length ? <ul>{report.noTotp.map((i) => <Row key={i.id} i={i} />)}</ul> : <p className="muted">All logins have one-time passwords.</p>}</div>
      </div>
    </section>
  );
}

function useSync(session: Session, cloud: CloudBackend | null, connecting: Promise<ConnectResult> | null, onRemote: () => void): SyncStatus {
  const [status, setStatus] = useState<SyncStatus>(cloud && connecting ? { state: 'connecting' } : { state: 'off' });
  const remoteRef = useRef(onRemote);
  remoteRef.current = onRemote;
  useEffect(() => {
    if (!cloud || !connecting) return;
    let engine: SyncEngine | null = null;
    let cancelled = false;
    connecting.then(
      (r) => {
        if (cancelled) return;
        if (r === 'ok') {
          engine = new SyncEngine(session, cloud, setStatus, () => remoteRef.current());
          void engine.start();
        } else if (r === 'confirm-email') setStatus({ state: 'confirm-email' });
        else if (r === 'offline') setStatus({ state: 'offline' });
        else setStatus({ state: 'error', message: 'This email is registered for sync with a different password or Secret Key' });
      },
      (err: Error) => !cancelled && setStatus({ state: 'error', message: err.message }),
    );
    return () => {
      cancelled = true;
      engine?.stop();
    };
  }, [session, cloud, connecting]);
  return status;
}

const SYNC_LABEL: Record<SyncStatus['state'], string> = {
  off: 'Local only',
  connecting: 'Connecting…',
  syncing: 'Syncing…',
  synced: 'Synced',
  offline: 'Offline',
  'confirm-email': 'Confirm email to sync',
  error: 'Sync error',
};

function SyncBadge({ status }: { status: SyncStatus }) {
  if (status.state === 'off') return null;
  const detail =
    status.state === 'synced' ? `Last synced ${new Date(status.at).toLocaleTimeString()}`
    : status.state === 'error' ? status.message
    : status.state === 'confirm-email' ? 'Open the confirmation link sent to your email, then lock and unlock to start syncing.'
    : status.state === 'offline' ? 'Changes are saved on this device and will sync when you reconnect.'
    : SYNC_LABEL[status.state];
  return (
    <span className={`sync-badge ${status.state}`} title={detail} role="status" aria-label={`${SYNC_LABEL[status.state]}. ${detail}`}>
      <span className="sync-dot" /><span className="hide-sm">{SYNC_LABEL[status.state]}</span>
    </span>
  );
}

function useAutoLock(onLock: () => void) {
  useEffect(() => {
    let t = setTimeout(onLock, AUTO_LOCK_MS);
    const reset = () => { clearTimeout(t); t = setTimeout(onLock, AUTO_LOCK_MS); };
    const events = ['mousemove', 'keydown', 'pointerdown', 'scroll'];
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    return () => { clearTimeout(t); events.forEach((e) => window.removeEventListener(e, reset)); };
  }, [onLock]);
}
