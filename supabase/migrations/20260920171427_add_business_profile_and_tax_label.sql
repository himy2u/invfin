-- A real invoice needs a "Bill From" (the merchant's own business name/address/tax registration
-- number) alongside the existing "Bill To" (clients.billing_address) — neither existed until now.
-- One row per user, not a general-purpose settings table, since that's all this holds today.

create table profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  business_name text,
  business_address text,
  tax_registration_number text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table profiles enable row level security;

create policy "profiles_select_own" on profiles
  for select using (auth.uid() = user_id);
create policy "profiles_insert_own" on profiles
  for insert with check (auth.uid() = user_id);
create policy "profiles_update_own" on profiles
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Tax needs a name (HST, GST, VAT, Sales Tax), not just a bare percentage — real invoices
-- (e.g. Canadian HST) always label what the tax actually is. Rate stays a plain percentage;
-- jurisdiction-based rate suggestion is explicitly deferred (see .claude/STATE.md) rather than
-- shipping a hardcoded, inevitably-stale tax-rate table.
alter table invoice_line_items
  add column tax_label text not null default 'Tax';
