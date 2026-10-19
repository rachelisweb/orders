-- An inventory/order-item update passes the same product twice (new and old row).
-- DISTINCT must run on the ids alone: clock_timestamp() differs per row, so
-- "select distinct pid, clock_timestamp()" kept duplicates and ON CONFLICT failed.
create or replace function public.shopify_enqueue_products(p_product_ids uuid[])
returns void language sql security definer set search_path = public
as $$
  insert into public.shopify_sync_queue(product_id, queued_at, attempts, last_error)
  select ids.pid, clock_timestamp(), 0, null
  from (select distinct u.pid from unnest(p_product_ids) as u(pid) where u.pid is not null) ids
  where exists (select 1 from public.products p where p.id = ids.pid)
  on conflict (product_id) do update
    set queued_at = excluded.queued_at, attempts = 0, last_error = null;
$$;
revoke all on function public.shopify_enqueue_products(uuid[]) from public, anon, authenticated;
