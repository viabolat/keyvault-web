// Sign-in / sign-up screens. Layout follows the observed sign-in page structure
// (REA evidence ev_185b1373…063e): left brand rail, centered form card with a
// "public or shared computer" checkbox, an email-first step with Continue, footer
// links, and a right-hand guide panel. All copy, art and branding are original.
import { useState } from 'react';
import { AccountStore, Session } from '../store/account';
import { Logo } from './icons';
import { strength } from '../crypto/generator';
import type { CloudBackend } from '../sync/cloud';
import { signUpAnywhere, unlockAnywhere, type ConnectResult } from '../sync';

type Mode = 'email' | 'unlock' | 'signup';
export type OnSession = (s: Session, kit?: string, sync?: Promise<ConnectResult> | null) => void;

export function AuthScreen({ store, cloud, onSession }: { store: AccountStore; cloud: CloudBackend | null; onSession: OnSession }) {
  const devices = store.knownDevices();
  const [mode, setMode] = useState<Mode>(devices.length ? 'unlock' : 'email');
  const [email, setEmail] = useState(devices[0]?.email ?? '');
  const [publicComputer, setPublicComputer] = useState(false);
  const [error, setError] = useState('');

  const known = devices.find((d) => d.email === email.trim().toLowerCase());

  return (
    <div className="auth">
      <aside className="auth-rail">
        <div className="auth-rail-line" />
        <div className="auth-rail-badge"><Logo size={72} /></div>
      </aside>
      <main className="auth-main" aria-label="Sign In">
        <div className="auth-card-wrap">
          {mode === 'email' && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setError('');
                // With sync on, an unknown email means "new device": ask for the Secret Key and download.
                if (!store.findAccount(email) && !cloud) setError('No account with that email on this device. Create one below.');
                else setMode('unlock');
              }}
            >
              <h1>Sign in to Keyvault</h1>
              <div className="card">
                <h3>New to this device?</h3>
                <ol className="steps">
                  <li><span>1</span>Enter the email address for your account.</li>
                  <li><span>2</span>Have your Emergency Kit ready — you'll need your Secret Key.</li>
                  <li><span>3</span>Enter your account password to unlock.</li>
                </ol>
                <label className="check">
                  <input type="checkbox" checked={publicComputer} onChange={(e) => setPublicComputer(e.target.checked)} />
                  This is a public or shared computer
                </label>
              </div>
              <div className="or"><span>OR</span></div>
              <label className="field-label" htmlFor="email">Email</label>
              <input id="email" className="input" type="email" autoComplete="username" required value={email}
                onChange={(e) => setEmail(e.target.value)} />
              {error && <p className="error" role="alert">{error}</p>}
              <button className="btn primary" type="submit">Continue</button>
            </form>
          )}
          {mode === 'unlock' && (
            <UnlockForm store={store} cloud={cloud} email={email} known={!!known?.secretKey} publicComputer={publicComputer}
              onBack={() => { setMode('email'); setError(''); }} onSession={onSession} />
          )}
          {mode === 'signup' && <SignUpForm store={store} cloud={cloud} onBack={() => setMode('email')} onSession={onSession} />}
        </div>
        <footer className="auth-footer">
          <button className="link" onClick={() => setMode('signup')}>Create a new account</button>
          {devices.length > 0 && mode !== 'email' && (
            <button className="link" onClick={() => { setMode('email'); setEmail(''); }}>Use another account</button>
          )}
          <p>{cloud
            ? 'Keyvault — a zero-knowledge password manager. Only encrypted data is synced; your password and Secret Key never leave your devices.'
            : 'Keyvault — a local, zero-knowledge password manager. Your data never leaves this browser.'}</p>
        </footer>
      </main>
      <aside className="auth-guide">
        <p className="eyebrow">GUIDE</p>
        <h2>Why two secrets?</h2>
        <div className="guide-art" aria-hidden="true">
          <svg viewBox="0 0 320 150"><defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stopColor="#c7d2fe" /><stop offset="1" stopColor="#fbcfe8" /></linearGradient></defs>
            <rect width="320" height="150" rx="10" fill="url(#g)" />
            <rect x="60" y="45" width="80" height="60" rx="10" fill="#fff" opacity=".85" /><text x="100" y="82" textAnchor="middle" fontSize="13" fill="#334">password</text>
            <text x="160" y="82" textAnchor="middle" fontSize="22" fill="#334">+</text>
            <rect x="180" y="45" width="80" height="60" rx="10" fill="#fff" opacity=".85" /><text x="220" y="82" textAnchor="middle" fontSize="13" fill="#334">Secret Key</text>
          </svg>
        </div>
        <p>Your vault keys are derived from your account password <em>and</em> a 128-bit Secret Key that only lives on your devices and in your Emergency Kit. Someone who steals the encrypted data can't even begin guessing your password without it.</p>
      </aside>
    </div>
  );
}

function UnlockForm(props: {
  store: AccountStore; cloud: CloudBackend | null; email: string; known: boolean; publicComputer: boolean;
  onBack: () => void; onSession: OnSession;
}) {
  const [password, setPassword] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        try {
          const r = await unlockAnywhere(props.store, props.cloud, { email: props.email, password, secretKey, publicComputer: props.publicComputer });
          props.onSession(r.session, undefined, r.sync);
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <h1>{props.known ? 'Unlock Keyvault' : 'Sign in to Keyvault'}</h1>
      <div className="account-chip">
        <span className="avatar">{props.email[0]?.toUpperCase()}</span>
        <span>{props.email}</span>
        <button type="button" className="link" onClick={props.onBack}>Change</button>
      </div>
      {!props.known && (
        <>
          <label className="field-label" htmlFor="sk">Secret Key</label>
          <input id="sk" className="input mono" autoComplete="off" spellCheck={false} placeholder="K1-XXXXXX-XXXXXX-XXXXX-…"
            value={secretKey} onChange={(e) => setSecretKey(e.target.value)} required />
        </>
      )}
      <label className="field-label" htmlFor="pw">Password</label>
      <input id="pw" className="input" type="password" autoComplete="current-password" autoFocus value={password}
        onChange={(e) => setPassword(e.target.value)} required />
      {error && <p className="error" role="alert">{error}</p>}
      <button className="btn primary" type="submit" disabled={busy}>{busy ? 'Unlocking…' : props.known ? 'Unlock' : 'Sign in'}</button>
    </form>
  );
}

function SignUpForm(props: { store: AccountStore; cloud: CloudBackend | null; onBack: () => void; onSession: OnSession }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const s = strength(password);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (password !== confirm) return setError("Passwords don't match");
        setBusy(true);
        setError('');
        try {
          const { session, secretKey, sync } = await signUpAnywhere(props.store, props.cloud, { name, email, password });
          props.onSession(session, secretKey, sync && Promise.resolve(sync));
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <h1>Create your account</h1>
      <label className="field-label" htmlFor="name">Name</label>
      <input id="name" className="input" required value={name} onChange={(e) => setName(e.target.value)} />
      <label className="field-label" htmlFor="su-email">Email</label>
      <input id="su-email" className="input" type="email" autoComplete="username" required value={email}
        onChange={(e) => setEmail(e.target.value)} />
      <label className="field-label" htmlFor="su-pw">Account password</label>
      <input id="su-pw" className="input" type="password" autoComplete="new-password" required minLength={10}
        value={password} onChange={(e) => setPassword(e.target.value)} />
      {password && <StrengthMeter value={s} />}
      <label className="field-label" htmlFor="su-pw2">Confirm password</label>
      <input id="su-pw2" className="input" type="password" autoComplete="new-password" required value={confirm}
        onChange={(e) => setConfirm(e.target.value)} />
      {error && <p className="error" role="alert">{error}</p>}
      <div className="row">
        <button className="btn" type="button" onClick={props.onBack}>Back</button>
        <button className="btn primary" type="submit" disabled={busy}>{busy ? 'Generating keys…' : 'Create account'}</button>
      </div>
    </form>
  );
}

const LEVELS = ['terrible', 'weak', 'fair', 'good', 'excellent', 'fantastic'];
export function StrengthMeter({ value }: { value: string }) {
  const n = LEVELS.indexOf(value) + 1;
  return (
    <div className={`meter s${n}`} aria-label={`Strength: ${value}`}>
      <div className="meter-bar"><div style={{ width: `${(n / LEVELS.length) * 100}%` }} /></div>
      <span>{value[0].toUpperCase() + value.slice(1)}</span>
    </div>
  );
}

export function EmergencyKit({ session, secretKey, onDone }: { session: Session; secretKey: string; onDone: () => void }) {
  const [ack, setAck] = useState(false);
  const download = () => {
    const text = [
      'KEYVAULT EMERGENCY KIT',
      `Created: ${new Date().toISOString().slice(0, 10)}`,
      '',
      `Name:        ${session.name}`,
      `Email:       ${session.email}`,
      `Account ID:  ${session.accountId}`,
      `Secret Key:  ${secretKey}`,
      '',
      'Account password: ______________________________',
      '',
      'Keep this document somewhere safe. Your Secret Key and password are both',
      'required to decrypt your data. Nobody can recover them for you.',
    ].join('\n');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'Keyvault-Emergency-Kit.txt' });
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="kit-screen">
      <div className="kit">
        <Logo size={48} />
        <h1>Save your Emergency Kit</h1>
        <p>This is the only time your Secret Key is shown in full. You need it, together with your password, to sign in on any new device.</p>
        <dl>
          <dt>Email</dt><dd>{session.email}</dd>
          <dt>Secret Key</dt><dd className="mono secret-key">{secretKey}</dd>
        </dl>
        <div className="row">
          <button className="btn" onClick={() => navigator.clipboard.writeText(secretKey)}>Copy Secret Key</button>
          <button className="btn" onClick={download}>Download Emergency Kit</button>
        </div>
        <label className="check">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
          I've saved my Emergency Kit somewhere safe
        </label>
        <button className="btn primary" disabled={!ack} onClick={onDone}>Open my vault</button>
      </div>
    </div>
  );
}
