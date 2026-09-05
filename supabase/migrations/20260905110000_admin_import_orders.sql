-- Atomically create one pending order per customer from a validated Excel import.
create or replace function public.admin_import_orders(p_orders jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order jsonb;
  v_items jsonb;
  v_name text;
  v_customer_id uuid;
  v_result jsonb;
  v_results jsonb := '[]'::jsonb;
  v_count integer := 0;
  v_units integer := 0;
begin
  if not public.is_admin() then raise exception 'אין הרשאה'; end if;
  if p_orders is null or jsonb_typeof(p_orders) <> 'array' or jsonb_array_length(p_orders) = 0 then
    raise exception 'לא נמצאו הזמנות לייבוא';
  end if;
  if jsonb_array_length(p_orders) > 200 then raise exception 'ניתן לייבא עד 200 הזמנות בכל קובץ'; end if;

  for v_order in select value from jsonb_array_elements(p_orders) loop
    v_name := nullif(btrim(coalesce(v_order->>'customer_name', '')), '');
    v_items := v_order->'items';
    if v_name is null then raise exception 'חסר שם לקוח באחת ההזמנות'; end if;
    if v_items is null or jsonb_typeof(v_items) <> 'array' or jsonb_array_length(v_items) = 0 then
      raise exception 'ההזמנה של % ריקה', v_name;
    end if;

    select c.id into v_customer_id
      from public.customers c
     where c.is_active
       and (lower(btrim(coalesce(c.business_name, ''))) = lower(v_name)
         or lower(btrim(coalesce(c.name, ''))) = lower(v_name))
     order by (lower(btrim(coalesce(c.business_name, ''))) = lower(v_name)) desc,
       (select count(*) from public.orders o where o.customer_id = c.id) desc,
       c.created_at asc
     limit 1;

    v_result := public.admin_create_order(
      v_customer_id,
      case when v_customer_id is null then jsonb_build_object('name', v_name, 'business_name', v_name) else null end,
      'נוצר מייבוא Excel',
      v_items
    );
    v_results := v_results || v_result;
    v_count := v_count + 1;
    v_units := v_units + coalesce((v_result->>'total_units')::integer, 0);
  end loop;

  return jsonb_build_object('ok', true, 'orders_created', v_count,
    'total_units', v_units, 'orders', v_results);
end;
$$;

revoke all on function public.admin_import_orders(jsonb) from public, anon;
grant execute on function public.admin_import_orders(jsonb) to authenticated;
