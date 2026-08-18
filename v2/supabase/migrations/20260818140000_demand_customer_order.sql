-- סדר ידני של לקוחות בטבלת "מי הזמין", נשמר בנפרד לכל דגם.
create table if not exists public.demand_customer_orders (
  model text primary key check (btrim(model) <> ''),
  customer_keys text[] not null default '{}',
  updated_at timestamptz not null default now()
);

alter table public.demand_customer_orders enable row level security;

drop policy if exists "admins can read demand customer order" on public.demand_customer_orders;
create policy "admins can read demand customer order"
  on public.demand_customer_orders
  for select
  to authenticated
  using (public.is_admin());

revoke all on table public.demand_customer_orders from anon, authenticated;
grant select on table public.demand_customer_orders to authenticated;

create or replace function public.set_demand_customer_order(
  p_model text,
  p_customer_keys text[]
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_model text := btrim(coalesce(p_model, ''));
  v_keys text[] := coalesce(p_customer_keys, '{}');
begin
  if not public.is_admin() then
    raise exception 'אין הרשאה';
  end if;

  if v_model = '' then
    raise exception 'חסר דגם';
  end if;

  if cardinality(v_keys) > 5000 then
    raise exception 'רשימת הלקוחות ארוכה מדי';
  end if;

  if exists (
    select 1
    from unnest(v_keys) as key(value)
    where btrim(coalesce(key.value, '')) = ''
  ) then
    raise exception 'מזהה לקוח לא תקין';
  end if;

  if cardinality(v_keys) <> (
    select count(distinct key.value)
    from unnest(v_keys) as key(value)
  ) then
    raise exception 'רשימת הלקוחות כוללת כפילויות';
  end if;

  insert into public.demand_customer_orders (model, customer_keys, updated_at)
  values (v_model, v_keys, now())
  on conflict (model) do update
    set customer_keys = excluded.customer_keys,
        updated_at = excluded.updated_at;
end;
$$;

revoke all on function public.set_demand_customer_order(text, text[]) from public;
grant execute on function public.set_demand_customer_order(text, text[]) to authenticated;
