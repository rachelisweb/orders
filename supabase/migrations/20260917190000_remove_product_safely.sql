alter table public.products
  add column if not exists retired_at timestamptz;

create or replace function public.remove_product_safely(
  p_product_id uuid,
  p_confirm boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product public.products%rowtype;
  v_pending_orders integer := 0;
  v_future_orders integer := 0;
  v_ready_orders integer := 0;
  v_pending_units integer := 0;
  v_future_units integer := 0;
  v_ready_units integer := 0;
  v_shipped_orders integer := 0;
  v_invoice_blockers integer := 0;
  v_deleted_orders integer := 0;
  v_order record;
  v_stock record;
  v_mode text;
begin
  if not public.is_admin() then raise exception 'אין הרשאה'; end if;

  select * into v_product from public.products where id = p_product_id for update;
  if v_product.id is null then raise exception 'הדגם לא נמצא'; end if;

  select
    count(distinct o.id) filter (where o.status = 'pending' and o.future_order_at is null),
    count(distinct o.id) filter (where o.status = 'pending' and o.future_order_at is not null),
    count(distinct o.id) filter (where o.status = 'ready'),
    coalesce(sum(oi.qty) filter (where o.status = 'pending' and o.future_order_at is null), 0),
    coalesce(sum(oi.qty) filter (where o.status = 'pending' and o.future_order_at is not null), 0),
    coalesce(sum(oi.qty) filter (where o.status = 'ready'), 0)
  into v_pending_orders, v_future_orders, v_ready_orders,
       v_pending_units, v_future_units, v_ready_units
  from public.order_items oi
  join public.orders o on o.id = oi.order_id
  where o.archived_at is null
    and o.status in ('pending', 'ready')
    and (oi.product_id = p_product_id
      or (oi.product_id is null and oi.model = v_product.model));

  select count(distinct o.id) into v_shipped_orders
    from public.order_items oi
    join public.orders o on o.id = oi.order_id
   where o.status = 'shipped'
     and (oi.product_id = p_product_id
       or (oi.product_id is null and oi.model = v_product.model));

  select count(distinct o.id) into v_invoice_blockers
    from public.order_items oi
    join public.orders o on o.id = oi.order_id
   where o.archived_at is null
     and o.status in ('pending', 'ready')
     and (oi.product_id = p_product_id
       or (oi.product_id is null and oi.model = v_product.model))
     and exists (
       select 1 from public.invoices i
        where i.order_id = o.id and coalesce(i.status, 'active') <> 'cancelled'
     );

  v_mode := case when v_shipped_orders > 0 then 'retired' else 'deleted' end;
  if not p_confirm then
    return jsonb_build_object(
      'model', v_product.model,
      'pending_orders', v_pending_orders,
      'future_orders', v_future_orders,
      'ready_orders', v_ready_orders,
      'pending_units', v_pending_units,
      'future_units', v_future_units,
      'ready_units', v_ready_units,
      'shipped_orders', v_shipped_orders,
      'invoice_blockers', v_invoice_blockers,
      'mode', v_mode
    );
  end if;

  if v_invoice_blockers > 0 then
    raise exception 'לא ניתן להסיר את הדגם: קיימת חשבונית פעילה ב-% הזמנות שיושפעו', v_invoice_blockers;
  end if;

  for v_order in
    select o.id
      from public.orders o
     where o.archived_at is null
       and o.status in ('pending', 'ready')
       and exists (
         select 1 from public.order_items oi
          where oi.order_id = o.id
            and (oi.product_id = p_product_id
              or (oi.product_id is null and oi.model = v_product.model))
       )
     for update of o
  loop
    delete from public.order_items
     where order_id = v_order.id
       and (product_id = p_product_id
         or (product_id is null and model = v_product.model));

    update public.orders
       set checked_models = array_remove(checked_models, v_product.model),
           model_order = array_remove(model_order, v_product.model)
     where id = v_order.id;

    if exists (select 1 from public.order_items where order_id = v_order.id and qty > 0) then
      perform public.recalc_order(v_order.id);
    else
      delete from public.orders where id = v_order.id;
      v_deleted_orders := v_deleted_orders + 1;
    end if;
  end loop;

  for v_stock in
    select size, qty from public.inventory where product_id = p_product_id and qty <> 0
  loop
    insert into public.stock_log (product_id, model, size, delta, reason, actor)
    values (p_product_id, v_product.model, v_stock.size, -v_stock.qty, 'product_removed', auth.uid());
  end loop;
  delete from public.inventory where product_id = p_product_id;
  delete from public.demand_customer_orders where model = v_product.model;

  if v_mode = 'retired' then
    update public.products
       set is_active = false, retired_at = now(), updated_at = now()
     where id = p_product_id;
  else
    delete from public.products where id = p_product_id;
  end if;

  return jsonb_build_object(
    'model', v_product.model,
    'mode', v_mode,
    'pending_orders', v_pending_orders,
    'future_orders', v_future_orders,
    'ready_orders', v_ready_orders,
    'removed_units', v_pending_units + v_future_units + v_ready_units,
    'shipped_orders', v_shipped_orders,
    'deleted_orders', v_deleted_orders
  );
end;
$$;

revoke all on function public.remove_product_safely(uuid, boolean) from public;
grant execute on function public.remove_product_safely(uuid, boolean) to authenticated;
