-- Retail stock events find the app model the same way the sync does:
-- saved Shopify link → SKU equal to the model → unique leading model code
-- ("2601-M" belongs to model "2601 סרפן קטיפה…").

create or replace function public.shopify_match_product(p_shopify_product_id bigint, p_sku_base text)
returns uuid language plpgsql stable security definer set search_path = public
as $$
declare v_product uuid;
begin
  if p_shopify_product_id is not null then
    select product_id into v_product from public.shopify_product_links
     where shopify_product_id = 'gid://shopify/Product/' || p_shopify_product_id;
    if v_product is not null then return v_product; end if;
  end if;
  if p_sku_base is null or p_sku_base = '' then return null; end if;

  select id into v_product from public.products where upper(btrim(model)) = p_sku_base limit 1;
  if v_product is not null then return v_product; end if;

  -- Leading code is used only when exactly one model starts with it.
  select min(id::text)::uuid into v_product from public.products
   where upper(substring(btrim(model) from '^([0-9]{3,6}[A-Za-z]?(?:-[0-9]+)?)\s')) = p_sku_base
  having count(*) = 1;
  return v_product;
end $$;
revoke all on function public.shopify_match_product(bigint, text) from public, anon, authenticated;

create or replace function public.apply_shopify_stock_event(
  p_event_key text, p_topic text, p_order_id bigint, p_order_name text,
  p_direction integer, p_lines jsonb, p_requires_event text default null)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  v_line jsonb;
  v_sku text;
  v_qty integer;
  v_base text;
  v_size text;
  v_product uuid;
  v_before integer;
  v_after integer;
  v_applied jsonb := '[]'::jsonb;
  v_unmatched jsonb := '[]'::jsonb;
begin
  if p_direction not in (-1, 1) then raise exception 'invalid direction'; end if;

  insert into public.shopify_stock_events(event_key, topic, shopify_order_id, order_name, direction, lines)
  values (p_event_key, p_topic, p_order_id, p_order_name, p_direction, coalesce(p_lines, '[]'::jsonb))
  on conflict (event_key) do nothing;
  if not found then return jsonb_build_object('duplicate', true); end if;

  -- A refund only restocks an order whose sale was deducted here.
  if p_requires_event is not null
     and not exists (select 1 from public.shopify_stock_events where event_key = p_requires_event) then
    update public.shopify_stock_events set skipped_reason = 'ההזמנה המקורית לא קוזזה מהמלאי'
     where event_key = p_event_key;
    return jsonb_build_object('duplicate', false, 'skipped', true);
  end if;

  for v_line in select value from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    v_sku := upper(btrim(coalesce(v_line->>'sku', '')));
    v_qty := coalesce((v_line->>'qty')::integer, 0);
    continue when v_qty <= 0;

    v_base := substring(v_sku from '^(.+)-(?:XS|S|M|L|XL|XXL|3XL|4XL|5XL)$');
    v_size := coalesce(
      substring(v_sku from '-(XS|S|M|L|XL|XXL|3XL|4XL|5XL)$'),
      nullif(upper(btrim(coalesce(v_line->>'variant_title', ''))), ''));
    if v_size not in ('XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL', '5XL') then v_size := null; end if;

    v_product := public.shopify_match_product(nullif(v_line->>'product_id', '')::bigint, v_base);
    if v_product is null or v_size is null then
      v_unmatched := v_unmatched || jsonb_build_object('sku', v_sku, 'qty', v_qty);
      continue;
    end if;

    insert into public.inventory(product_id, size, qty) values (v_product, v_size, 0)
    on conflict (product_id, size) do nothing;
    select qty into v_before from public.inventory where product_id = v_product and size = v_size for update;
    v_after := greatest(v_before + p_direction * v_qty, 0);
    update public.inventory set qty = v_after where product_id = v_product and size = v_size;

    v_applied := v_applied || jsonb_build_object(
      'sku', v_sku, 'qty', v_qty, 'before', v_before, 'after', v_after,
      'short', case when p_direction < 0 and v_before < v_qty then v_qty - v_before else 0 end);
  end loop;

  update public.shopify_stock_events set applied = v_applied, unmatched = v_unmatched
   where event_key = p_event_key;
  return jsonb_build_object('duplicate', false, 'applied', v_applied, 'unmatched', v_unmatched);
end $$;
revoke all on function public.apply_shopify_stock_event(text, text, bigint, text, integer, jsonb, text) from public, anon, authenticated;
grant execute on function public.apply_shopify_stock_event(text, text, bigint, text, integer, jsonb, text) to service_role;
