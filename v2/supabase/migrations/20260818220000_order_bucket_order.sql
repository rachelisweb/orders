-- סדר ידני של הזמנות ברשימות "ממתינות" ו"עונה הבאה".
-- אותו שדה מיקום משמש את שתי הרשימות, אך כל שמירה מאומתת מול הרשימה שלה בלבד.
create or replace function public.set_order_bucket_order(
  p_bucket text,
  p_order_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids uuid[] := coalesce(p_order_ids, '{}');
  v_expected integer;
begin
  if not public.is_admin() then
    raise exception 'אין הרשאה';
  end if;

  if p_bucket not in ('pending', 'future') then
    raise exception 'רשימת הזמנות לא תקינה';
  end if;

  if cardinality(v_ids) = 0 or cardinality(v_ids) > 3000 then
    raise exception 'רשימת ההזמנות ריקה או ארוכה מדי';
  end if;

  if cardinality(v_ids) <> (
    select count(distinct item.id)
      from unnest(v_ids) as item(id)
  ) then
    raise exception 'רשימת ההזמנות כוללת כפילויות';
  end if;

  select count(*)::integer
    into v_expected
    from public.orders o
   where o.status = 'pending'
     and o.archived_at is null
     and case
       when p_bucket = 'future' then o.future_order_at is not null
       else o.future_order_at is null
     end;

  if cardinality(v_ids) <> v_expected then
    raise exception 'רשימת ההזמנות השתנתה, יש לרענן ולנסות שוב';
  end if;

  if exists (
    select 1
      from unnest(v_ids) as item(id)
     where not exists (
       select 1
         from public.orders o
        where o.id = item.id
          and o.status = 'pending'
          and o.archived_at is null
          and case
            when p_bucket = 'future' then o.future_order_at is not null
            else o.future_order_at is null
          end
     )
  ) then
    raise exception 'נמצאה הזמנה שאינה שייכת לרשימה';
  end if;

  update public.orders o
     set pending_position = cardinality(v_ids) - ordered.position + 1,
         updated_at = now()
    from unnest(v_ids) with ordinality as ordered(id, position)
   where o.id = ordered.id;
end;
$$;

revoke all on function public.set_order_bucket_order(text, uuid[]) from public;
grant execute on function public.set_order_bucket_order(text, uuid[]) to authenticated;
