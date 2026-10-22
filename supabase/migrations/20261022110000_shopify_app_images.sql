-- App images uploaded to Shopify. An app image is added only to a store product
-- whose images all came from the app (or that has none); images the owner
-- uploaded to the store are never touched. A changed app image is added next to
-- the previous one, which stays.
create table if not exists public.shopify_app_images (
  product_id uuid not null references public.products(id) on delete cascade,
  image_url text not null,
  shopify_media_id text,
  added_at timestamptz not null default now(),
  primary key (product_id, image_url)
);
alter table public.shopify_app_images enable row level security;
drop policy if exists "admin reads shopify app images" on public.shopify_app_images;
create policy "admin reads shopify app images" on public.shopify_app_images
  for select to authenticated using (public.is_admin());

-- A new or replaced image queues the model.
create or replace function public.shopify_queue_product_change()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'INSERT'
     or new.retail_price is distinct from old.retail_price
     or new.collection_id is distinct from old.collection_id
     or new.is_active is distinct from old.is_active
     or new.model is distinct from old.model
     or new.image_url is distinct from old.image_url then
    perform public.shopify_enqueue_products(array[new.id]);
  end if;
  return null;
end $$;
