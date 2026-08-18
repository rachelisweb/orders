-- מאפשר לטבלת "מי הזמין" לסמן דגם במספר הזמנות של אותו לקוח
-- באותה עסקה, תוך שימוש מדויק בלוגיקת הצ'קליסט הקיימת.
create or replace function public.set_orders_model_checked(
  p_order_ids uuid[],
  p_model text,
  p_checked boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order_id uuid;
  v_count integer := 0;
begin
  if not public.is_admin() then
    raise exception 'אין הרשאה';
  end if;

  if cardinality(coalesce(p_order_ids, '{}')) = 0 then
    raise exception 'לא נבחרו הזמנות';
  end if;

  for v_order_id in
    select distinct value
    from unnest(p_order_ids) as order_id(value)
  loop
    perform public.set_order_model_checked(v_order_id, p_model, p_checked);
    v_count := v_count + 1;
  end loop;

  return jsonb_build_object(
    'ok', true,
    'updated', v_count,
    'checked', coalesce(p_checked, false),
    'model', p_model
  );
end;
$$;

revoke all on function public.set_orders_model_checked(uuid[], text, boolean) from public;
grant execute on function public.set_orders_model_checked(uuid[], text, boolean) to authenticated;
