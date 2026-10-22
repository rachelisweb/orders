-- Models the owner removed from the store on purpose: the sync never creates
-- them on Shopify again. If one is re-added to the store by hand, its stock
-- still syncs as usual.
create table if not exists public.shopify_no_create (
  product_id uuid primary key references public.products(id) on delete cascade,
  note text,
  created_at timestamptz not null default now()
);
alter table public.shopify_no_create enable row level security;
drop policy if exists "admin reads shopify no-create list" on public.shopify_no_create;
create policy "admin reads shopify no-create list" on public.shopify_no_create
  for select to authenticated using (public.is_admin());

insert into public.shopify_no_create(product_id, note)
select id, 'נמחק מהאתר בכוונה (22.10.2026)' from public.products
 where split_part(btrim(model), ' ', 1) = '26234'
on conflict (product_id) do nothing;
