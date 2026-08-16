-- בדיקת כמויות לאורח ללא חשיפת מספרי מלאי.
create or replace function public.validate_guest_cart(p_items jsonb)
returns jsonb
language plpgsql
stable
security definer set search_path = public
as $$
declare
  v_item jsonb;
  v_model text;
  v_size text;
  v_qty integer;
  v_product_id uuid;
  v_available integer;
  v_unavailable jsonb := '[]'::jsonb;
begin
  if auth.uid() is not null then
    raise exception 'בדיקת סל אורח מיועדת למשתמש שאינו מחובר';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'סל לא תקין';
  end if;
  if jsonb_array_length(p_items) > 200 then
    raise exception 'הסל מכיל יותר מדי שורות';
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_model := btrim(coalesce(v_item->>'model', ''));
    v_size := btrim(upper(coalesce(v_item->>'size', '')));
    begin
      v_qty := coalesce((v_item->>'qty')::integer, 0);
    exception when invalid_text_representation then
      v_qty := 0;
    end;

    select p.id into v_product_id
      from public.products p
     where p.is_active and lower(btrim(p.model)) = lower(v_model);
    select a.qty into v_available
      from public.get_available_inventory() a
     where a.product_id = v_product_id and a.size = v_size;

    if v_qty <= 0 or v_product_id is null or coalesce(v_available, 0) < v_qty then
      v_unavailable := v_unavailable || jsonb_build_array(
        jsonb_build_object(
          'model', v_model,
          'size', v_size,
          'qty', greatest(coalesce(v_available, 0), 0)
        )
      );
    end if;
  end loop;

  return jsonb_build_object(
    'ok', true,
    'available', jsonb_array_length(v_unavailable) = 0,
    'unavailable', v_unavailable
  );
end $$;

revoke all on function public.validate_guest_cart(jsonb) from public, authenticated;
grant execute on function public.validate_guest_cart(jsonb) to anon;
