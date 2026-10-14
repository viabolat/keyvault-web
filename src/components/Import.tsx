// Import panel: parse a 1Password .1pux / CSV export entirely in the browser,
// preview it, then encrypt the items into the unlocked account.
import { useState } from 'react';
import type { Session } from '../store/account';
import { CATEGORY_LABEL, type Category } from '../types';
import { applyImport, parseExport, type ImportResult } from '../import';

type Stage =
  | { kind: 'pick'; error?: string }
  | { kind: 'preview'; fileName: string; result: ImportResult }
  | { kind: 'running'; done: number; total: number }
  | { kind: 'done'; imported: number; duplicates: number; vaultsCreated: string[]; skipped: ImportResult['skipped'] };

export function ImportPanel({ session, onImported }: { session: Session; onImported: () => void }) {
  const [stage, setStage] = useState<Stage>({ kind: 'pick' });
  const [target, setTarget] = useState<string>('original');
  const [skipDuplicates, setSkipDuplicates] = useState(true);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const result = parseExport(new Uint8Array(await file.arrayBuffer()));
      if (!result.items.length) return setStage({ kind: 'pick', error: 'No items found in that file.' });
      setStage({ kind: 'preview', fileName: file.name, result });
    } catch (err) {
      setStage({ kind: 'pick', error: (err as Error).message });
    }
  };

  if (stage.kind === 'pick') {
    return (
      <div className="import">
        <p>Bring in items exported from 1Password (<strong>.1pux</strong> recommended, or <strong>.csv</strong>). Bitwarden and browser CSV exports also work.</p>
        <ol className="import-steps muted">
          <li>In the 1Password desktop app choose <em>File › Export</em> and pick your account.</li>
          <li>Select the <em>1PUX</em> format and save the file.</li>
          <li>Choose that file below. It's read on this device only — nothing is uploaded.</li>
        </ol>
        <label className="drop">
          <input type="file" accept=".1pux,.csv,application/zip,text/csv" onChange={(e) => onFile(e.target.files?.[0])} />
          <span>Choose export file…</span>
        </label>
        {stage.error && <p className="error" role="alert">{stage.error}</p>}
      </div>
    );
  }

  if (stage.kind === 'preview') {
    const { result } = stage;
    const byCat = new Map<Category, number>();
    for (const i of result.items) byCat.set(i.category, (byCat.get(i.category) ?? 0) + 1);
    const vaultNames = [...new Set(result.items.map((i) => i.vaultName))];
    return (
      <form
        className="import"
        onSubmit={async (e) => {
          e.preventDefault();
          setStage({ kind: 'running', done: 0, total: result.items.length });
          try {
            const r = await applyImport(session, result, { target, skipDuplicates }, (done, total) =>
              setStage({ kind: 'running', done, total }),
            );
            setStage({ kind: 'done', ...r, skipped: result.skipped });
          } catch (err) {
            setStage({ kind: 'pick', error: `Import failed: ${(err as Error).message}` });
          }
          onImported();
        }}
      >
        <p><strong>{result.items.length}</strong> items found in <span className="mono">{stage.fileName}</span></p>
        <ul className="import-counts">
          {[...byCat].map(([c, n]) => <li key={c}><span>{CATEGORY_LABEL[c]}</span><strong>{n}</strong></li>)}
        </ul>
        {result.skipped.length > 0 && (
          <details className="import-skipped">
            <summary>{result.skipped.length} thing(s) can't be imported</summary>
            <ul>{result.skipped.map((s, i) => <li key={i}>{s.title} — <span className="muted">{s.reason}</span></li>)}</ul>
          </details>
        )}
        <label className="field-label" htmlFor="imp-target">Import into</label>
        <select id="imp-target" className="input" value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="original">Original vaults ({vaultNames.join(', ')})</option>
          {session.vaults.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
        <label className="check import-check">
          <input type="checkbox" checked={skipDuplicates} onChange={(e) => setSkipDuplicates(e.target.checked)} />
          Skip items that already exist (same title, username and website)
        </label>
        <div className="row end">
          <button type="button" className="btn" onClick={() => setStage({ kind: 'pick' })}>Choose another file</button>
          <button type="submit" className="btn primary">Import {result.items.length} items</button>
        </div>
      </form>
    );
  }

  if (stage.kind === 'running') {
    return (
      <div className="import" aria-live="polite">
        <p>Encrypting items… {stage.done} / {stage.total}</p>
        <div className="meter-bar wide"><div style={{ width: `${(stage.done / Math.max(stage.total, 1)) * 100}%` }} /></div>
      </div>
    );
  }

  return (
    <div className="import" role="status">
      <p><strong>Imported {stage.imported} items.</strong></p>
      {stage.duplicates > 0 && <p className="muted">{stage.duplicates} duplicates skipped.</p>}
      {stage.vaultsCreated.length > 0 && <p className="muted">New vaults: {stage.vaultsCreated.join(', ')}</p>}
      {stage.skipped.length > 0 && <p className="muted">{stage.skipped.length} document(s)/attachment(s) were not imported.</p>}
      <p className="import-warn">Your export file contains every password in plain text. Delete it now (and empty your computer's trash/recycle bin).</p>
    </div>
  );
}
