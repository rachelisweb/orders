-- הזמנה ללא חשבון. הפונקציה חושפת לאורח רק את פעולת יצירת ההזמנה,
-- וכל בדיקות המלאי והמחיר מתבצעות בצד השרת.
alter table public.orders
  add column if not exists guest_notification_token uuid;

create or replace function public.get_guest_catalog()
returns jsonb
language sql
stable
security definer set search_path = public
as $$
  select jsonb_build_object(
    'collections', coalesce((
      select jsonb_agg(to_jsonb(c) order by c.sort_order)
        from public.collections c where c.is_active
    ), '[]'::jsonb),
    'products', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'model', p.model, 'description', p.description,
        'image_url', p.image_url, 'sort_order', p.sort_order,
        'collection_id', p.collection_id
      ) order by p.sort_order)
        from public.products p where p.is_active
    ), '[]'::jsonb),
    'inventory', coalesce((
      select jsonb_agg(jsonb_build_object(
        'product_id', a.product_id, 'size', a.size, 'qty', a.qty
      )) from public.get_available_inventory() a where a.qty > 0
    ), '[]'::jsonb)
  )
$$;

revoke all on function public.get_guest_catalog() from public, authenticated;
grant execute on function public.get_guest_catalog() to anon;

create or replace function public.create_guest_order(
  p_business_name text,
  p_phone         text,
  p_email         text,
  p_notes         text,
  p_items         jsonb
)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_business    text := nullif(btrim(coalesce(p_business_name, '')), '');
  v_phone       text := nullif(btrim(coalesce(p_phone, '')), '');
  v_email       text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_customer_id uuid;
  v_duplicate   uuid;
  v_order_id    uuid;
  v_order_no    bigint;
  v_notification_token uuid := gen_random_uuid();
  v_item        jsonb;
  v_product     record;
  v_qty         integer;
  v_size        text;
  v_model       text;
  v_avail       integer;
  v_units       integer := 0;
  v_subtotal    numeric(12,2) := 0;
  v_price       numeric(10,2);
begin
  if auth.uid() is not null then
    raise exception 'הזמנת אורח מיועדת למשתמש שאינו מחובר';
  end if;
  if v_business is null then raise exception 'יש למלא שם העסק'; end if;
  if length(v_business) > 160 then raise exception 'שם העסק ארוך מדי'; end if;
  if v_email is not null and v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'כתובת האימייל אינה תקינה';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'ההזמנה ריקה';
  end if;
  if jsonb_array_length(p_items) > 200 then raise exception 'ההזמנה מכילה יותר מדי שורות'; end if;

  select c.id into v_duplicate
    from public.customers c
   where c.business_name is not null and lower(btrim(c.business_name)) = lower(v_business)
   order by (select count(*) from public.orders o where o.customer_id = c.id) desc,
            c.created_at asc
   limit 1;

  insert into public.customers
    (name, business_name, phone, email, email_recipients)
  values
    (v_business, v_business, v_phone, v_email,
     case when v_email is null then '{}'::text[] else array[v_email] end)
  returning id into v_customer_id;

  if v_duplicate is not null then
    update public.customers
       set duplicate_candidate_id = v_duplicate, duplicate_status = 'pending'
     where id = v_customer_id;
  end if;

  insert into public.orders
    (customer_id, user_id, contact_name, phone, email, notes, source, pricing_mode,
     discount_type, discount_value, guest_notification_token)
  values
    (v_customer_id, null, v_business, v_phone, v_email,
     nullif(btrim(coalesce(p_notes, '')), ''), 'guest', 'wholesale', null, 0,
     v_notification_token)
  returning id, order_number into v_order_id, v_order_no;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_model := btrim(coalesce(v_item->>'model', ''));
    v_size := btrim(upper(coalesce(v_item->>'size', '')));
    begin
      v_qty := coalesce((v_item->>'qty')::integer, 0);
    exception when invalid_text_representation then
      raise exception 'כמות לא תקינה';
    end;
    if v_qty <= 0 then continue; end if;

    select p.id, p.model, p.wholesale_price, p.is_active
      into v_product
      from public.products p
     where lower(btrim(p.model)) = lower(v_model);
    if v_product.id is null then raise exception 'דגם % לא נמצא במערכת', v_model; end if;
    if not v_product.is_active then raise exception 'דגם % אינו זמין להזמנה', v_model; end if;

    select qty into v_avail from public.inventory
     where product_id = v_product.id and size = v_size for update;
    if v_avail is null then raise exception 'דגם % מידה % אינו קיים במלאי', v_model, v_size; end if;
    if v_qty > v_avail then
      raise exception 'דגם % מידה %: ביקשת % אך יש רק % במלאי', v_model, v_size, v_qty, v_avail;
    end if;

    v_price := v_product.wholesale_price;
    insert into public.order_items (order_id, product_id, model, size, qty, qty_ordered, unit_price)
    values (v_order_id, v_product.id, v_product.model, v_size, v_qty, v_qty, v_price);
    v_units := v_units + v_qty;
    v_subtotal := v_subtotal + (v_qty * v_price);
  end loop;

  if v_units = 0 then raise exception 'ההזמנה ריקה'; end if;
  update public.orders
     set total_units = v_units, subtotal_amount = v_subtotal,
         discount_amount = 0, total_amount = v_subtotal
   where id = v_order_id;
  perform public.refresh_future_order_classification(v_order_id);

  return jsonb_build_object('ok', true, 'order_id', v_order_id,
    'order_number', v_order_no, 'total_units', v_units, 'total_amount', v_subtotal,
    'notification_token', v_notification_token);
end $$;

revoke all on function public.create_guest_order(text, text, text, text, jsonb) from public, authenticated;
grant execute on function public.create_guest_order(text, text, text, text, jsonb) to anon;
