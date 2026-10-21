# LOGIC_GUIDE

Why the non-obvious decisions were made. Newest first.

## Face ID unlock (src/crypto/biometric.ts)
- **WebAuthn passkey + PRF extension, not a stored password.** The PRF output only exists after Face ID passes, so the
  account key wrapped with it is useless to someone who copies localStorage. Built into Safari: no service, no fee.
- **Wraps the account key, not the AUK.** Unlocking skips the password and Secret Key entirely; the record is per device
  and never synced (it lives outside `StoredAccount`).
- **Password required every 14 days**, and on every public/shared sign-in the record is deleted. This limits how long a
  stolen-but-unlocked phone stays one face away from the vault.
- **Sync after Face ID reuses the persisted Supabase session.** There is no password to derive the login secret. If that
  session is gone, sync pauses until the next password unlock, rather than failing the unlock.
- **A failed unwrap deletes the record**, because a passkey removed from iCloud Keychain gives different PRF bytes forever.
- **Trusted devices only**: the menu toggle is hidden when no Secret Key is stored on the device.

## Hosting (vercel.json, public/sw.js)
- **CSP has no 'unsafe-inline' and no third-party origins.** A password manager's biggest web risk is injected script;
  React's `style={}` uses the CSSOM, which CSP does not block, so `style-src 'self'` holds. The favicon moved from a
  `data:` URI to a file so `img-src` can stay `'self'`.
- **Supabase host is hard-coded in `connect-src`**, since an env-driven header would need a build step for vercel.json.
- **Service worker: network-first for the page, cache-first for hashed assets, never touches cross-origin requests.**
  A new deploy reaches users on their next online load, and sync traffic is never cached.
- **Env vars passed with `--build-env`** and `.env*` ignored, so nothing local is uploaded.

## Sync (src/sync, supabase/migrations)
- **One encrypted blob per account, not a row per item.** The server can't read items anyway, so per-row storage would
  only leak item counts and edit timing. One row also makes the revision check atomic.
- **Login secret = PBKDF2(password, salt from email) XOR HKDF(Secret Key)**, with no stored salt. A new device must be able
  to log in before it has downloaded anything. Different salts/info strings from the vault key mean the server can't use it
  to decrypt. Supabase sees the secret at login and stores only a bcrypt hash of it.
- **Merge without decrypting.** Newest `updatedAt` wins per item across all vaults (so moves don't duplicate), and per
  vault's attributes. Ties keep the local copy so repeated syncs are stable.
- **Tombstones** record permanent deletes. Without them the other device's copy would bring deleted items back. An edit
  made after the delete still wins, so concurrent work isn't lost.
- **Optimistic concurrency via `rev`.** Update `where rev = expected`; zero rows updated means another device wrote first,
  so re-fetch, merge and retry (max 3).
- **Comparison uses canonical JSON**, because jsonb reorders keys; a plain string compare would upload on every sync.
- **`Session.adopt` re-merges after its awaits**, so a local save made during key unwrapping isn't overwritten.
- **Sign-up deletes the local account if the server rejects it**, otherwise the email would be stuck on this device.
  Network failures keep the account and register it on a later unlock.
- **Unknown email + sync enabled goes to the new-device form** instead of "no account on this device".

## Importer (src/import)
- **Detect the format from the bytes, not the extension.** A zip starts with `PK`; anything else is parsed as CSV.
  Renamed or downloaded files often have the wrong extension.
- **unzip only `export.data`.** A .1pux can contain large attachments in `files/`. Filtering stops them from being
  decompressed into memory.
- **Unmapped 1Password types become secure_note plus a type tag**, rather than being dropped. Losing data on import is
  worse than a less specific category, and the tag makes these items easy to find and re-categorize.
- **Archived items are tagged, not trashed.** Keyvault has no archive, and Empty Trash deletes permanently.
- **Field ids map to Keyvault labels** (ccnum→number, firstname→first name, …), because list subtitles and Watchtower
  look fields up by label.
- **`Session.saveItems` persists once.** Calling `saveItem` per item re-serializes the whole account each time, which
  is O(n²) on a 1,000-item import.
- **Duplicate key = title + username + URL host**, compared case-insensitively. It is strict enough to keep items that
  differ only by account, and it makes re-running an import idempotent.
- **Date fields choose a month or date input from the value.** `monthYear` imports as YYYY-MM and `date` as
  YYYY-MM-DD. A month input shows a full date as blank and would wipe it on save.

## Crypto / storage
- **Two-secret key derivation** (password via PBKDF2 650k, XOR with an HKDF of the Secret Key). Stolen ciphertext
  cannot be brute-forced on the password alone.
- **Wrong password and wrong Secret Key return the same error**, so the error does not reveal which one was wrong.
- **Sign-up trusts the current device** (stores the Secret Key locally); "public or shared computer" opts out.
