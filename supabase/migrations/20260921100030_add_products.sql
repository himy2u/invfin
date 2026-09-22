-- Products/Services catalog (Wave's "Add product or service"): reusable line items with a default
-- price/description/tax so a business doesn't retype the same line every invoice.

create table products (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  description text,
  default_price_cents bigint not null default 0,
  default_tax_rate_percent numeric not null default 0,
  default_tax_label text not null default 'Tax',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index products_user_id_idx on products (user_id);

alter table products enable row level security;

create policy "products_select_own" on products
  for select using (auth.uid() = user_id);
create policy "products_insert_own" on products
  for insert with check (auth.uid() = user_id);
create policy "products_update_own" on products
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "products_delete_own" on products
  for delete using (auth.uid() = user_id);
