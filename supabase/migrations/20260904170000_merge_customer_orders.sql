-- Merge multiple orders for one customer while they are in the same open workflow stage.
create or replace function public.merge_customer_orders(p_order_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_primary public.orders%rowtype;
  v_order public.orders%rowtype;
  v_item public.order_items%rowtype;
  v_count integer;
  v_discount numeric(12,2) := 0;
  v_checked text[] := '{}'::text[];
begin
  if not public.is_admin() then raise exception 'אין הרשאה'; end if;

  select count(*) into v_count from public.orders
   where id = any(coalesce(p_order_ids, '{}'::uuid[]));

  if v_count < 2 or v_count <> cardinality(coalesce(p_order_ids, '{}'::uuid[])) then
    raise exception 'יש לבחור לפחות שתי הזמנות תקינות';
  end if;
  perform 1 from public.orders where id = any(p_order_ids) for update;
  select * into v_primary from public.orders
   where id = any(p_order_ids) order by order_number limit 1;

  for v_order in select * from public.orders where id = any(p_order_ids) order by order_number loop
    if v_order.customer_id is distinct from v_primary.customer_id
       or v_order.status <> v_primary.status
       or v_order.stock_applied <> v_primary.stock_applied
       or v_order.future_order_at is not null
       or v_order.archived_at is not null then
      raise exception 'ניתן למזג רק הזמנות פתוחות של אותו לקוח ובאותו סטטוס';
    end if;
    if v_order.status not in ('pending', 'ready') then
      raise exception 'ניתן למזג רק הזמנות ממתינות או ממתינות לחשבונית';
    end if;
    if exists (select 1 from public.invoices i where i.order_id = v_order.id and i.status <> 'cancelled') then
      raise exception 'לא ניתן למזג הזמנה שכבר קיימת עבורה חשבונית';
    end if;

    v_discount := v_discount + coalesce(v_order.discount_amount, 0);
    v_checked := array(select distinct x from unnest(v_checked || coalesce(v_order.checked_models, '{}'::text[])) x);
  end loop;

  for v_order in select * from public.orders
   where id = any(p_order_ids) and id <> v_primary.id order by order_number loop
    for v_item in select * from public.order_items where order_id = v_order.id order by id for update loop
      update public.order_items
         set qty = qty + v_item.qty,
             qty_ordered = qty_ordered + v_item.qty_ordered
       where order_id = v_primary.id
         and model = v_item.model
         and size = v_item.size
         and unit_price = v_item.unit_price
         and product_id is not distinct from v_item.product_id;
      if found then
        delete from public.order_items where id = v_item.id;
      else
        update public.order_items set order_id = v_primary.id where id = v_item.id;
      end if;
    end loop;

    delete from public.orders where id = v_order.id;
  end loop;

  update public.orders
     set discount_type = case when v_discount > 0 then 'amt' else discount_type end,
         discount_value = case when v_discount > 0 then v_discount else discount_value end,
         checked_models = v_checked,
         notes = concat_ws(E'\n\n', nullif(btrim(notes), ''), 'מוזגו הזמנות')
   where id = v_primary.id;

  perform public.recalc_order(v_primary.id);
  select * into v_primary from public.orders where id = v_primary.id;
  return jsonb_build_object('ok', true, 'order_id', v_primary.id,
    'order_number', v_primary.order_number, 'total_units', v_primary.total_units);
end;
$$;

revoke all on function public.merge_customer_orders(uuid[]) from public;
grant execute on function public.merge_customer_orders(uuid[]) to authenticated;
