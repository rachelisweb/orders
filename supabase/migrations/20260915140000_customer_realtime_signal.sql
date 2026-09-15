-- A quantity-free signal lets customer and guest screens refresh availability
-- without exposing inventory counts in Realtime payloads.
create table if not exists public.catalog_realtime_signal (
  id boolean primary key default true check (id),
  changed_at timestamptz not null default now(),
  image_version bigint not null default 1
);

insert into public.catalog_realtime_signal (id)
values (true)
on conflict (id) do nothing;

alter table public.catalog_realtime_signal enable row level security;
grant select on public.catalog_realtime_signal to anon, authenticated;

drop policy if exists "catalog signal is readable" on public.catalog_realtime_signal;
create policy "catalog signal is readable"
  on public.catalog_realtime_signal for select
  to anon, authenticated
  using (true);

create or replace function public.touch_catalog_realtime_signal()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.catalog_realtime_signal
     set changed_at = now(),
         image_version = image_version + case when tg_table_name = 'products' then 1 else 0 end
   where id = true;
  return null;
end;
$$;

do $$
declare
  source_table text;
begin
  foreach source_table in array array['products', 'collections', 'inventory', 'orders', 'order_items']
  loop
    execute format('drop trigger if exists catalog_realtime_touch on public.%I', source_table);
    execute format(
      'create trigger catalog_realtime_touch after insert or update or delete on public.%I for each statement execute function public.touch_catalog_realtime_signal()',
      source_table
    );
  end loop;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'catalog_realtime_signal'
  ) then
    alter publication supabase_realtime add table public.catalog_realtime_signal;
  end if;
end
$$;
