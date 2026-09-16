-- Keep the broad repricing rule: pending, ready for shipment, and legacy
-- shipped orders still awaiting an invoice. Archived or invoiced orders remain immutable.

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
       and o.status in ('pending', 'ready', 'shipped')
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

grant execute on function public.admin_update_customer(uuid, jsonb) to authenticated;
