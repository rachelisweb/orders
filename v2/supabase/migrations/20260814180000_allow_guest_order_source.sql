-- מוסיף guest לערכי המקור המותרים בלי להניח מהם יתר הערכים
-- שכבר קיימים באילוץ של סביבת הייצור.
do $$
declare
  v_definition text;
  v_expression text;
begin
  select pg_get_constraintdef(c.oid)
    into v_definition
    from pg_constraint c
   where c.conrelid = 'public.orders'::regclass
     and c.conname = 'orders_source_check';

  if v_definition is null then
    alter table public.orders
      add constraint orders_source_check check (source in ('web', 'manual', 'shopify', 'guest'));
  elsif position('guest' in v_definition) = 0 then
    -- pg_get_constraintdef מחזיר CHECK (<expression>).
    v_expression := substring(v_definition from 8 for char_length(v_definition) - 8);
    alter table public.orders drop constraint orders_source_check;
    execute format(
      'alter table public.orders add constraint orders_source_check check (source = %L or (%s))',
      'guest', v_expression
    );
  end if;
end $$;
