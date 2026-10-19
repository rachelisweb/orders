-- Automatic Shopify sync.
-- Every change that affects a model's sellable stock, retail price or season collection
-- queues the model; pg_cron drains the queue through the shopify-sync Edge Function.
-- Retail orders/refunds reported by Shopify webhooks are applied back to inventory once.

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

-- ── Tables ───────────────────────────────────────────────────
create table if not exists public.shopify_sync_queue (
  product_id uuid primary key references public.products(id) on delete cascade,
  queued_at timestamptz not null default clock_timestamp(),
  attempts integer not null default 0,
  last_error text
);

create table if not exists public.shopify_sync_state (
  id boolean primary key default true check (id),
  running_until timestamptz,
  last_run_at timestamptz,
  last_mode text,
  last_result jsonb,
  last_success_at timestamptz,
  season_tags text[] not null default array['summer-collection', 'winter-collection'],
  webhooks_registered_at timestamptz
);
insert into public.shopify_sync_state(id) values (true) on conflict (id) do nothing;

create table if not exists public.shopify_product_links (
  product_id uuid primary key references public.products(id) on delete cascade,
  shopify_product_id text not null unique,
  linked_at timestamptz not null default now()
);

create table if not exists public.shopify_stock_events (
  event_key text primary key,
  topic text not null,
  shopify_order_id bigint,
  order_name text,
  direction smallint not null check (direction in (-1, 1)),
  lines jsonb not null default '[]'::jsonb,
  applied jsonb not null default '[]'::jsonb,
  unmatched jsonb not null default '[]'::jsonb,
  skipped_reason text,
  created_at timestamptz not null default now()
);
create index if not exists shopify_stock_events_created_idx on public.shopify_stock_events (created_at desc);

alter table public.shopify_sync_queue enable row level security;
alter table public.shopify_sync_state enable row level security;
alter table public.shopify_product_links enable row level security;
alter table public.shopify_stock_events enable row level security;

drop policy if exists "admin reads shopify sync queue" on public.shopify_sync_queue;
create policy "admin reads shopify sync queue" on public.shopify_sync_queue for select to authenticated using (public.is_admin());
drop policy if exists "admin reads shopify sync state" on public.shopify_sync_state;
create policy "admin reads shopify sync state" on public.shopify_sync_state for select to authenticated using (public.is_admin());
drop policy if exists "admin reads shopify product links" on public.shopify_product_links;
create policy "admin reads shopify product links" on public.shopify_product_links for select to authenticated using (public.is_admin());
drop policy if exists "admin reads shopify stock events" on public.shopify_stock_events;
create policy "admin reads shopify stock events" on public.shopify_stock_events for select to authenticated using (public.is_admin());

-- ── Queueing ─────────────────────────────────────────────────
create or replace function public.shopify_enqueue_products(p_product_ids uuid[])
returns void language sql security definer set search_path = public
as $$
  insert into public.shopify_sync_queue(product_id, queued_at, attempts, last_error)
  select distinct u.pid, clock_timestamp(), 0, null
  from unnest(p_product_ids) as u(pid)
  where u.pid is not null and exists (select 1 from public.products p where p.id = u.pid)
  on conflict (product_id) do update
    set queued_at = excluded.queued_at, attempts = 0, last_error = null;
$$;
revoke all on function public.shopify_enqueue_products(uuid[]) from public, anon, authenticated;

create or replace function public.shopify_enqueue_all()
returns integer language plpgsql security definer set search_path = public
as $$
declare v_count integer;
begin
  perform public.shopify_enqueue_products(array(select id from public.products));
  select count(*) into v_count from public.shopify_sync_queue;
  return v_count;
end $$;
revoke all on function public.shopify_enqueue_all() from public, anon, authenticated;
grant execute on function public.shopify_enqueue_all() to service_role;

create or replace function public.shopify_queue_inventory_change()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    perform public.shopify_enqueue_products(array[old.product_id]);
  elsif tg_op = 'INSERT' then
    perform public.shopify_enqueue_products(array[new.product_id]);
  elsif new.qty is distinct from old.qty or new.product_id is distinct from old.product_id
     or new.size is distinct from old.size then
    perform public.shopify_enqueue_products(array[new.product_id, old.product_id]);
  end if;
  return null;
end $$;

drop trigger if exists inventory_shopify_queue on public.inventory;
create trigger inventory_shopify_queue
after insert or update or delete on public.inventory
for each row execute function public.shopify_queue_inventory_change();

create or replace function public.shopify_queue_product_change()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'INSERT'
     or new.retail_price is distinct from old.retail_price
     or new.collection_id is distinct from old.collection_id
     or new.is_active is distinct from old.is_active
     or new.model is distinct from old.model then
    perform public.shopify_enqueue_products(array[new.id]);
  end if;
  return null;
end $$;

drop trigger if exists products_shopify_queue on public.products;
create trigger products_shopify_queue
after insert or update on public.products
for each row execute function public.shopify_queue_product_change();

create or replace function public.shopify_queue_collection_change()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if new.shopify_tag is distinct from old.shopify_tag then
    -- A retired tag must still be removed from products on the site.
    if old.shopify_tag is not null then
      update public.shopify_sync_state
         set season_tags = array(select distinct unnest(season_tags || old.shopify_tag))
       where id;
    end if;
    perform public.shopify_enqueue_products(array(select id from public.products where collection_id = new.id));
  end if;
  return null;
end $$;

drop trigger if exists collections_shopify_queue on public.collections;
create trigger collections_shopify_queue
after update on public.collections
for each row execute function public.shopify_queue_collection_change();

-- Wholesale reservations change the stock available for retail.
create or replace function public.shopify_queue_order_item_change()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    perform public.shopify_enqueue_products(array[old.product_id]);
  elsif tg_op = 'INSERT' then
    perform public.shopify_enqueue_products(array[new.product_id]);
  elsif new.qty is distinct from old.qty or new.product_id is distinct from old.product_id
     or new.size is distinct from old.size or new.order_id is distinct from old.order_id then
    perform public.shopify_enqueue_products(array[new.product_id, old.product_id]);
  end if;
  return null;
end $$;

drop trigger if exists order_items_shopify_queue on public.order_items;
create trigger order_items_shopify_queue
after insert or update or delete on public.order_items
for each row execute function public.shopify_queue_order_item_change();

create or replace function public.shopify_queue_order_change()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if new.status is distinct from old.status
     or new.stock_applied is distinct from old.stock_applied
     or new.future_order_at is distinct from old.future_order_at then
    perform public.shopify_enqueue_products(array(select product_id from public.order_items where order_id = new.id));
  end if;
  return null;
end $$;

drop trigger if exists orders_shopify_queue on public.orders;
create trigger orders_shopify_queue
after update on public.orders
for each row execute function public.shopify_queue_order_change();

-- ── Run coordination (service role only) ─────────────────────
create or replace function public.shopify_sync_claim(p_seconds integer default 170)
returns timestamptz language plpgsql security definer set search_path = public
as $$
declare v_started timestamptz := clock_timestamp();
begin
  update public.shopify_sync_state
     set running_until = v_started + make_interval(secs => p_seconds)
   where id and (running_until is null or running_until < v_started);
  if not found then return null; end if;
  return v_started;
end $$;
revoke all on function public.shopify_sync_claim(integer) from public, anon, authenticated;
grant execute on function public.shopify_sync_claim(integer) to service_role;

create or replace function public.shopify_sync_release(
  p_mode text, p_started timestamptz, p_result jsonb, p_done uuid[], p_failed jsonb)
returns void language plpgsql security definer set search_path = public
as $$
begin
  -- Rows touched again after the run started stay queued for the next run.
  delete from public.shopify_sync_queue
   where product_id = any(coalesce(p_done, '{}')) and queued_at <= p_started;

  update public.shopify_sync_queue q
     set attempts = q.attempts + 1, last_error = f.value->>'error'
    from jsonb_array_elements(coalesce(p_failed, '[]'::jsonb)) f
   where q.product_id = (f.value->>'product_id')::uuid and q.queued_at <= p_started;

  update public.shopify_sync_state
     set running_until = null,
         last_run_at = now(),
         last_mode = p_mode,
         last_result = p_result,
         last_success_at = case when jsonb_array_length(coalesce(p_failed, '[]'::jsonb)) = 0 then now() else last_success_at end
   where id;
end $$;
revoke all on function public.shopify_sync_release(text, timestamptz, jsonb, uuid[], jsonb) from public, anon, authenticated;
grant execute on function public.shopify_sync_release(text, timestamptz, jsonb, uuid[], jsonb) to service_role;

create or replace function public.shopify_mark_webhooks_registered()
returns void language sql security definer set search_path = public
as $$ update public.shopify_sync_state set webhooks_registered_at = now() where id; $$;
revoke all on function public.shopify_mark_webhooks_registered() from public, anon, authenticated;
grant execute on function public.shopify_mark_webhooks_registered() to service_role;

-- ── Shared secret for pg_cron → Edge Function ────────────────
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'shopify_sync_secret') then
    perform vault.create_secret(
      replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
      'shopify_sync_secret',
      'pg_cron → shopify-sync shared secret');
  end if;
end $$;

create or replace function public.shopify_sync_secret_ok(p_secret text)
returns boolean language sql stable security definer set search_path = public
as $$
  select coalesce(length(p_secret), 0) >= 32 and exists (
    select 1 from vault.decrypted_secrets where name = 'shopify_sync_secret' and decrypted_secret = p_secret);
$$;
revoke all on function public.shopify_sync_secret_ok(text) from public, anon, authenticated;
grant execute on function public.shopify_sync_secret_ok(text) to service_role;

-- Fire-and-forget call to the Edge Function; returns the pg_net request id.
create or replace function public.shopify_sync_request(p_body jsonb, p_timeout_ms integer default 5000)
returns bigint language plpgsql security definer set search_path = public
as $$
declare v_secret text;
begin
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'shopify_sync_secret';
  return net.http_post(
    url := 'https://akblpqtkwftlskwgxujk.supabase.co/functions/v1/shopify-sync',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-sync-secret', v_secret),
    body := p_body,
    timeout_milliseconds := p_timeout_ms);
end $$;
revoke all on function public.shopify_sync_request(jsonb, integer) from public, anon, authenticated;

create or replace function public.shopify_sync_kick(p_mode text default 'queue')
returns bigint language plpgsql security definer set search_path = public
as $$
declare v_running timestamptz;
begin
  if p_mode = 'queue' and not exists (select 1 from public.shopify_sync_queue where attempts < 5) then
    return null;
  end if;
  select running_until into v_running from public.shopify_sync_state where id;
  if v_running is not null and v_running > now() then return null; end if;
  return public.shopify_sync_request(jsonb_build_object('mode', p_mode));
end $$;
revoke all on function public.shopify_sync_kick(text) from public, anon, authenticated;

-- ── Retail stock events from Shopify webhooks ────────────────
create or replace function public.apply_shopify_stock_event(
  p_event_key text, p_topic text, p_order_id bigint, p_order_name text,
  p_direction integer, p_lines jsonb, p_requires_event text default null)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  v_line jsonb;
  v_sku text;
  v_qty integer;
  v_model text;
  v_size text;
  v_product uuid;
  v_before integer;
  v_after integer;
  v_applied jsonb := '[]'::jsonb;
  v_unmatched jsonb := '[]'::jsonb;
begin
  if p_direction not in (-1, 1) then raise exception 'invalid direction'; end if;

  insert into public.shopify_stock_events(event_key, topic, shopify_order_id, order_name, direction, lines)
  values (p_event_key, p_topic, p_order_id, p_order_name, p_direction, coalesce(p_lines, '[]'::jsonb))
  on conflict (event_key) do nothing;
  if not found then return jsonb_build_object('duplicate', true); end if;

  -- A refund only restocks an order whose sale was deducted here.
  if p_requires_event is not null
     and not exists (select 1 from public.shopify_stock_events where event_key = p_requires_event) then
    update public.shopify_stock_events set skipped_reason = 'ההזמנה המקורית לא קוזזה מהמלאי'
     where event_key = p_event_key;
    return jsonb_build_object('duplicate', false, 'skipped', true);
  end if;

  for v_line in select value from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    v_sku := upper(btrim(coalesce(v_line->>'sku', '')));
    v_qty := coalesce((v_line->>'qty')::integer, 0);
    continue when v_qty <= 0;

    v_model := substring(v_sku from '^(.+)-(?:XS|S|M|L|XL|XXL|3XL|4XL|5XL)$');
    v_size := substring(v_sku from '-(XS|S|M|L|XL|XXL|3XL|4XL|5XL)$');
    v_product := null;
    if v_model is not null then
      select id into v_product from public.products where upper(model) = v_model limit 1;
    end if;
    if v_product is null then
      v_unmatched := v_unmatched || jsonb_build_object('sku', v_sku, 'qty', v_qty);
      continue;
    end if;

    insert into public.inventory(product_id, size, qty) values (v_product, v_size, 0)
    on conflict (product_id, size) do nothing;
    select qty into v_before from public.inventory where product_id = v_product and size = v_size for update;
    v_after := greatest(v_before + p_direction * v_qty, 0);
    update public.inventory set qty = v_after where product_id = v_product and size = v_size;

    v_applied := v_applied || jsonb_build_object(
      'sku', v_sku, 'qty', v_qty, 'before', v_before, 'after', v_after,
      'short', case when p_direction < 0 and v_before < v_qty then v_qty - v_before else 0 end);
  end loop;

  update public.shopify_stock_events set applied = v_applied, unmatched = v_unmatched
   where event_key = p_event_key;
  return jsonb_build_object('duplicate', false, 'applied', v_applied, 'unmatched', v_unmatched);
end $$;
revoke all on function public.apply_shopify_stock_event(text, text, bigint, text, integer, jsonb, text) from public, anon, authenticated;
grant execute on function public.apply_shopify_stock_event(text, text, bigint, text, integer, jsonb, text) to service_role;

-- ── Admin status ─────────────────────────────────────────────
create or replace function public.get_shopify_sync_status()
returns jsonb language plpgsql stable security definer set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'אין הרשאה'; end if;
  return jsonb_build_object(
    'state', (select to_jsonb(s) - 'id' - 'season_tags' from public.shopify_sync_state s where id),
    'queued', (select count(*) from public.shopify_sync_queue where attempts < 5),
    'stuck', (select coalesce(jsonb_agg(jsonb_build_object('model', p.model, 'error', q.last_error) order by p.model), '[]'::jsonb)
                from public.shopify_sync_queue q join public.products p on p.id = q.product_id where q.attempts >= 5),
    'auto', exists (select 1 from cron.job where jobname = 'shopify-sync-queue' and active),
    'events', (select coalesce(jsonb_agg(to_jsonb(e) order by e.created_at desc), '[]'::jsonb) from (
                 select topic, order_name, direction, applied, unmatched, skipped_reason, created_at
                 from public.shopify_stock_events order by created_at desc limit 15) e)
  );
end $$;
revoke all on function public.get_shopify_sync_status() from public, anon;
grant execute on function public.get_shopify_sync_status() to authenticated;

-- ── Season tags: summer joins winter ─────────────────────────
update public.collections set shopify_tag = 'summer-collection'
 where slug = 'summer' and shopify_tag is null;
