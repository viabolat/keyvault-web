# Keyvault — clean-room rebuild of a zero-knowledge web password manager

Functional rebuild of the 1Password web app's core experience, written from scratch.
No 1Password code, logos, art or copy is used; branding is "Keyvault".

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # crypto, store, TOTP (RFC 6238 vectors), generator
npm run build
```

## What REA observed (evidence)

| Evidence | Observation |
|---|---|
| `ev_185b1373…063e` (capture_browser_scenario, `my.1password.com/signin`, logged out) | Three-column sign-in: brand rail with a badge, a centered form, and a guide panel on the right. Email-first form with a **Continue** button, a QR sign-in card, a **"This is a public or shared computer"** checkbox, and footer links. Light grey canvas, Inter font, blue primary button. |
| same | Static bundle split into `runtime`, `vendor-react`, `vendor-connectrpc`, `webapi`, `app`, and a lazily loaded `unlocked` chunk; a `b5_mycelium` WASM module plus `/api/v2/mycelium/u` calls back the QR sign-in channel. |

**Not observed:** the unlocked vault UI and the real API traffic both need an authenticated account, and none was used.
The vault layout (sidebar | list | detail), Watchtower, and Secret Key model come from public product behavior and
the publicly documented security design. They are not taken from captured code.

## Design decisions (not observations)

- **Key hierarchy:** the Account Unlock Key is PBKDF2-SHA256 (650k iterations) over the password, XORed with HKDF over the Secret Key.
  It wraps a random account key, which wraps one AES-256-GCM key per vault. Each item is encrypted as two parts: an overview and details.
- **Storage:** `localStorage` holds only ciphertext plus the email, salt, IDs and timestamps. Locking discards every decrypted key and item.
- **Trusted device:** after the first sign-in the Secret Key is remembered, so unlocking needs only the password. Ticking
  "public or shared computer" skips remembering it.
- **Not built:** QR sign-in, sharing, team accounts, server sync, and passkeys. Server sync is the natural next step: push the stored
  ciphertext as-is, for example to Supabase.

## Features

Sign-up with an Emergency Kit (download or copy), sign-in and unlock, multiple vaults (create, rename, recolor, delete),
six item categories, custom fields, TOTP with a countdown, a password generator (random, memorable, PIN), password history,
favorites, tags, search (`/`), trash, Watchtower (weak passwords, reused passwords, missing 2FA), auto-lock after 10 minutes
(or Ctrl+Shift+L), clipboard auto-clear after 90 seconds, dark mode, and a mobile layout.

## Importing from 1Password

Account menu → **Import from 1Password…**. The file is parsed in the browser and never uploaded.

- **.1pux** (recommended; desktop app → File › Export → 1PUX). Keeps vaults, favorites, tags, notes, TOTP, password
  history, and created/edited dates. Login, Password, Credit Card, Identity, Secure Note and API Credential map directly.
  Other types (Bank Account, Passport, SSH Key, …) become Secure Notes with every field kept and a tag naming the original type.
  Archived items get an `archived` tag. Documents and file attachments are not imported, and the preview lists them.
- **.csv**. Columns are matched by header name, so 1Password, Bitwarden and browser CSV exports all work.
- Duplicates are skipped by default when title, username and website host all match an existing item.

The parser follows the published 1PUX format and is tested against hand-built fixtures, not a real 1Password export.
If an export from your account fails or looks wrong, that file is the next test case.

## Sync across devices (optional)

With `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` set (see `.env.example`), each account keeps one encrypted copy in
Supabase (`supabase/migrations/`, RLS: users can read and write only their own row). Without them the app is local-only.

- The server receives the email, a login secret derived from password + Secret Key (separate derivation from the vault
  keys), and ciphertext. It never receives the password, the Secret Key, or anything decrypted.
- New device: enter email → Secret Key + password → the encrypted account downloads and unlocks locally.
- Offline-first: edits save locally and sync after ~1.5 s, every 30 s, and on focus/reconnect. The newest edit wins per
  item; permanent deletes win over older copies; a conflicting upload from another device is re-merged and retried.
- Accounts created before sync was enabled are registered on their next unlock.

## Deploy (Vercel)

Pushing to `main` on GitHub (`viabolat/keyvault-web`) deploys to production automatically; other branches get preview
URLs. `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are set in the Vercel project. Manual deploy from this machine:

```bash
set -a; . ./.env.local; set +a
npx vercel deploy --prod --yes --build-env VITE_SUPABASE_URL="$VITE_SUPABASE_URL" --build-env VITE_SUPABASE_ANON_KEY="$VITE_SUPABASE_ANON_KEY"
```

`vercel.json` sets a strict CSP (scripts only from this site, network only to this site and the Supabase project) and the
other security headers. If the Supabase project changes, update `connect-src` there too. The app is installable
(manifest + `public/sw.js`) and opens offline. `.vercelignore` keeps `.env*` and tests out of the upload.
