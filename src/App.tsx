import { useCallback, useMemo, useState } from 'react';
import { AccountStore, type Session } from './store/account';
import { AuthScreen, EmergencyKit } from './components/Auth';
import { Unlocked } from './components/Unlocked';
import { cloudFromEnv } from './sync/cloud';
import type { ConnectResult } from './sync';

export default function App() {
  const store = useMemo(() => new AccountStore(window.localStorage), []);
  const cloud = useMemo(() => cloudFromEnv(), []);
  const [session, setSession] = useState<Session | null>(null);
  const [sync, setSync] = useState<Promise<ConnectResult> | null>(null);
  const [kit, setKit] = useState<{ secretKey: string; reprint: boolean } | null>(null);
  // reason: remount AuthScreen after lock/sign-out so it re-reads known devices.
  const [authKey, setAuthKey] = useState(0);

  // Locking drops every decrypted key and item from memory by discarding the Session.
  const lock = useCallback(() => { setSession(null); setKit(null); setSync(null); setAuthKey((k) => k + 1); }, []);
  const signOut = useCallback(() => {
    if (session) store.forgetDevice(session.accountId);
    void cloud?.signOut();
    lock();
  }, [session, store, cloud, lock]);

  if (!session) {
    return <AuthScreen key={authKey} store={store} cloud={cloud}
      onSession={(s, sk, connecting) => { setSession(s); setKit(sk ? { secretKey: sk, reprint: false } : null); setSync(connecting ?? null); }} />;
  }
  if (kit) return <EmergencyKit session={session} secretKey={kit.secretKey} reprint={kit.reprint} onDone={() => setKit(null)} />;
  // Only trusted devices keep the Secret Key; public/shared sign-ins have nothing to show.
  const deviceKey = store.knownDevices().find((d) => d.accountId === session.accountId)?.secretKey;
  return <Unlocked session={session} cloud={cloud} connecting={sync} onLock={lock} onSignOut={signOut}
    onShowKit={deviceKey ? () => setKit({ secretKey: deviceKey, reprint: true }) : undefined} />;
}
