// Sync server boundary. The server only ever receives: the email, a derived login secret
// (not the password, not the Secret Key), and the encrypted account blob.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { StoredAccount } from '../store/account';

export interface Remote {
  blob: StoredAccount;
  rev: number;
}

export type SignUpResult = 'ok' | 'confirm-email' | 'exists';
export type SignInResult = 'ok' | 'invalid' | 'confirm-email';

export interface CloudBackend {
  /** Email of the signed-in server user, if a session is cached on this device. */
  currentEmail(): Promise<string | null>;
  signIn(email: string, secret: string): Promise<SignInResult>;
  signUp(email: string, secret: string): Promise<SignUpResult>;
  signOut(): Promise<void>;
  fetch(): Promise<Remote | null>;
  /** Write if the server copy is still at expectedRev (null = no row yet). Returns the new rev, or null on conflict. */
  push(blob: StoredAccount, expectedRev: number | null): Promise<number | null>;
}

const TABLE = 'vault_accounts';

export class SupabaseBackend implements CloudBackend {
  private sb: SupabaseClient;

  constructor(url: string, anonKey: string) {
    this.sb = createClient(url, anonKey, { auth: { persistSession: true, autoRefreshToken: true } });
  }

  async currentEmail() {
    const { data } = await this.sb.auth.getSession();
    return data.session?.user.email?.toLowerCase() ?? null;
  }

  async signIn(email: string, secret: string): Promise<SignInResult> {
    const { error } = await this.sb.auth.signInWithPassword({ email, password: secret });
    if (!error) return 'ok';
    if (/not confirmed/i.test(error.message)) return 'confirm-email';
    if (error.status === 400) return 'invalid';
    throw new Error(`Sync sign-in failed: ${error.message}`);
  }

  async signUp(email: string, secret: string): Promise<SignUpResult> {
    const { data, error } = await this.sb.auth.signUp({ email, password: secret });
    if (error) {
      if (/already registered|already exists/i.test(error.message)) return 'exists';
      throw new Error(`Sync sign-up failed: ${error.message}`);
    }
    // reason: with "Confirm email" on, Supabase returns a user without a session (and, for an existing
    // email, an obfuscated user with no identities instead of an error).
    if (data.user && data.user.identities?.length === 0) return 'exists';
    return data.session ? 'ok' : 'confirm-email';
  }

  async signOut() {
    await this.sb.auth.signOut({ scope: 'local' });
  }

  async fetch(): Promise<Remote | null> {
    const { data, error } = await this.sb.from(TABLE).select('blob, rev').maybeSingle();
    if (error) throw new Error(`Sync download failed: ${error.message}`);
    return data ? { blob: data.blob as StoredAccount, rev: Number(data.rev) } : null;
  }

  async push(blob: StoredAccount, expectedRev: number | null) {
    if (expectedRev === null) {
      const { error } = await this.sb.from(TABLE).insert({ account_id: blob.accountId, blob });
      if (error?.code === '23505') return null; // another device inserted first
      if (error) throw new Error(`Sync upload failed: ${error.message}`);
      return 1;
    }
    const { data, error } = await this.sb
      .from(TABLE)
      .update({ blob, rev: expectedRev + 1, updated_at: new Date().toISOString() })
      .eq('rev', expectedRev)
      .select('rev');
    if (error) throw new Error(`Sync upload failed: ${error.message}`);
    return data.length ? expectedRev + 1 : null;
  }
}

export function cloudFromEnv(): CloudBackend | null {
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  return url && key ? new SupabaseBackend(url, key) : null;
}
