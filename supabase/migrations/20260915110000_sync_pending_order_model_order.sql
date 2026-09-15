-- Reordering models in one pending order establishes the display order for
-- every regular pending order. Each target keeps models absent from the source
-- after the shared models, in its previously saved order.
create or replace function public.set_order_model_order(
  p_order_id uuid,
  p_models text[]
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_models text[] := coalesce(p_models, '{}');
  v_expected integer;
  v_source public.orders%rowtype;
  v_target record;
  v_target_models text[];
begin
  if not public.is_admin() then raise exception 'אין הרשאה'; end if;

  select * into v_source from public.orders where id = p_order_id;
  if v_source.id is null then raise exception 'ההזמנה לא נמצאה'; end if;

  select count(distinct oi.model)::integer into v_expected
    from public.order_items oi where oi.order_id = p_order_id;
  if cardinality(v_models) <> v_expected then
    raise exception 'רשימת הדגמים אינה תואמת להזמנה';
  end if;
  if exists (
    select 1 from unnest(v_models) as item(model)
     where btrim(coalesce(item.model, '')) = ''
        or not exists (
          select 1 from public.order_items oi
           where oi.order_id = p_order_id and oi.model = item.model
        )
  ) then raise exception 'נמצא דגם לא תקין בסדר המבוקש'; end if;
  if cardinality(v_models) <> (select count(distinct item.model) from unnest(v_models) as item(model)) then
    raise exception 'רשימת הדגמים כוללת כפילויות';
  end if;

  update public.orders set model_order = v_models, updated_at = now()
   where id = p_order_id;

  if v_source.status = 'pending'
     and v_source.archived_at is null
     and v_source.future_order_at is null then
    for v_target in
      select id, model_order from public.orders
       where id <> p_order_id
         and status = 'pending'
         and archived_at is null
         and future_order_at is null
    loop
      select array_agg(models.model order by
        array_position(v_models, models.model) nulls last,
        array_position(coalesce(v_target.model_order, '{}'), models.model) nulls last,
        models.model
      ) into v_target_models
      from (
        select distinct oi.model
          from public.order_items oi
         where oi.order_id = v_target.id
      ) models;

      update public.orders set model_order = coalesce(v_target_models, '{}'), updated_at = now()
       where id = v_target.id;
    end loop;
  end if;
end;
$$;

revoke all on function public.set_order_model_order(uuid, text[]) from public;
grant execute on function public.set_order_model_order(uuid, text[]) to authenticated;
