alter table public.returns
  add column if not exists discount_pct numeric(5,2) not null default 0;

alter table public.returns
  drop constraint if exists returns_discount_pct_check;

alter table public.returns
  add constraint returns_discount_pct_check check (discount_pct between 0 and 100);

comment on column public.returns.discount_pct is
  'Percentage discount applied to prices when producing the refund document.';

create or replace function public.set_return_discount(p_return_id uuid, p_discount_pct numeric)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'אין הרשאת מנהל';
  end if;

  update public.returns
  set discount_pct = least(greatest(coalesce(p_discount_pct, 0), 0), 100)
  where id = p_return_id;

  if not found then raise exception 'החזרה לא נמצאה'; end if;
end;
$$;

revoke all on function public.set_return_discount(uuid, numeric) from public;
grant execute on function public.set_return_discount(uuid, numeric) to authenticated;
