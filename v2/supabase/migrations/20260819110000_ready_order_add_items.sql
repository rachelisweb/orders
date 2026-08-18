-- Allow admins to add stock-backed items to an active ready order.
-- Ready-order additions are deducted immediately and atomically from inventory.

create or replace function public.admin_add_order_items(
  p_order_id uuid,
  p_items    jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order        record;
  v_item         jsonb;
  v_product      record;
  v_existing     record;
  v_model        text;
  v_size         text;
  v_qty          integer;
  v_stock        integer;
  v_reserved     integer;
  v_available    integer;
  v_price        numeric(10,2);
  v_added        integer := 0;
  v_ready        boolean := false;
begin
  if not public.is_admin() then raise exception 'אין הרשאה'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 500 then
    raise exception 'יש לבחור לפחות מידה אחת';
  end if;

  select id, status, stock_applied, pricing_mode, archived_at
    into v_order
    from public.orders
   where id = p_order_id
   for update;
  if v_order.id is null then raise exception 'ההזמנה לא נמצאה'; end if;

  v_ready := v_order.status = 'ready' and v_order.stock_applied and v_order.archived_at is null;
  if not ((v_order.status = 'pending' and not v_order.stock_applied) or v_ready) then
    raise exception 'ניתן להוסיף פריטים רק להזמנה ממתינה או מוכנה לאיסוף';
  end if;
  if v_ready and exists (
    select 1 from public.invoices i
     where i.order_id = p_order_id and coalesce(i.status, 'active') <> 'cancelled'
  ) then
    raise exception 'לא ניתן להוסיף פריטים לאחר שנשמר מסמך להזמנה';
  end if;

  for v_item in select value from jsonb_array_elements(p_items) loop
    v_model := btrim(coalesce(v_item->>'model', ''));
    v_size := btrim(upper(coalesce(v_item->>'size', '')));
    begin
      v_qty := (v_item->>'qty')::integer;
    exception when others then
      raise exception 'כמות לא תקינה לדגם % מידה %', coalesce(nullif(v_model, ''), 'לא ידוע'), coalesce(nullif(v_size, ''), 'לא ידועה');
    end;
    if v_model = '' or v_size = '' or v_qty is null or v_qty <= 0 or v_qty > 100000 then
      raise exception 'כמות לא תקינה לדגם % מידה %', coalesce(nullif(v_model, ''), 'לא ידוע'), coalesce(nullif(v_size, ''), 'לא ידועה');
    end if;

    select p.id, p.model, p.wholesale_price, p.cost_price, p.is_active
      into v_product
      from public.products p
     where lower(btrim(p.model)) = lower(v_model);
    if v_product.id is null then raise exception 'דגם % לא נמצא במערכת', v_model; end if;
    if not v_product.is_active then raise exception 'דגם % אינו זמין להזמנה', v_model; end if;

    select i.qty
      into v_stock
      from public.inventory i
     where i.product_id = v_product.id and i.size = v_size
     for update;
    if v_stock is null then raise exception 'דגם % מידה % אינו קיים במלאי', v_model, v_size; end if;

    select coalesce(sum(oi.qty), 0)::integer
      into v_reserved
      from public.order_items oi
      join public.orders o on o.id = oi.order_id
      join public.products p on p.id = oi.product_id
      left join public.future_order_collections fc on fc.collection_id = p.collection_id
     where oi.product_id = v_product.id
       and oi.size = v_size
       and o.status = 'pending'
       and not o.stock_applied
       and o.future_order_at is null
       and fc.collection_id is null
       and oi.qty > 0;
    v_available := greatest(v_stock - coalesce(v_reserved, 0), 0);
    if v_qty > v_available then
      raise exception 'דגם % מידה %: ניתן להוסיף עד %, לפי המלאי הזמין', v_model, v_size, v_available;
    end if;

    select oi.id, oi.qty, oi.qty_ordered, oi.unit_price
      into v_existing
      from public.order_items oi
     where oi.order_id = p_order_id
       and oi.product_id = v_product.id
       and oi.size = v_size
     order by oi.id
     limit 1
     for update;

    if v_existing.id is not null then
      v_price := v_existing.unit_price;
      update public.order_items
         set qty = qty + v_qty,
             qty_ordered = coalesce(qty_ordered, qty) + v_qty
       where id = v_existing.id;
    else
      select oi.unit_price
        into v_price
        from public.order_items oi
       where oi.order_id = p_order_id
         and lower(btrim(oi.model)) = lower(v_product.model)
         and oi.unit_price > 0
       order by oi.id
       limit 1;
      if v_price is null then
        v_price := case when v_order.pricing_mode = 'cost'
          then v_product.cost_price else v_product.wholesale_price end;
      end if;
      if coalesce(v_price, 0) <= 0 then
        raise exception 'לדגם % לא הוגדר מחיר', v_model;
      end if;
      insert into public.order_items (order_id, product_id, model, size, qty, qty_ordered, unit_price)
      values (p_order_id, v_product.id, v_product.model, v_size, v_qty, v_qty, v_price);
    end if;

    if v_ready then
      update public.inventory
         set qty = qty - v_qty, updated_at = now()
       where product_id = v_product.id and size = v_size;
      insert into public.stock_log (product_id, model, size, delta, reason, ref_id, actor)
      values (v_product.id, v_product.model, v_size, -v_qty, 'order_ready_addition', p_order_id, auth.uid());
    end if;
    v_added := v_added + v_qty;
  end loop;

  if v_added = 0 then raise exception 'יש לבחור לפחות מידה אחת'; end if;
  perform public.recalc_order(p_order_id);
  return jsonb_build_object('ok', true, 'added_units', v_added, 'stock_deducted', v_ready);
end;
$$;

revoke all on function public.admin_add_order_items(uuid, jsonb) from public, anon;
grant execute on function public.admin_add_order_items(uuid, jsonb) to authenticated;
