alter table public.returns
  add column if not exists discount_type text,
  add column if not exists discount_value numeric(12,2) not null default 0;

alter table public.returns
  drop constraint if exists returns_discount_type_check;

alter table public.returns
  add constraint returns_discount_type_check
  check (discount_type is null or discount_type in ('pct', 'amt'));

-- Existing returns did not record the discount used at purchase time. For
-- linked customers, initialize them from the permanent customer discount.
update public.returns r
set discount_type = 'pct',
    discount_value = c.discount_pct,
    discount_pct = c.discount_pct
from public.customers c
where r.customer_id = c.id
  and r.status = 'pending'
  and coalesce(r.discount_type, '') = ''
  and coalesce(r.discount_value, 0) = 0
  and coalesce(r.discount_pct, 0) = 0
  and coalesce(c.price_at_cost, false) = false
  and coalesce(c.discount_pct, 0) > 0;

update public.returns
set discount_type = 'pct', discount_value = discount_pct
where discount_type is null and coalesce(discount_pct, 0) > 0;

create or replace function public.set_return_discount_v2(
  p_return_id uuid,
  p_type text,
  p_value numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_type text := case when coalesce(p_value, 0) > 0 then p_type else null end;
  v_value numeric := greatest(coalesce(p_value, 0), 0);
begin
  if not public.is_admin() then raise exception 'אין הרשאת מנהל'; end if;
  if v_type is not null and v_type not in ('pct', 'amt') then raise exception 'סוג הנחה לא תקין'; end if;
  if v_type = 'pct' and v_value > 100 then raise exception 'אחוז הנחה לא יכול לעבור 100'; end if;

  update public.returns
  set discount_type = v_type,
      discount_value = case when v_type is null then 0 else v_value end,
      discount_pct = case when v_type = 'pct' then v_value else 0 end
  where id = p_return_id and status = 'pending';

  if not found then raise exception 'החזרה לא נמצאה או שכבר זוכתה'; end if;
  return jsonb_build_object('ok', true, 'type', v_type, 'value', v_value);
end;
$$;

revoke all on function public.set_return_discount_v2(uuid, text, numeric) from public;
grant execute on function public.set_return_discount_v2(uuid, text, numeric) to authenticated;
