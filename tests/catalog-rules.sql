-- Run against a database with the catalog migration applied. All changes roll back.
begin;
do $$
declare
  v_col uuid; v_other uuid; v_product uuid; v_qty bigint; v_result jsonb;
  v_src uuid; v_tgt uuid; v_customer public.customers%rowtype; v_denied boolean := false;
begin
  perform set_config('request.jwt.claim.sub', (select id::text from public.profiles where role = 'admin' limit 1), true);
  select id into v_col from public.collections where is_active order by sort_order limit 1;
  select id into v_other from public.collections where is_active and id <> v_col limit 1;
  perform public.set_catalog_preferences('all', null);
  assert public.get_catalog_preferences()->>'mode' = 'all', 'all preference failed';
  assert public.catalog_collection_visible(null), 'all should include unassigned products';
  perform public.set_catalog_preferences('single', v_col);
  assert public.catalog_collection_visible(v_col), 'selected collection hidden';
  assert not public.catalog_collection_visible(v_other), 'unselected collection visible';
  v_result := public.get_guest_catalog();
  assert not exists(select 1 from jsonb_array_elements(v_result->'products') p where p->>'collection_id' <> v_col::text), 'guest products leaked';
  assert not exists(select 1 from jsonb_array_elements(v_result->'inventory') i where i ? 'qty'), 'guest quantities leaked';
  select id into v_product from public.products where retired_at is null limit 1;
  select sum(qty) into v_qty from public.inventory where product_id = v_product;
  perform public.move_products_to_collection(v_col, array[v_product]);
  assert (select collection_id = v_col from public.products where id = v_product), 'move failed';
  assert (select sum(qty) from public.inventory where product_id = v_product) is not distinct from v_qty, 'move changed stock';
  begin
    perform public.move_products_to_collection(v_col, array[v_product, '00000000-0000-4000-8000-000000000000'::uuid]);
    raise exception 'missing product was accepted';
  exception when raise_exception then
    if sqlerrm = 'missing product was accepted' then raise; end if;
  end;
  assert public.normalize_customer_phones(array['050-1234567', '+972 50 1234567', '00972501234567', '0507654321']) = array['0501234567','0507654321'], 'phone dedup failed';
  insert into public.customers(name, business_name, phone, phone_numbers, email, email_recipients)
    values('catalog-test-source-' || gen_random_uuid(), 'catalog-test-source-' || gen_random_uuid(), '+972 50 1234567', array['050-1234567'],
    'TEST@example.com', array['test@example.com', 'other@example.com']) returning id into v_src;
  insert into public.customers(name, business_name, phone, phone_numbers, email, email_recipients)
    values('catalog-test-target-' || gen_random_uuid(), 'catalog-test-target-' || gen_random_uuid(), '0501234567', array['0501234567','0507654321'],
    'test@example.com', array['TEST@example.com']) returning id into v_tgt;
  perform public.merge_customers(v_src, v_tgt);
  select * into v_customer from public.customers where id = v_tgt;
  assert cardinality(v_customer.phone_numbers) = 2, 'merge retained duplicate phones';
  assert cardinality(v_customer.email_recipients) = 2, 'merge retained duplicate emails or lost different email';
  perform set_config('request.jwt.claim.sub', '', true);
  begin perform public.set_catalog_preferences('all', null);
  exception when raise_exception then v_denied := true; end;
  assert v_denied, 'non-admin could change preferences';
end $$;

rollback;
