-- Allow final quantity corrections on ready, uninvoiced orders and keep inventory in sync.
create or replace function public.edit_ready_order_item(p_item_id bigint, p_qty integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item public.order_items%rowtype;
  v_order public.orders%rowtype;
  v_stock integer;
  v_reserved integer;
  v_available integer;
  v_inventory_delta integer;
begin
  if not public.is_admin() then raise exception 'אין הרשאה'; end if;
  if p_qty is null or p_qty < 0 then raise exception 'הכמות חייבת להיות 0 או יותר'; end if;

  select * into v_item from public.order_items where id = p_item_id for update;
  if v_item.id is null then raise exception 'השורה לא נמצאה'; end if;

  select * into v_order from public.orders where id = v_item.order_id for update;
  if v_order.status <> 'ready' or not v_order.stock_applied or v_order.archived_at is not null then
    raise exception 'ניתן לערוך כמויות סופיות רק בהזמנה מוכנה';
  end if;
  if exists (select 1 from public.invoices i where i.order_id = v_order.id and coalesce(i.status, 'active') <> 'cancelled') then
    raise exception 'לא ניתן לשנות כמויות לאחר הפקת חשבונית';
  end if;
  if p_qty = v_item.qty then
    return jsonb_build_object('ok', true, 'unchanged', true, 'lines_left', 1);
  end if;

  select qty into v_stock from public.inventory
   where product_id = v_item.product_id and size = v_item.size for update;
  if v_stock is null then raise exception 'לא נמצאה שורת מלאי לדגם % מידה %', v_item.model, v_item.size; end if;

  if p_qty > v_item.qty then
    select coalesce(sum(oi.qty), 0)::integer into v_reserved
      from public.order_items oi
      join public.orders o on o.id = oi.order_id
     where oi.product_id = v_item.product_id and oi.size = v_item.size
       and o.status = 'pending' and not o.stock_applied and o.future_order_at is null and oi.qty > 0;
    v_available := greatest(v_stock - coalesce(v_reserved, 0), 0);
    if p_qty - v_item.qty > v_available then
      raise exception 'ניתן להוסיף עד % יחידות לדגם % מידה %, לפי המלאי הזמין', v_available, v_item.model, v_item.size;
    end if;
  end if;

  v_inventory_delta := v_item.qty - p_qty;
  update public.inventory set qty = qty + v_inventory_delta, updated_at = now()
   where product_id = v_item.product_id and size = v_item.size;
  update public.order_items set qty = p_qty where id = p_item_id;
  insert into public.stock_log (product_id, model, size, delta, reason, ref_id, actor)
  values (v_item.product_id, v_item.model, v_item.size, v_inventory_delta,
    'order_ready_quantity_edit', v_order.id, auth.uid());

  perform public.recalc_order(v_order.id);
  return jsonb_build_object('ok', true,
    'lines_left', (select count(*) from public.order_items where order_id = v_order.id),
    'positive_lines', (select count(*) from public.order_items where order_id = v_order.id and qty > 0),
    'inventory_delta', v_inventory_delta);
end;
$$;

revoke all on function public.edit_ready_order_item(bigint, integer) from public, anon;
grant execute on function public.edit_ready_order_item(bigint, integer) to authenticated;
