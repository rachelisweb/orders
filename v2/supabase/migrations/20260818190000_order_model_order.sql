-- סדר תצוגה ידני של דגמים בתוך כל הזמנה.
alter table public.orders
  add column if not exists model_order text[] not null default '{}';

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
begin
  if not public.is_admin() then
    raise exception 'אין הרשאה';
  end if;

  if not exists (select 1 from public.orders where id = p_order_id) then
    raise exception 'ההזמנה לא נמצאה';
  end if;

  select count(distinct oi.model)::integer
    into v_expected
    from public.order_items oi
   where oi.order_id = p_order_id;

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
  ) then
    raise exception 'נמצא דגם לא תקין בסדר המבוקש';
  end if;

  if cardinality(v_models) <> (
    select count(distinct item.model)
    from unnest(v_models) as item(model)
  ) then
    raise exception 'רשימת הדגמים כוללת כפילויות';
  end if;

  update public.orders
     set model_order = v_models,
         updated_at = now()
   where id = p_order_id;
end;
$$;

revoke all on function public.set_order_model_order(uuid, text[]) from public;
grant execute on function public.set_order_model_order(uuid, text[]) to authenticated;
