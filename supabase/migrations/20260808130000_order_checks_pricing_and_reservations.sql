-- Operational model checklist, repricing of eligible open orders, and
-- concurrency-safe reservations for regular pending orders.

alter table public.orders
  add column if not exists checked_models text[] not null default '{}'::text[];

create or replace function public.set_order_model_checked(
  p_order_id uuid,
  p_model text,
  p_checked boolean
)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_status text;
  v_models text[];
begin
  if not public.is_admin() then raise exception 'אין הרשאה'; end if;
  select status, checked_models into v_status, v_models
    from public.orders where id = p_order_id for update;
  if v_status is null then raise exception 'ההזמנה לא נמצאה'; end if;
  if v_status <> 'pending' then raise exception 'הצ׳קליסט זמין רק בהזמנות ממתינות'; end if;
  if not exists (select 1 from public.order_items where order_id = p_order_id and model = p_model) then
    raise exception 'הדגם לא נמצא בהזמנה';
  end if;

  if coalesce(p_checked, false) then
    if not (p_model = any(coalesce(v_models, '{}'::text[]))) then
      v_models := array_append(coalesce(v_models, '{}'::text[]), p_model);
    end if;
  else
    v_models := array_remove(coalesce(v_models, '{}'::text[]), p_model);
  end if;
  update public.orders set checked_models = v_models where id = p_order_id;
  return jsonb_build_object('ok', true, 'checked', coalesce(p_checked, false), 'model', p_model);
end $$;

create or replace function public.admin_update_customer(
  p_customer_id uuid,
  p_data jsonb
)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_old public.customers%rowtype;
  v_order record;
  v_cost boolean;
  v_discount numeric(5,2);
  v_repriced integer := 0;
  v_business text;
begin
  if not public.is_admin() then raise exception 'אין הרשאה'; end if;
  select * into v_old from public.customers where id = p_customer_id for update;
  if v_old.id is null then raise exception 'הלקוח לא נמצא'; end if;
  if nullif(btrim(coalesce(p_data->>'name', '')), '') is null then raise exception 'חסר שם לקוח'; end if;

  v_cost := coalesce((p_data->>'price_at_cost')::boolean, false);
  v_discount := case when v_cost then 0 else least(greatest(coalesce((p_data->>'discount_pct')::numeric, 0), 0), 100) end;
  v_business := nullif(btrim(coalesce(p_data->>'business_name', '')), '');

  update public.customers set
    name = btrim(p_data->>'name'),
    business_name = v_business,
    phone = nullif(btrim(coalesce(p_data->>'phone', '')), ''),
    email = nullif(btrim(coalesce(p_data->>'email', '')), ''),
    city = nullif(btrim(coalesce(p_data->>'city', '')), ''),
    tax_id = nullif(btrim(coalesce(p_data->>'tax_id', '')), ''),
    address = nullif(btrim(coalesce(p_data->>'address', '')), ''),
    notes = nullif(btrim(coalesce(p_data->>'notes', '')), ''),
    price_at_cost = v_cost,
    discount_pct = v_discount,
    duplicate_candidate_id = case
      when lower(coalesce(v_business, '')) <> lower(coalesce(v_old.business_name, '')) then null
      else v_old.duplicate_candidate_id end,
    duplicate_status = case
      when lower(coalesce(v_business, '')) <> lower(coalesce(v_old.business_name, '')) then null
      else v_old.duplicate_status end
  where id = p_customer_id;

  for v_order in
    select o.id
      from public.orders o
     where o.customer_id = p_customer_id
       and o.status in ('pending', 'ready')
       and o.archived_at is null
       and not exists (select 1 from public.invoices i where i.order_id = o.id)
     for update
  loop
    update public.order_items oi set product_id = p.id
      from public.products p
     where oi.order_id = v_order.id and oi.product_id is null
       and lower(btrim(oi.model)) = lower(btrim(p.model));

    if v_cost and exists (
      select 1 from public.order_items oi
      left join public.products p on p.id = oi.product_id
      where oi.order_id = v_order.id and (p.id is null or coalesce(p.cost_price, 0) <= 0)
    ) then
      raise exception 'לא ניתן לעדכן למחיר עלות: באחת ההזמנות הפתוחות יש דגם ללא מחיר עלות';
    end if;

    update public.order_items oi
       set unit_price = case when v_cost then p.cost_price else p.wholesale_price end
      from public.products p
     where oi.order_id = v_order.id and oi.product_id = p.id;

    update public.orders set
      pricing_mode = case when v_cost then 'cost' else 'wholesale' end,
      discount_type = case when not v_cost and v_discount > 0 then 'pct' else null end,
      discount_value = case when not v_cost then v_discount else 0 end
    where id = v_order.id;
    perform public.recalc_order(v_order.id);
    v_repriced := v_repriced + 1;
  end loop;

  return jsonb_build_object('ok', true, 'repriced_orders', v_repriced);
end $$;

create or replace function public.get_available_inventory()
returns table(product_id uuid, size text, qty integer)
language sql
stable
security definer set search_path = public
as $$
  select i.product_id, i.size,
    greatest(i.qty - coalesce(r.reserved, 0), 0)::integer as qty
  from public.inventory i
  left join (
    select oi.product_id, oi.size, sum(oi.qty)::integer as reserved
    from public.order_items oi
    join public.orders o on o.id = oi.order_id
    where o.status = 'pending' and not o.stock_applied and o.future_order_at is null and oi.qty > 0
    group by oi.product_id, oi.size
  ) r on r.product_id = i.product_id and r.size = i.size;
$$;

create or replace function public.enforce_order_item_available_stock()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_order record;
  v_stock integer;
  v_reserved integer;
begin
  select status, stock_applied, future_order_at into v_order
    from public.orders where id = new.order_id;
  if v_order.status <> 'pending' or v_order.stock_applied or v_order.future_order_at is not null or new.qty <= 0 then
    return new;
  end if;
  if new.product_id is null then raise exception 'לא ניתן לשריין דגם שאינו קיים במלאי'; end if;
  if tg_op = 'UPDATE' and old.product_id = new.product_id and old.size = new.size and new.qty <= old.qty then
    return new;
  end if;

  select qty into v_stock from public.inventory
   where product_id = new.product_id and size = new.size for update;
  if v_stock is null then raise exception 'דגם % מידה % אינו קיים במלאי', new.model, new.size; end if;

  select coalesce(sum(oi.qty), 0)::integer into v_reserved
    from public.order_items oi
    join public.orders o on o.id = oi.order_id
   where oi.product_id = new.product_id and oi.size = new.size
     and o.status = 'pending' and not o.stock_applied and o.future_order_at is null
     and (tg_op = 'INSERT' or oi.id <> old.id);
  if v_reserved + new.qty > v_stock then
    raise exception 'דגם % מידה %: הכמות הזמינה כבר תפוסה בהזמנות אחרות', new.model, new.size;
  end if;
  return new;
end $$;

drop trigger if exists order_items_enforce_available_stock on public.order_items;
create trigger order_items_enforce_available_stock
before insert or update of qty, product_id, size, order_id on public.order_items
for each row execute function public.enforce_order_item_available_stock();

create or replace function public.enforce_order_reservation_on_activation()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_item record;
  v_stock integer;
  v_reserved integer;
  v_old_reserving boolean;
  v_new_reserving boolean;
begin
  v_old_reserving := old.status = 'pending' and not old.stock_applied and old.future_order_at is null;
  v_new_reserving := new.status = 'pending' and not new.stock_applied and new.future_order_at is null;
  if not v_new_reserving or v_old_reserving then return new; end if;

  for v_item in
    select product_id, model, size, sum(qty)::integer as qty
      from public.order_items where order_id = new.id and qty > 0
     group by product_id, model, size order by product_id, size
  loop
    select qty into v_stock from public.inventory
     where product_id = v_item.product_id and size = v_item.size for update;
    select coalesce(sum(oi.qty), 0)::integer into v_reserved
      from public.order_items oi join public.orders o on o.id = oi.order_id
     where oi.product_id = v_item.product_id and oi.size = v_item.size and oi.order_id <> new.id
       and o.status = 'pending' and not o.stock_applied and o.future_order_at is null;
    if v_stock is null or v_reserved + v_item.qty > v_stock then
      raise exception 'לא ניתן להחזיר לממתינות: דגם % מידה % כבר תפוס בהזמנות אחרות', v_item.model, v_item.size;
    end if;
  end loop;
  return new;
end $$;

drop trigger if exists orders_enforce_reservation_on_activation on public.orders;
create trigger orders_enforce_reservation_on_activation
before update of status, stock_applied, future_order_at on public.orders
for each row execute function public.enforce_order_reservation_on_activation();

grant execute on function public.set_order_model_checked(uuid, text, boolean) to authenticated;
grant execute on function public.admin_update_customer(uuid, jsonb) to authenticated;
grant execute on function public.get_available_inventory() to authenticated;

