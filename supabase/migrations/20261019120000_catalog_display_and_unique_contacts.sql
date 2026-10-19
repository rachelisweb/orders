-- Catalog presentation is one atomic preference shared by guests and customers.
create or replace function public.get_catalog_preferences()
returns jsonb language sql stable security definer set search_path = public
as $$
  select coalesce((select value::jsonb from public.app_settings where key = 'catalog_display'),
    '{"mode":"collections","collection_id":null}'::jsonb)
$$;
revoke all on function public.get_catalog_preferences() from public;
grant execute on function public.get_catalog_preferences() to anon, authenticated;

create or replace function public.set_catalog_preferences(p_mode text, p_collection_id uuid default null)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare v_preferences jsonb;
begin
  if not public.is_admin() then raise exception 'אין הרשאה'; end if;
  if p_mode is null or p_mode not in ('collections', 'all', 'single') then raise exception 'תצוגה לא תקינה'; end if;
  if p_mode = 'single' and not exists (select 1 from public.collections where id = p_collection_id and is_active) then
    raise exception 'יש לבחור קולקציה פעילה';
  end if;
  v_preferences := jsonb_build_object('mode', p_mode, 'collection_id', case when p_mode = 'single' then p_collection_id end);
  insert into public.app_settings(key, value, updated_at) values ('catalog_display', v_preferences::text, now())
    on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at;
  update public.catalog_realtime_signal set changed_at = clock_timestamp() where id;
  return v_preferences;
end $$;
revoke all on function public.set_catalog_preferences(text, uuid) from public, anon;
grant execute on function public.set_catalog_preferences(text, uuid) to authenticated;

create or replace function public.catalog_collection_visible(p_collection_id uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select case when prefs->>'mode' = 'single' then
    p_collection_id::text = prefs->>'collection_id'
      and exists (select 1 from public.collections where id = p_collection_id and is_active)
    when p_collection_id is null then prefs->>'mode' = 'all'
    else exists (select 1 from public.collections where id = p_collection_id and is_active) end
  from (select public.get_catalog_preferences() as prefs) s
$$;
revoke all on function public.catalog_collection_visible(uuid) from public;
grant execute on function public.catalog_collection_visible(uuid) to anon, authenticated;

create or replace function public.get_guest_catalog()
returns jsonb language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'collections', coalesce((select jsonb_agg(to_jsonb(c) order by c.sort_order)
      from public.collections c where c.is_active and public.catalog_collection_visible(c.id)), '[]'::jsonb),
    'products', coalesce((select jsonb_agg(jsonb_build_object(
      'id', p.id, 'model', p.model, 'description', p.description, 'image_url', p.image_url,
      'sort_order', p.sort_order, 'collection_id', p.collection_id) order by p.sort_order)
      from public.products p where p.is_active and p.retired_at is null
        and public.catalog_collection_visible(p.collection_id)), '[]'::jsonb),
    'inventory', coalesce((select jsonb_agg(jsonb_build_object('product_id', a.product_id, 'size', a.size, 'available', true))
      from public.get_available_inventory() a join public.products p on p.id = a.product_id
      where a.qty > 0 and p.is_active and p.retired_at is null
        and public.catalog_collection_visible(p.collection_id)), '[]'::jsonb)
  )
$$;
revoke all on function public.get_guest_catalog() from public, authenticated;
grant execute on function public.get_guest_catalog() to anon;

-- An old open browser may still have hidden models in its cart.
create or replace function public.check_order_item_catalog_visibility()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if public.is_admin() or coalesce(new.qty, 0) <= 0 then return new; end if;
  if tg_op = 'UPDATE' then
    if new.product_id is not distinct from old.product_id and new.qty <= old.qty then return new; end if;
  end if;
  if not exists (select 1 from public.products p where p.id = new.product_id and p.is_active
    and p.retired_at is null and public.catalog_collection_visible(p.collection_id)) then
    raise exception 'הדגם אינו מוצג בקטלוג כרגע. יש לרענן את הסל';
  end if;
  return new;
end $$;
drop trigger if exists order_items_catalog_visibility on public.order_items;
create trigger order_items_catalog_visibility before insert or update of product_id, qty on public.order_items
  for each row execute function public.check_order_item_catalog_visibility();

create or replace function public.move_products_to_collection(p_collection_id uuid, p_product_ids uuid[])
returns jsonb language plpgsql security definer set search_path = public
as $$
declare v_count integer; v_expected integer;
begin
  if not public.is_admin() then raise exception 'אין הרשאה'; end if;
  perform 1 from public.collections where id = p_collection_id for update;
  if not found then raise exception 'הקולקציה לא נמצאה'; end if;
  select count(distinct id) into v_expected from unnest(p_product_ids) as ids(id);
  if v_expected < 1 or v_expected > 5000 then raise exception 'יש לבחור בין 1 ל־5,000 דגמים'; end if;
  update public.products set collection_id = p_collection_id, updated_at = now()
    where id = any(p_product_ids) and retired_at is null;
  get diagnostics v_count = row_count;
  if v_count <> v_expected then raise exception 'חלק מהדגמים לא נמצאו. לא הועברו דגמים'; end if;
  return jsonb_build_object('count', v_count);
end $$;
revoke all on function public.move_products_to_collection(uuid, uuid[]) from public, anon;
grant execute on function public.move_products_to_collection(uuid, uuid[]) to authenticated;

create or replace function public.normalize_customer_phone(p_phone text)
returns text language sql immutable set search_path = public
as $$
  select nullif(case when digits ~ '^(00972|972)' then '0' || regexp_replace(digits, '^(00972|972)0?', '')
    else digits end, '') from (select regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g') as digits) x
$$;

create or replace function public.normalize_customer_phones(p_phones text[], p_fallback text default null)
returns text[] language sql immutable set search_path = public
as $$
  with candidates as (
    select value, ord from unnest(coalesce(p_phones, '{}'::text[])) with ordinality as x(value, ord)
    union all select p_fallback, 2147483647 where cardinality(coalesce(p_phones, '{}'::text[])) = 0
  ), cleaned as (
    select public.normalize_customer_phone(value) as phone, ord from candidates
  ), unique_values as (
    select phone, min(ord) as ord from cleaned where phone is not null group by phone
  ) select coalesce(array_agg(phone order by ord), '{}'::text[]) from unique_values
$$;

create or replace function public.sanitize_customer_phones()
returns trigger language plpgsql set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.phone_numbers := array[new.phone] || coalesce(new.phone_numbers, '{}'::text[]);
  elsif new.phone is distinct from old.phone and new.phone_numbers is not distinct from old.phone_numbers then
    new.phone_numbers := array[new.phone] || coalesce(new.phone_numbers, '{}'::text[]);
  end if;
  new.phone_numbers := public.normalize_customer_phones(new.phone_numbers, new.phone);
  new.phone := new.phone_numbers[1];
  return new;
end $$;
drop trigger if exists customers_sanitize_phones on public.customers;
create trigger customers_sanitize_phones before insert or update of phone, phone_numbers on public.customers
  for each row execute function public.sanitize_customer_phones();

-- The existing merge function unions contacts; these triggers normalize and
-- deduplicate both ordinary writes and merged cards at the database boundary.
update public.customers
  set phone_numbers = public.normalize_customer_phones(array[phone] || coalesce(phone_numbers, '{}'::text[])),
      email_recipients = public.normalize_customer_emails(email_recipients, email)
  where phone_numbers is distinct from public.normalize_customer_phones(array[phone] || coalesce(phone_numbers, '{}'::text[]))
    or phone is distinct from (public.normalize_customer_phones(array[phone] || coalesce(phone_numbers, '{}'::text[])))[1]
    or email_recipients is distinct from public.normalize_customer_emails(email_recipients, email);
