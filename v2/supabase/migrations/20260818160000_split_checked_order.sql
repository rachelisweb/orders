-- מפצל את כל הדגמים המסומנים בצ'קליסט להזמנה חדשה של אותו לקוח.
-- מותר רק לפני עדכון המלאי, כדי לשמור על היסטוריית המלאי והשריונים.
alter table public.orders
  add column if not exists split_from_order_id uuid
  references public.orders(id) on delete set null;

create index if not exists orders_split_from_order_id_idx
  on public.orders(split_from_order_id)
  where split_from_order_id is not null;

create or replace function public.split_checked_order(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders%rowtype;
  v_models text[];
  v_new_order_id uuid;
  v_new_order_number bigint;
  v_moved_lines integer := 0;
  v_moved_units integer := 0;
  v_full_subtotal numeric(12,2) := 0;
  v_moved_subtotal numeric(12,2) := 0;
  v_new_discount numeric(12,2) := 0;
  v_old_discount numeric(12,2) := 0;
begin
  if not public.is_admin() then
    raise exception 'אין הרשאה';
  end if;

  select * into v_order
    from public.orders
   where id = p_order_id
   for update;

  if v_order.id is null then
    raise exception 'ההזמנה לא נמצאה';
  end if;
  if v_order.status <> 'pending' or v_order.stock_applied then
    raise exception 'ניתן לפצל רק הזמנה ממתינה לפני עדכון המלאי';
  end if;

  select array_agg(model order by model)
    into v_models
    from (
      select distinct oi.model
        from public.order_items oi
       where oi.order_id = p_order_id
         and oi.model = any(coalesce(v_order.checked_models, '{}'::text[]))
    ) checked;

  if cardinality(coalesce(v_models, '{}')) = 0 then
    raise exception 'יש לסמן לפחות דגם אחד בווי לפני הפיצול';
  end if;

  select coalesce(sum(oi.qty), 0)::integer,
         coalesce(sum(oi.qty * oi.unit_price), 0)
    into v_moved_units, v_moved_subtotal
    from public.order_items oi
   where oi.order_id = p_order_id
     and oi.model = any(v_models);

  select coalesce(sum(oi.qty * oi.unit_price), 0)
    into v_full_subtotal
    from public.order_items oi
   where oi.order_id = p_order_id;

  if v_order.discount_type = 'amt' and coalesce(v_order.discount_value, 0) > 0 then
    if v_full_subtotal > 0 then
      v_new_discount := round(v_order.discount_value * v_moved_subtotal / v_full_subtotal, 2);
    else
      v_new_discount := 0;
    end if;
    v_old_discount := greatest(coalesce(v_order.discount_value, 0) - v_new_discount, 0);
  else
    v_new_discount := coalesce(v_order.discount_value, 0);
    v_old_discount := coalesce(v_order.discount_value, 0);
  end if;

  insert into public.orders (
    customer_id, user_id, contact_name, phone, email, notes,
    status, stock_applied, source, pricing_mode,
    discount_type, discount_value, checked_models,
    future_order_at, future_order_source, pending_position,
    split_from_order_id
  ) values (
    v_order.customer_id, v_order.user_id, v_order.contact_name,
    v_order.phone, v_order.email, v_order.notes,
    v_order.status, false, v_order.source, v_order.pricing_mode,
    v_order.discount_type, v_new_discount, v_models,
    v_order.future_order_at, v_order.future_order_source, v_order.pending_position,
    p_order_id
  )
  returning id, order_number into v_new_order_id, v_new_order_number;

  update public.order_items
     set order_id = v_new_order_id
   where order_id = p_order_id
     and model = any(v_models);
  get diagnostics v_moved_lines = row_count;

  if v_moved_lines = 0 then
    raise exception 'לא נמצאו פריטים להעברה';
  end if;

  update public.orders
     set checked_models = array(
           select item.model
             from unnest(coalesce(v_order.checked_models, '{}'::text[])) as item(model)
            where not (item.model = any(v_models))
         ),
         discount_value = v_old_discount
   where id = p_order_id;

  perform public.recalc_order(p_order_id);
  perform public.recalc_order(v_new_order_id);

  insert into public.order_admin_notes (order_id, notes, updated_by, updated_at)
  select v_new_order_id, notes, auth.uid(), now()
    from public.order_admin_notes
   where order_id = p_order_id
     and nullif(btrim(coalesce(notes, '')), '') is not null;

  return jsonb_build_object(
    'ok', true,
    'original_order_id', p_order_id,
    'original_order_number', v_order.order_number,
    'new_order_id', v_new_order_id,
    'new_order_number', v_new_order_number,
    'status', v_order.status,
    'models', to_jsonb(v_models),
    'moved_lines', v_moved_lines,
    'moved_units', v_moved_units
  );
end;
$$;

revoke all on function public.split_checked_order(uuid) from public;
grant execute on function public.split_checked_order(uuid) to authenticated;
