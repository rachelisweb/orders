-- Customer-facing order flows still require products to be active. Manual
-- admin orders may also include hidden products, provided stock is available.

create or replace function public.admin_create_order(
  p_customer_id uuid,
  p_customer    jsonb,
  p_notes       text,
  p_items       jsonb
)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_customer    record;
  v_customer_id uuid;
  v_created     boolean := false;
  v_order_id    uuid;
  v_order_no    bigint;
  v_item        jsonb;
  v_product     record;
  v_qty         integer;
  v_size        text;
  v_model       text;
  v_avail       integer;
  v_units       integer := 0;
  v_subtotal    numeric(12,2) := 0;
  v_total       numeric(12,2) := 0;
  v_price       numeric(10,2);
  v_discount    numeric(5,2) := 0;
  v_discount_amount numeric(12,2) := 0;
  v_cost_mode   boolean := false;
  v_name        text;
  v_business    text;
  v_duplicate   uuid;
begin
  if not public.is_admin() then raise exception 'אין הרשאה — יצירת הזמנה ידנית מותרת למנהל בלבד'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'ההזמנה ריקה'; end if;

  if p_customer_id is not null then
    select * into v_customer from public.customers where id = p_customer_id and is_active;
    if v_customer.id is null then raise exception 'הלקוח שנבחר לא נמצא או אינו פעיל'; end if;
    v_customer_id := v_customer.id;
  else
    if p_customer is null or jsonb_typeof(p_customer) <> 'object' then raise exception 'יש לבחור לקוח קיים או להזין לקוח חדש'; end if;
    v_name := nullif(btrim(coalesce(p_customer->>'name', '')), '');
    v_business := nullif(btrim(coalesce(p_customer->>'business_name', '')), '');
    if v_name is null then raise exception 'חסר שם לקוח'; end if;
    insert into public.customers (name, business_name, phone, email, city)
    values (v_name, v_business, nullif(btrim(coalesce(p_customer->>'phone','')),''),
      nullif(btrim(coalesce(p_customer->>'email','')),''), nullif(btrim(coalesce(p_customer->>'city','')),''))
    returning * into v_customer;
    v_customer_id := v_customer.id;
    v_created := true;

    if v_business is not null then
      select c.id into v_duplicate from public.customers c
       where c.id <> v_customer_id and c.business_name is not null
         and lower(btrim(c.business_name)) = lower(v_business)
       order by (select count(*) from public.orders o where o.customer_id = c.id) desc, c.created_at asc limit 1;
      if v_duplicate is not null then
        update public.customers set duplicate_candidate_id = v_duplicate, duplicate_status = 'pending'
         where id = v_customer_id;
      end if;
    end if;
  end if;

  v_cost_mode := coalesce(v_customer.price_at_cost, false);
  v_discount := case when v_cost_mode then 0 else coalesce(v_customer.discount_pct, 0) end;

  insert into public.orders
    (customer_id, user_id, contact_name, phone, email, notes, source, pricing_mode,
     discount_type, discount_value)
  values (v_customer_id, null, coalesce(nullif(btrim(v_customer.name), ''), nullif(btrim(v_customer.business_name), ''), 'לקוח'),
    v_customer.phone, v_customer.email, nullif(btrim(coalesce(p_notes, '')), ''), 'manual',
    case when v_cost_mode then 'cost' else 'wholesale' end,
    case when v_discount > 0 then 'pct' else null end, v_discount)
  returning id, order_number into v_order_id, v_order_no;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_model := btrim(v_item->>'model'); v_size := btrim(upper(v_item->>'size'));
    v_qty := coalesce((v_item->>'qty')::integer, 0); if v_qty <= 0 then continue; end if;
    select p.id, p.model, p.wholesale_price, p.cost_price into v_product
      from public.products p where lower(btrim(p.model)) = lower(v_model);
    if v_product.id is null then raise exception 'דגם % לא נמצא במערכת', v_model; end if;
    select qty into v_avail from public.get_available_inventory()
      where product_id = v_product.id and size = v_size;
    if v_avail is null then raise exception 'דגם % מידה % אינו קיים במלאי', v_model, v_size; end if;
    if v_qty > v_avail then raise exception 'דגם % מידה %: ביקשת % אך יש רק % במלאי', v_model, v_size, v_qty, v_avail; end if;
    v_price := coalesce(case when v_cost_mode then v_product.cost_price else v_product.wholesale_price end, 0);
    insert into public.order_items (order_id, product_id, model, size, qty, qty_ordered, unit_price)
    values (v_order_id, v_product.id, v_product.model, v_size, v_qty, v_qty, v_price);
    v_units := v_units + v_qty; v_subtotal := v_subtotal + (v_qty * v_price);
  end loop;

  if v_units = 0 then raise exception 'ההזמנה ריקה'; end if;
  v_discount_amount := round(v_subtotal * v_discount / 100.0, 2);
  v_total := greatest(v_subtotal - v_discount_amount, 0);
  update public.orders set total_units = v_units, subtotal_amount = v_subtotal,
    discount_amount = v_discount_amount, total_amount = v_total where id = v_order_id;
  perform public.refresh_future_order_classification(v_order_id);

  return jsonb_build_object('ok', true, 'order_id', v_order_id, 'order_number', v_order_no,
    'customer_id', v_customer_id, 'customer_created', v_created,
    'duplicate_pending', v_duplicate is not null, 'total_units', v_units, 'total_amount', v_total);
end $$;

grant execute on function public.admin_create_order(uuid, jsonb, text, jsonb) to authenticated;

-- Fill only previously-missing cost prices in open, uninvoiced cost orders.
-- Existing positive/custom prices and closed orders are deliberately untouched.
create or replace function public.sync_missing_order_cost_price()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_order_id uuid;
begin
  if coalesce(new.cost_price, 0) <= 0
     or coalesce(new.cost_price, 0) = coalesce(old.cost_price, 0) then
    return new;
  end if;

  for v_order_id in
    select o.id
      from public.orders o
     where o.pricing_mode = 'cost'
       and o.status in ('pending', 'ready')
       and o.archived_at is null
       and exists (
         select 1 from public.order_items oi
          where oi.order_id = o.id
            and oi.product_id = new.id
            and coalesce(oi.unit_price, 0) <= 0
       )
       and not exists (
         select 1 from public.invoices i
          where i.order_id = o.id
            and coalesce(i.status, 'active') <> 'cancelled'
       )
     for update of o
  loop
    update public.order_items
       set unit_price = new.cost_price
     where order_id = v_order_id
       and product_id = new.id
       and coalesce(unit_price, 0) <= 0;
    perform public.recalc_order(v_order_id);
  end loop;

  return new;
end $$;

drop trigger if exists products_sync_missing_order_cost_price on public.products;
create trigger products_sync_missing_order_cost_price
after update of cost_price on public.products
for each row execute function public.sync_missing_order_cost_price();
