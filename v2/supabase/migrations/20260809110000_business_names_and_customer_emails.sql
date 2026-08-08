-- One customer identity (business name) and multiple notification recipients.

alter table public.customers
  add column if not exists email_recipients text[] not null default '{}'::text[];

create or replace function public.normalize_customer_emails(p_emails text[], p_fallback text default null)
returns text[]
language sql
immutable
set search_path = public
as $$
  with candidates as (
    select value, ord
      from unnest(coalesce(p_emails, '{}'::text[])) with ordinality as x(value, ord)
    union all
    select p_fallback, 2147483647
     where cardinality(coalesce(p_emails, '{}'::text[])) = 0
  ), normalized as (
    select lower(btrim(value)) as email, min(ord) as first_ord
      from candidates
     where nullif(btrim(coalesce(value, '')), '') is not null
       and lower(btrim(value)) ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     group by lower(btrim(value))
  )
  select coalesce(array_agg(email order by first_ord), '{}'::text[])
    from normalized
$$;

create or replace function public.normalize_customer_identity()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_business text;
begin
  v_business := coalesce(
    nullif(btrim(coalesce(new.business_name, '')), ''),
    nullif(btrim(coalesce(new.name, '')), ''),
    nullif(btrim(coalesce(new.email, '')), ''),
    'לקוח'
  );
  new.business_name := v_business;
  new.name := v_business;
  new.email_recipients := public.normalize_customer_emails(new.email_recipients, new.email);
  new.email := new.email_recipients[1];
  return new;
end $$;

drop trigger if exists customers_normalize_identity on public.customers;
create trigger customers_normalize_identity
before insert or update of name, business_name, email, email_recipients on public.customers
for each row execute function public.normalize_customer_identity();

update public.customers
   set business_name = coalesce(
         nullif(btrim(coalesce(business_name, '')), ''),
         nullif(btrim(coalesce(name, '')), ''),
         nullif(btrim(coalesce(email, '')), ''),
         'לקוח'
       ),
       name = coalesce(
         nullif(btrim(coalesce(business_name, '')), ''),
         nullif(btrim(coalesce(name, '')), ''),
         nullif(btrim(coalesce(email, '')), ''),
         'לקוח'
       ),
       email_recipients = public.normalize_customer_emails(email_recipients, email);

update public.profiles p
   set full_name = c.business_name
  from public.customers c
 where p.customer_id = c.id
   and p.full_name is distinct from c.business_name;

create or replace function public.sync_customer_contact_to_orders()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  update public.orders
     set contact_name = new.business_name,
         phone = new.phone,
         email = new.email
   where customer_id = new.id;
  update public.profiles
     set full_name = new.business_name,
         phone = coalesce(new.phone, phone)
   where customer_id = new.id;
  return new;
end $$;

drop trigger if exists customers_sync_contact_to_orders on public.customers;
create trigger customers_sync_contact_to_orders
after update of name, business_name, phone, email, email_recipients on public.customers
for each row
when (
  old.name is distinct from new.name
  or old.business_name is distinct from new.business_name
  or old.phone is distinct from new.phone
  or old.email is distinct from new.email
  or old.email_recipients is distinct from new.email_recipients
)
execute function public.sync_customer_contact_to_orders();

create or replace function public.complete_profile(
  p_full_name text,
  p_phone text,
  p_business_name text,
  p_city text default null
)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_mine uuid;
  v_target uuid;
  v_biz text := coalesce(
    nullif(btrim(coalesce(p_business_name, '')), ''),
    nullif(btrim(coalesce(p_full_name, '')), '')
  );
  v_previous_biz text;
  v_previous_candidate uuid;
  v_previous_status text;
  v_status text;
  v_auth_email text := nullif(lower(btrim(coalesce(auth.jwt()->>'email', ''))), '');
begin
  if v_uid is null then raise exception 'יש להתחבר'; end if;
  if v_biz is null then raise exception 'חסר שם העסק'; end if;

  perform pg_advisory_xact_lock(hashtextextended(lower(v_biz), 0));

  select customer_id into v_mine
    from public.profiles where id = v_uid for update;

  if not found then
    insert into public.profiles
      (id, email, full_name, phone, role, approved, customer_id, needs_profile)
    values (v_uid, v_auth_email, v_biz,
      nullif(btrim(coalesce(p_phone, '')), ''), 'customer', true, null, true)
    on conflict (id) do nothing;
    select customer_id into v_mine
      from public.profiles where id = v_uid for update;
  end if;

  if v_mine is null then
    insert into public.customers
      (name, business_name, phone, city, email, email_recipients)
    values (
      v_biz, v_biz,
      nullif(btrim(coalesce(p_phone, '')), ''),
      nullif(btrim(coalesce(p_city, '')), ''),
      v_auth_email,
      public.normalize_customer_emails('{}'::text[], v_auth_email)
    ) returning id into v_mine;
  end if;

  select business_name, duplicate_candidate_id, duplicate_status
    into v_previous_biz, v_previous_candidate, v_previous_status
    from public.customers where id = v_mine for update;

  if v_previous_status = 'rejected'
     and v_previous_candidate is not null
     and lower(btrim(coalesce(v_previous_biz, ''))) = lower(v_biz) then
    v_target := v_previous_candidate;
    v_status := 'rejected';
  else
    select c.id into v_target
      from public.customers c
     where c.id <> v_mine
       and lower(btrim(c.business_name)) = lower(v_biz)
     order by
       case when c.duplicate_status = 'pending' then 1 else 0 end,
       (select count(*) from public.orders o where o.customer_id = c.id) desc,
       c.created_at asc
     limit 1;
    if v_target is not null then v_status := 'pending'; end if;
  end if;

  update public.customers
     set name = v_biz,
         business_name = v_biz,
         phone = nullif(btrim(coalesce(p_phone, '')), ''),
         city = nullif(btrim(coalesce(p_city, '')), ''),
         duplicate_candidate_id = v_target,
         duplicate_status = v_status
   where id = v_mine;

  update public.profiles
     set full_name = v_biz,
         phone = coalesce(nullif(btrim(coalesce(p_phone, '')), ''), phone),
         customer_id = v_mine,
         approved = true,
         needs_profile = false
   where id = v_uid;

  return jsonb_build_object(
    'ok', true, 'customer_id', v_mine,
    'duplicate_pending', v_status = 'pending',
    'duplicate_candidate_id', v_target, 'access_ready', true
  );
end $$;

grant execute on function public.complete_profile(text, text, text, text) to authenticated;

create or replace function public.set_my_customer_emails(p_emails text[])
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_customer_id uuid;
  v_emails text[];
begin
  if auth.uid() is null then raise exception 'יש להתחבר'; end if;
  select customer_id into v_customer_id from public.profiles where id = auth.uid();
  if v_customer_id is null then raise exception 'כרטיס הלקוח לא נמצא'; end if;
  v_emails := public.normalize_customer_emails(p_emails, null);
  if cardinality(v_emails) <> cardinality(coalesce(p_emails, '{}'::text[])) then
    raise exception 'אחת מכתובות המייל אינה תקינה או מופיעה יותר מפעם אחת';
  end if;
  update public.customers
     set email_recipients = v_emails, email = v_emails[1]
   where id = v_customer_id;
  return jsonb_build_object('ok', true, 'emails', v_emails);
end $$;

grant execute on function public.set_my_customer_emails(text[]) to authenticated;

create or replace function public.admin_update_customer(p_customer_id uuid, p_data jsonb)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_old public.customers%rowtype;
  v_order record;
  v_cost boolean;
  v_discount numeric(5,2);
  v_repriced integer := 0;
  v_synced integer := 0;
  v_business text;
  v_phone text;
  v_emails text[];
  v_input_count integer := 0;
begin
  if not public.is_admin() then raise exception 'אין הרשאה'; end if;
  select * into v_old from public.customers where id = p_customer_id for update;
  if v_old.id is null then raise exception 'הלקוח לא נמצא'; end if;

  v_business := coalesce(
    nullif(btrim(coalesce(p_data->>'business_name', '')), ''),
    nullif(btrim(coalesce(p_data->>'name', '')), '')
  );
  if v_business is null then raise exception 'חסר שם העסק'; end if;
  v_phone := nullif(btrim(coalesce(p_data->>'phone', '')), '');
  v_cost := coalesce((p_data->>'price_at_cost')::boolean, false);
  v_discount := case when v_cost then 0 else least(greatest(coalesce((p_data->>'discount_pct')::numeric, 0), 0), 100) end;

  if jsonb_typeof(p_data->'email_recipients') = 'array' then
    select coalesce(array_agg(value order by ord), '{}'::text[]), count(*)
      into v_emails, v_input_count
      from jsonb_array_elements_text(p_data->'email_recipients') with ordinality as x(value, ord);
  else
    v_emails := case when nullif(btrim(coalesce(p_data->>'email', '')), '') is null
      then '{}'::text[] else array[p_data->>'email'] end;
    v_input_count := cardinality(v_emails);
  end if;
  v_emails := public.normalize_customer_emails(v_emails, null);
  if cardinality(v_emails) <> v_input_count then
    raise exception 'אחת מכתובות המייל אינה תקינה או מופיעה יותר מפעם אחת';
  end if;

  update public.customers set
    name = v_business, business_name = v_business,
    phone = v_phone, email = v_emails[1], email_recipients = v_emails,
    city = nullif(btrim(coalesce(p_data->>'city', '')), ''),
    tax_id = nullif(btrim(coalesce(p_data->>'tax_id', '')), ''),
    address = nullif(btrim(coalesce(p_data->>'address', '')), ''),
    notes = nullif(btrim(coalesce(p_data->>'notes', '')), ''),
    price_at_cost = v_cost, discount_pct = v_discount,
    duplicate_candidate_id = case when lower(v_business) <> lower(coalesce(v_old.business_name, '')) then null else v_old.duplicate_candidate_id end,
    duplicate_status = case when lower(v_business) <> lower(coalesce(v_old.business_name, '')) then null else v_old.duplicate_status end
  where id = p_customer_id;

  update public.orders set contact_name = v_business, phone = v_phone, email = v_emails[1]
   where customer_id = p_customer_id;
  get diagnostics v_synced = row_count;

  for v_order in
    select o.id from public.orders o
     where o.customer_id = p_customer_id
       and o.status in ('pending', 'ready', 'shipped')
       and o.archived_at is null
       and not exists (select 1 from public.invoices i where i.order_id = o.id)
     for update
  loop
    update public.order_items oi set product_id = p.id
      from public.products p
     where oi.order_id = v_order.id and oi.product_id is null
       and lower(btrim(oi.model)) = lower(btrim(p.model));
    if v_cost and exists (
      select 1 from public.order_items oi left join public.products p on p.id = oi.product_id
       where oi.order_id = v_order.id and (p.id is null or coalesce(p.cost_price, 0) <= 0)
    ) then
      raise exception 'לא ניתן לעדכן למחיר עלות: באחת ההזמנות הפתוחות יש דגם ללא מחיר עלות';
    end if;
    update public.order_items oi
       set unit_price = case when v_cost then p.cost_price else p.wholesale_price end
      from public.products p where oi.order_id = v_order.id and oi.product_id = p.id;
    update public.orders set
      pricing_mode = case when v_cost then 'cost' else 'wholesale' end,
      discount_type = case when not v_cost and v_discount > 0 then 'pct' else null end,
      discount_value = case when not v_cost then v_discount else 0 end
    where id = v_order.id;
    perform public.recalc_order(v_order.id);
    v_repriced := v_repriced + 1;
  end loop;

  return jsonb_build_object('ok', true, 'synced_orders', v_synced, 'repriced_orders', v_repriced);
end $$;

grant execute on function public.admin_update_customer(uuid, jsonb) to authenticated;

update public.orders o
   set contact_name = c.business_name, phone = c.phone, email = c.email
  from public.customers c
 where o.customer_id = c.id
   and (o.contact_name is distinct from c.business_name
     or o.phone is distinct from c.phone or o.email is distinct from c.email);
