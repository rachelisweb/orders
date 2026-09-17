-- Rename a product model everywhere its denormalized label is stored.
-- Inventory and order quantities, prices, images, and product IDs are untouched.
create or replace function public.rename_product_model(
  p_product_id uuid,
  p_new_model text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old_model text;
  v_new_model text := btrim(coalesce(p_new_model, ''));
  v_order_items integer := 0;
  v_return_items integer := 0;
  v_stock_log integer := 0;
begin
  if not public.is_admin() then raise exception 'אין הרשאה'; end if;
  if v_new_model = '' then raise exception 'חסר מספר דגם'; end if;

  select model into v_old_model
    from public.products
   where id = p_product_id
   for update;
  if v_old_model is null then raise exception 'הדגם לא נמצא'; end if;
  if v_old_model = v_new_model then
    return jsonb_build_object('old_model', v_old_model, 'new_model', v_new_model,
      'order_items', 0, 'return_items', 0, 'stock_log', 0);
  end if;
  if exists (
    select 1 from public.products
     where id <> p_product_id and lower(btrim(model)) = lower(v_new_model)
  ) then raise exception 'מספר הדגם כבר קיים במערכת'; end if;

  update public.products set model = v_new_model where id = p_product_id;

  update public.order_items set model = v_new_model
   where product_id = p_product_id
      or (product_id is null and model = v_old_model);
  get diagnostics v_order_items = row_count;

  update public.return_items set model = v_new_model
   where product_id = p_product_id
      or (product_id is null and model = v_old_model);
  get diagnostics v_return_items = row_count;

  update public.stock_log set model = v_new_model
   where product_id = p_product_id
      or (product_id is null and model = v_old_model);
  get diagnostics v_stock_log = row_count;

  update public.orders o
     set checked_models = coalesce((
       select array_agg(x.model order by x.first_position)
         from (
           select case when item.model = v_old_model then v_new_model else item.model end as model,
                  min(item.position) as first_position
             from unnest(o.checked_models) with ordinality as item(model, position)
            group by case when item.model = v_old_model then v_new_model else item.model end
         ) x
     ), '{}')
   where v_old_model = any(o.checked_models);

  update public.orders o
     set model_order = coalesce((
       select array_agg(x.model order by x.first_position)
         from (
           select case when item.model = v_old_model then v_new_model else item.model end as model,
                  min(item.position) as first_position
             from unnest(o.model_order) with ordinality as item(model, position)
            group by case when item.model = v_old_model then v_new_model else item.model end
         ) x
     ), '{}')
   where v_old_model = any(o.model_order);

  if exists (select 1 from public.demand_customer_orders where model = v_old_model) then
    insert into public.demand_customer_orders (model, customer_keys, updated_at)
      select v_new_model, customer_keys, now()
        from public.demand_customer_orders where model = v_old_model
    on conflict (model) do update
      set customer_keys = (
        select array_agg(value order by first_position)
          from (
            select value, min(position) as first_position
              from unnest(public.demand_customer_orders.customer_keys || excluded.customer_keys)
                   with ordinality as item(value, position)
             group by value
          ) merged
      ), updated_at = now();
    delete from public.demand_customer_orders where model = v_old_model;
  end if;

  return jsonb_build_object(
    'old_model', v_old_model,
    'new_model', v_new_model,
    'order_items', v_order_items,
    'return_items', v_return_items,
    'stock_log', v_stock_log
  );
end;
$$;

revoke all on function public.rename_product_model(uuid, text) from public;
grant execute on function public.rename_product_model(uuid, text) to authenticated;
