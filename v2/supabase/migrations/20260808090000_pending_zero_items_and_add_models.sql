-- Keep zero quantities visible while an order is pending, and allow admins
-- to add products to a pending order without bypassing inventory/pricing rules.

alter table public.order_items
  drop constraint if exists order_items_qty_check;

alter table public.order_items
  add constraint order_items_qty_check check (qty >= 0);

create or replace function public.edit_order_item(
  p_item_id bigint,
  p_qty     integer
)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_order   uuid;
  v_status  text;
  v_applied boolean;
  v_pid     uuid;
  v_size    text;
  v_avail   integer;
begin
  if not public.is_admin() then raise exception 'אין הרשאה'; end if;
  if p_qty is null or p_qty < 0 then raise exception 'הכמות חייבת להיות 0 או יותר'; end if;

  select oi.order_id, oi.product_id, oi.size
    into v_order, v_pid, v_size
    from public.order_items oi where oi.id = p_item_id;
  if v_order is null then raise exception 'השורה לא נמצאה'; end if;

  select status, stock_applied into v_status, v_applied
    from public.orders where id = v_order for update;
  if v_applied then raise exception 'לא ניתן לערוך הזמנה שהמלאי שלה כבר עודכן'; end if;
  if v_status <> 'pending' then raise exception 'ניתן לערוך רק הזמנות ממתינות'; end if;

  select qty into v_avail from public.inventory
   where product_id = v_pid and size = v_size;
  if v_avail is not null and p_qty > v_avail then
    raise exception 'יש רק % במלאי במידה %', v_avail, v_size;
  end if;

  update public.order_items set qty = p_qty where id = p_item_id;
  perform public.recalc_order(v_order);

  return jsonb_build_object(
    'ok', true,
    'lines_left', (select count(*) from public.order_items where order_id = v_order),
    'positive_lines', (select count(*) from public.order_items where order_id = v_order and qty > 0));
end $$;

create or replace function public.admin_add_order_items(
  p_order_id uuid,
  p_items    jsonb
)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_order      record;
  v_item       jsonb;
  v_product    record;
  v_existing   record;
  v_model      text;
  v_size       text;
  v_qty        integer;
  v_avail      integer;
  v_new_qty    integer;
  v_price      numeric(10,2);
  v_added      integer := 0;
begin
  if not public.is_admin() then raise exception 'אין הרשאה'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'יש לבחור לפחות מידה אחת';
  end if;

  select id, status, stock_applied, pricing_mode
    into v_order from public.orders where id = p_order_id for update;
  if v_order.id is null then raise exception 'ההזמנה לא נמצאה'; end if;
  if v_order.status <> 'pending' or v_order.stock_applied then
    raise exception 'ניתן להוסיף דגמים רק להזמנה ממתינה';
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_model := btrim(coalesce(v_item->>'model', ''));
    v_size := btrim(upper(coalesce(v_item->>'size', '')));
    v_qty := coalesce((v_item->>'qty')::integer, 0);
    if v_model = '' or v_size = '' or v_qty <= 0 then continue; end if;

    select p.id, p.model, p.wholesale_price, p.cost_price, p.is_active
      into v_product from public.products p
     where lower(btrim(p.model)) = lower(v_model);
    if v_product.id is null then raise exception 'דגם % לא נמצא במערכת', v_model; end if;
    if not v_product.is_active then raise exception 'דגם % אינו זמין להזמנה', v_model; end if;

    select qty into v_avail from public.inventory
     where product_id = v_product.id and size = v_size for update;
    if v_avail is null then raise exception 'דגם % מידה % אינו קיים במלאי', v_model, v_size; end if;

    select id, qty into v_existing
      from public.order_items
     where order_id = p_order_id and product_id = v_product.id and size = v_size
     order by id limit 1 for update;
    v_new_qty := coalesce(v_existing.qty, 0) + v_qty;
    if v_new_qty > v_avail then
      raise exception 'דגם % מידה %: לאחר ההוספה יהיו %, אך יש רק % במלאי', v_model, v_size, v_new_qty, v_avail;
    end if;

    v_price := case when v_order.pricing_mode = 'cost'
      then v_product.cost_price else v_product.wholesale_price end;
    if v_order.pricing_mode = 'cost' and coalesce(v_price, 0) <= 0 then
      raise exception 'לדגם % לא הוגדר מחיר עלות', v_model;
    end if;

    if v_existing.id is not null then
      update public.order_items
         set qty = v_new_qty, qty_ordered = v_new_qty, unit_price = v_price
       where id = v_existing.id;
    else
      insert into public.order_items (order_id, product_id, model, size, qty, qty_ordered, unit_price)
      values (p_order_id, v_product.id, v_product.model, v_size, v_qty, v_qty, v_price);
    end if;
    v_added := v_added + v_qty;
  end loop;

  if v_added = 0 then raise exception 'יש לבחור לפחות מידה אחת'; end if;
  perform public.recalc_order(p_order_id);
  return jsonb_build_object('ok', true, 'added_units', v_added);
end $$;

create or replace function public.remove_zero_order_items_before_ready()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if old.status = 'pending' and new.status in ('ready', 'shipped') then
    if not exists (select 1 from public.order_items where order_id = new.id and qty > 0) then
      raise exception 'לא ניתן להעביר הזמנה ללא פריטים למוכנה לאיסוף';
    end if;
    delete from public.order_items where order_id = new.id and qty = 0;
  end if;
  return new;
end $$;

drop trigger if exists orders_remove_zero_items_before_ready on public.orders;
create trigger orders_remove_zero_items_before_ready
before update of status on public.orders
for each row execute function public.remove_zero_order_items_before_ready();

create or replace function public.set_order_status(p_order_id uuid, p_status text)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_old text; v_applied boolean; v_rec record; v_new integer; v_missing jsonb := '[]'::jsonb;
begin
  if not public.is_admin() then raise exception 'אין הרשאה'; end if;
  if p_status not in ('pending', 'ready', 'shipped', 'cancelled') then raise exception 'סטטוס לא חוקי: %', p_status; end if;
  select status, stock_applied into v_old, v_applied from public.orders where id = p_order_id for update;
  if v_old is null then raise exception 'ההזמנה לא נמצאה'; end if;
  if v_old = p_status then return jsonb_build_object('ok', true, 'unchanged', true, 'archived', p_status = 'shipped'); end if;

  if p_status in ('ready', 'shipped') and not v_applied then
    if not exists (select 1 from public.order_items where order_id = p_order_id and qty > 0) then
      raise exception 'לא ניתן להעביר הזמנה ללא פריטים למוכנה לאיסוף';
    end if;
    delete from public.order_items where order_id = p_order_id and qty = 0;
    perform public.recalc_order(p_order_id);
    for v_rec in select product_id, model, size, qty from public.order_items where order_id = p_order_id and qty > 0 loop
      v_new := null;
      update public.inventory set qty = greatest(0, qty - v_rec.qty), updated_at = now()
       where product_id = v_rec.product_id and size = v_rec.size returning qty into v_new;
      if v_new is null then
        v_missing := v_missing || jsonb_build_object('model', v_rec.model, 'size', v_rec.size);
      else
        insert into public.stock_log (product_id, model, size, delta, reason, ref_id, actor)
        values (v_rec.product_id, v_rec.model, v_rec.size, -v_rec.qty, 'order_' || p_status, p_order_id, auth.uid());
      end if;
    end loop;
    v_applied := true;
  end if;

  if p_status = 'cancelled' and v_applied then
    for v_rec in select product_id, model, size, qty from public.order_items where order_id = p_order_id and qty > 0 loop
      insert into public.inventory (product_id, size, qty) values (v_rec.product_id, v_rec.size, v_rec.qty)
      on conflict (product_id, size) do update set qty = public.inventory.qty + excluded.qty, updated_at = now();
      insert into public.stock_log (product_id, model, size, delta, reason, ref_id, actor)
      values (v_rec.product_id, v_rec.model, v_rec.size, v_rec.qty, 'order_cancelled', p_order_id, auth.uid());
    end loop;
    v_applied := false;
  end if;

  update public.orders set status = p_status, stock_applied = v_applied,
    archived_at = case when p_status = 'pending' then null when p_status = 'shipped' then now() else archived_at end,
    future_order_at = case when p_status = 'pending' then future_order_at else null end,
    future_order_source = case when p_status = 'pending' then future_order_source else null end,
    ready_at = case when p_status = 'ready' then coalesce(ready_at, now()) else ready_at end,
    shipped_at = case when p_status = 'shipped' then coalesce(shipped_at, now()) else shipped_at end,
    approved_at = case when p_status in ('ready', 'shipped') then coalesce(approved_at, now()) else approved_at end
  where id = p_order_id;
  return jsonb_build_object('ok', true, 'status', p_status, 'archived', p_status = 'shipped', 'missing', v_missing);
end $$;

grant execute on function public.edit_order_item(bigint, integer) to authenticated;
grant execute on function public.admin_add_order_items(uuid, jsonb) to authenticated;
grant execute on function public.set_order_status(uuid, text) to authenticated;
