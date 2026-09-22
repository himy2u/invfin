-- Phase 1 schema: clients, invoices, line items.
-- Tenancy: single-owner-per-account (user_id references auth.users). The PRD targets SMB/startup
-- buyers but does not describe multi-seat team accounts for v1, so we keep one owner per row
-- rather than introducing an organizations table pre-emptively.
--
-- invoice_status distinguishes void from delete (Xero's named complaint, see
-- .claude/prd/invoicing-wedge-prd.md): invoices are never hard-deleted, only voided.

create type invoice_status as enum (
  'draft',
  'sent',
  'partially_paid',
  'paid',
  'void'
);

create table clients (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  email text,
  phone text,
  billing_address text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index clients_user_id_idx on clients (user_id);

create table invoices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  client_id uuid not null references clients (id) on delete restrict,

  -- Merchant-configurable numbering, not a bare auto-increment id. Uniqueness is scoped per
  -- merchant since two merchants may both use e.g. "INV-0001".
  invoice_number text not null,

  status invoice_status not null default 'draft',

  currency text not null default 'USD',
  subtotal_cents bigint not null default 0,
  discount_cents bigint not null default 0,
  tax_cents bigint not null default 0,
  total_cents bigint not null default 0,

  -- Partial-payment tracking: amount paid vs. total, not just a paid/unpaid boolean.
  amount_paid_cents bigint not null default 0,

  issue_date date not null default current_date,
  due_date date,
  terms text,
  notes text,

  sent_at timestamptz,
  voided_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint invoices_user_number_unique unique (user_id, invoice_number),
  constraint invoices_amount_paid_not_negative check (amount_paid_cents >= 0),
  constraint invoices_amount_paid_not_over_total check (amount_paid_cents <= total_cents)
);

create index invoices_user_id_idx on invoices (user_id);
create index invoices_client_id_idx on invoices (client_id);
create index invoices_status_idx on invoices (status);

create table invoice_line_items (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices (id) on delete cascade,

  -- Denormalized owner column so RLS policies don't need a join to invoices — required for
  -- Postgres RLS to be enforceable directly on this table.
  user_id uuid not null references auth.users (id) on delete cascade,

  description text not null,
  quantity numeric not null default 1,
  unit_price_cents bigint not null default 0,

  -- Per-line tax and discount, not just an invoice-level total.
  tax_rate_percent numeric not null default 0,
  discount_cents bigint not null default 0,

  sort_order integer not null default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index invoice_line_items_invoice_id_idx on invoice_line_items (invoice_id);
create index invoice_line_items_user_id_idx on invoice_line_items (user_id);

-- Row Level Security: every table scoped to its owning user. Supabase defaults RLS off on new
-- tables, which would otherwise leak cross-tenant data (see .claude/skills/add-migration/SKILL.md).

alter table clients enable row level security;
alter table invoices enable row level security;
alter table invoice_line_items enable row level security;

create policy "clients_select_own" on clients
  for select using (auth.uid() = user_id);
create policy "clients_insert_own" on clients
  for insert with check (auth.uid() = user_id);
create policy "clients_update_own" on clients
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "clients_delete_own" on clients
  for delete using (auth.uid() = user_id);

create policy "invoices_select_own" on invoices
  for select using (auth.uid() = user_id);
create policy "invoices_insert_own" on invoices
  for insert with check (auth.uid() = user_id);
create policy "invoices_update_own" on invoices
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "invoices_delete_own" on invoices
  for delete using (auth.uid() = user_id);

create policy "invoice_line_items_select_own" on invoice_line_items
  for select using (auth.uid() = user_id);
create policy "invoice_line_items_insert_own" on invoice_line_items
  for insert with check (auth.uid() = user_id);
create policy "invoice_line_items_update_own" on invoice_line_items
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "invoice_line_items_delete_own" on invoice_line_items
  for delete using (auth.uid() = user_id);
