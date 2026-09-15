-- Publish operational tables so connected admin screens receive changes
-- immediately through Supabase Realtime.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'orders',
    'order_items',
    'inventory',
    'customers',
    'invoices',
    'returns',
    'return_items',
    'order_admin_notes',
    'products',
    'collections',
    'future_order_collections',
    'demand_customer_orders',
    'app_settings',
    'profiles',
    'notification_emails'
  ]
  loop
    if to_regclass(format('public.%I', table_name)) is not null
       and not exists (
         select 1
         from pg_publication_tables
         where pubname = 'supabase_realtime'
           and schemaname = 'public'
           and tablename = table_name
       ) then
      execute format('alter publication supabase_realtime add table public.%I', table_name);
    end if;
  end loop;
end
$$;
