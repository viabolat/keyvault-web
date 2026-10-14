-- One encrypted Keyvault account per auth user. The blob is client-side ciphertext
-- (keys derived from the user's password + Secret Key never reach the server).
create table public.vault_accounts (
  user_id     uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  account_id  text not null unique,
  blob        jsonb not null,
  rev         bigint not null default 1,
  updated_at  timestamptz not null default now(),
  constraint blob_size check (pg_column_size(blob) < 20 * 1024 * 1024)
);

alter table public.vault_accounts enable row level security;

-- Each user can see and write only their own row.
create policy "own row: select" on public.vault_accounts
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "own row: insert" on public.vault_accounts
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "own row: update" on public.vault_accounts
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own row: delete" on public.vault_accounts
  for delete to authenticated using ((select auth.uid()) = user_id);

-- Anonymous visitors get nothing.
revoke all on public.vault_accounts from anon;
grant select, insert, update, delete on public.vault_accounts to authenticated;
