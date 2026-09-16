-- Items in collections configured for the future season never reserve current stock.
-- This applies immediately while an order is being created, before its automatic
-- future-order classification has finished.

create or replace function public.get_available_inventory()
returns table(product_id uuid, size text, qty integer)
language sql
stable
security definer set search_path = public
as $$
  select i.product_id, i.size,
    greatest(i.qty - coalesce(r.reserved, 0), 0)::integer as qty
  from public.inventory i
  left join (
    select oi.product_id, oi.size, sum(oi.qty)::integer as reserved
    from public.order_items oi
    join public.orders o on o.id = oi.order_id
    join public.products p on p.id = oi.product_id
    left join public.future_order_collections fc on fc.collection_id = p.collection_id
    where o.status = 'pending'
      and not o.stock_applied
      and o.future_order_at is null
      and fc.collection_id is null
      and oi.qty > 0
    group by oi.product_id, oi.size
  ) r on r.product_id = i.product_id and r.size = i.size;
$$;

create or replace function public.enforce_order_item_available_stock()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_order record;
  v_stock integer;
  v_reserved integer;
begin
  select status, stock_applied, future_order_at into v_order
    from public.orders where id = new.order_id;
  if v_order.status <> 'pending' or v_order.stock_applied or v_order.future_order_at is not null or new.qty <= 0 then
    return new;
  end if;
  if new.product_id is null then raise exception 'לא ניתן לשריין דגם שאינו קיים במלאי'; end if;

  -- A configured future collection is exempt even before the order-level
  -- automatic classifier runs at the end of order creation.
  if exists (
    select 1 from public.products p
    join public.future_order_collections fc on fc.collection_id = p.collection_id
    where p.id = new.product_id
  ) then
    return new;
  end if;

  if tg_op = 'UPDATE' and old.product_id = new.product_id and old.size = new.size and new.qty <= old.qty then
    return new;
  end if;

  select qty into v_stock from public.inventory
   where product_id = new.product_id and size = new.size for update;
  if v_stock is null then raise exception 'דגם % מידה % אינו קיים במלאי', new.model, new.size; end if;

  select coalesce(sum(oi.qty), 0)::integer into v_reserved
    from public.order_items oi
    join public.orders o on o.id = oi.order_id
    join public.products p on p.id = oi.product_id
    left join public.future_order_collections fc on fc.collection_id = p.collection_id
   where oi.product_id = new.product_id and oi.size = new.size
     and o.status = 'pending' and not o.stock_applied and o.future_order_at is null
     and fc.collection_id is null
     and (tg_op = 'INSERT' or oi.id <> old.id);
  if v_reserved + new.qty > v_stock then
    raise exception 'דגם % מידה %: הכמות הזמינה כבר תפוסה בהזמנות אחרות', new.model, new.size;
  end if;
  return new;
end $$;

create or replace function public.enforce_order_reservation_on_activation()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_item record;
  v_stock integer;
  v_reserved integer;
  v_old_reserving boolean;
  v_new_reserving boolean;
begin
  v_old_reserving := old.status = 'pending' and not old.stock_applied and old.future_order_at is null;
  v_new_reserving := new.status = 'pending' and not new.stock_applied and new.future_order_at is null;
  if not v_new_reserving or v_old_reserving then return new; end if;

  for v_item in
    select oi.product_id, oi.model, oi.size, sum(oi.qty)::integer as qty
      from public.order_items oi
      join public.products p on p.id = oi.product_id
      left join public.future_order_collections fc on fc.collection_id = p.collection_id
     where oi.order_id = new.id and oi.qty > 0 and fc.collection_id is null
     group by oi.product_id, oi.model, oi.size order by oi.product_id, oi.size
  loop
    select qty into v_stock from public.inventory
     where product_id = v_item.product_id and size = v_item.size for update;
    select coalesce(sum(oi.qty), 0)::integer into v_reserved
      from public.order_items oi
      join public.orders o on o.id = oi.order_id
      join public.products p on p.id = oi.product_id
      left join public.future_order_collections fc on fc.collection_id = p.collection_id
     where oi.product_id = v_item.product_id and oi.size = v_item.size and oi.order_id <> new.id
       and o.status = 'pending' and not o.stock_applied and o.future_order_at is null
       and fc.collection_id is null;
    if v_stock is null or v_reserved + v_item.qty > v_stock then
      raise exception 'לא ניתן להחזיר לממתינות: דגם % מידה % כבר תפוס בהזמנות אחרות', v_item.model, v_item.size;
    end if;
  end loop;
  return new;
end $$;

grant execute on function public.get_available_inventory() to authenticated;
