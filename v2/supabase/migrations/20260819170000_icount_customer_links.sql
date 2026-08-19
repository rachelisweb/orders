-- Persistent, auditable link between a local customer and its iCount card.
alter table public.customers
  add column if not exists icount_client_id bigint,
  add column if not exists icount_client_name text,
  add column if not exists icount_linked_at timestamptz,
  add column if not exists icount_linked_by uuid references auth.users(id) on delete set null;

-- Several local profiles may represent the same accounting customer.
drop index if exists public.customers_icount_client_id_unique;

comment on column public.customers.icount_client_id is
  'The canonical numeric client_id returned by iCount. Used for all document creation.';
