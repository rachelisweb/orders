-- The shared recalc_order helper requires an interactive admin session.
-- Keep this service-role import atomic by applying the same totals formula here.

create or replace function public.import_future_orders(
  p_import_key text,
  p_orders jsonb
)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_marker text;
  v_order_json jsonb;
  v_item_json jsonb;
  v_customer public.customers%rowtype;
  v_product public.products%rowtype;
  v_customer_id uuid;
  v_order_id uuid;
  v_order_no bigint;
  v_model text;
  v_size text;
  v_qty integer;
  v_price numeric(10,2);
  v_cost_mode boolean;
  v_discount numeric(5,2);
  v_discount_amount numeric(12,2);
  v_order_subtotal numeric(12,2);
  v_order_total numeric(12,2);
  v_order_units integer;
  v_total_units integer := 0;
  v_created integer := 0;
  v_product_count integer;
  v_result jsonb := '[]'::jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service_role בלבד';
  end if;
  if nullif(btrim(coalesce(p_import_key, '')), '') is null then
    raise exception 'חסר מזהה ייבוא';
  end if;
  if p_orders is null or jsonb_typeof(p_orders) <> 'array' then
    raise exception 'נתוני ההזמנות אינם מערך';
  end if;
  if jsonb_array_length(p_orders) <> 10 then
    raise exception 'הייבוא אמור להכיל 10 הזמנות, התקבלו %', jsonb_array_length(p_orders);
  end if;

  v_marker := format('ייבוא חורף 2026-08-18 [%s]', btrim(p_import_key));
  if exists (select 1 from public.orders where notes = v_marker) then
    return jsonb_build_object(
      'ok', true,
      'already_imported', true,
      'orders', (select count(*) from public.orders where notes = v_marker),
      'total_units', (
        select coalesce(sum(o.total_units), 0)
        from public.orders o
        where o.notes = v_marker
      )
    );
  end if;

  for v_order_json in select value from jsonb_array_elements(p_orders)
  loop
    v_customer_id := (v_order_json->>'customer_id')::uuid;
    select * into v_customer
      from public.customers
     where id = v_customer_id and is_active
     for update;
    if v_customer.id is null then
      raise exception 'הלקוח % לא נמצא או אינו פעיל', v_order_json->>'source_name';
    end if;

    v_cost_mode := coalesce(v_customer.price_at_cost, false);
    v_discount := case when v_cost_mode then 0 else coalesce(v_customer.discount_pct, 0) end;

    insert into public.orders (
      customer_id, user_id, contact_name, phone, email, notes, source, status,
      pricing_mode, discount_type, discount_value, future_order_at, future_order_source
    ) values (
      v_customer.id,
      null,
      coalesce(nullif(btrim(v_customer.name), ''), nullif(btrim(v_customer.business_name), ''), 'לקוח'),
      v_customer.phone,
      v_customer.email,
      v_marker,
      'manual',
      'pending',
      case when v_cost_mode then 'cost' else 'wholesale' end,
      case when v_discount > 0 then 'pct' else null end,
      v_discount,
      now(),
      'manual'
    ) returning id, order_number into v_order_id, v_order_no;

    v_order_units := 0;
    v_order_subtotal := 0;
    for v_item_json in select value from jsonb_array_elements(v_order_json->'items')
    loop
      v_model := btrim(v_item_json->>'model');
      v_size := upper(btrim(v_item_json->>'size'));
      v_qty := coalesce((v_item_json->>'qty')::integer, 0);
      if v_qty <= 0 then continue; end if;

      select count(*) into v_product_count
        from public.products p
       where lower(btrim(p.model)) = lower(v_model);
      if v_product_count <> 1 then
        raise exception 'לדגם % נמצאו % התאמות במקום אחת', v_model, v_product_count;
      end if;

      select * into v_product
        from public.products p
       where lower(btrim(p.model)) = lower(v_model);
      v_price := case
        when v_cost_mode then coalesce(v_product.cost_price, 0)
        else coalesce(v_product.wholesale_price, 0)
      end;

      insert into public.order_items (
        order_id, product_id, model, size, qty, qty_ordered, unit_price
      ) values (
        v_order_id, v_product.id, v_product.model, v_size, v_qty, v_qty, v_price
      );
      v_order_units := v_order_units + v_qty;
      v_order_subtotal := v_order_subtotal + (v_qty * v_price);
    end loop;

    if v_order_units <= 0 then
      raise exception 'ההזמנה של % ריקה', v_order_json->>'source_name';
    end if;
    v_discount_amount := round(v_order_subtotal * v_discount / 100.0, 2);
    v_order_total := greatest(v_order_subtotal - v_discount_amount, 0);
    update public.orders
       set total_units = v_order_units,
           subtotal_amount = v_order_subtotal,
           discount_amount = v_discount_amount,
           total_amount = v_order_total
     where id = v_order_id;

    v_total_units := v_total_units + v_order_units;
    v_created := v_created + 1;
    v_result := v_result || jsonb_build_array(jsonb_build_object(
      'order_id', v_order_id,
      'order_number', v_order_no,
      'source_name', v_order_json->>'source_name',
      'total_units', v_order_units
    ));
  end loop;

  if v_created <> 10 or v_total_units <> 3215 then
    raise exception 'בדיקת סיכום נכשלה: % הזמנות, % יחידות', v_created, v_total_units;
  end if;

  return jsonb_build_object(
    'ok', true,
    'already_imported', false,
    'orders', v_created,
    'total_units', v_total_units,
    'created_orders', v_result
  );
end $$;

revoke all on function public.import_future_orders(text, jsonb) from public, anon, authenticated;
grant execute on function public.import_future_orders(text, jsonb) to service_role;
