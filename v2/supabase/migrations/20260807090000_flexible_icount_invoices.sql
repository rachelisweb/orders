-- חשבוניות iCount שאינן קשורות להזמנה: יומן נעילה והתאוששות נפרד.
-- הטבלה חסומה למשתמשים; רק פונקציית הקצה עם service_role ניגשת אליה.
create table if not exists public.icount_flexible_invoice_generations (
  request_id        uuid primary key,
  customer_id       uuid not null references public.customers(id) on delete restrict,
  fingerprint       text not null,
  sanity_string     text not null unique,
  status            text not null check (status in ('processing', 'succeeded', 'failed', 'needs_review')),
  attempts          integer not null default 1,
  external_doctype  text,
  external_docnum   text,
  external_url      text,
  invoice_id        uuid references public.invoices(id) on delete set null,
  error             text,
  locked_at         timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

alter table public.icount_flexible_invoice_generations enable row level security;
revoke all on public.icount_flexible_invoice_generations from public, anon, authenticated;

create unique index if not exists invoices_unique_icount_document
  on public.invoices (external_doctype, external_docnum)
  where source = 'icount' and external_docnum is not null;
