-- ============================================================
-- זרימת הזמנות, הגדרות תמחור לקוח ותשתית מאובטחת ל-iCount
-- ============================================================

-- מחיר עלות הוא מאפיין של כרטיס הלקוח. pricing_mode בהזמנה הוא snapshot:
-- שינוי עתידי בכרטיס לא משנה הזמנה שכבר נוצרה.
alter table public.customers
  add column if not exists price_at_cost boolean not null default false;

alter table public.orders
  add column if not exists pricing_mode text not null default 'wholesale';

alter table public.orders drop constraint if exists orders_pricing_mode_check;
alter table public.orders add constraint orders_pricing_mode_check
  check (pricing_mode in ('wholesale', 'cost'));

-- מידע חיצוני נשמר לצד קובץ ה-PDF. המפתח הסודי לעולם אינו נשמר בטבלה.
alter table public.invoices
  add column if not exists source text not null default 'manual',
  add column if not exists external_doctype text,
  add column if not exists external_docnum text,
  add column if not exists external_url text;

-- אין במערכת מעקב גבייה. חשבונית קיימת היא פעילה או מבוטלת בלבד.
alter table public.invoices drop constraint if exists invoices_status_check;
update public.invoices set status = 'active' where status in ('unpaid', 'paid');
alter table public.invoices alter column status set default 'active';
alter table public.invoices add constraint invoices_status_check
  check (status in ('active', 'cancelled'));

-- סטטוס paid הישן של הזמנה מומר לנשלחה ולארכיון.
alter table public.orders drop constraint if exists orders_status_check;
update public.orders
   set status = 'shipped',
       shipped_at = coalesce(shipped_at, paid_at, created_at, now()),
       archived_at = coalesce(archived_at, paid_at, created_at, now())
 where status = 'paid';
alter table public.orders add constraint orders_status_check
  check (status in ('pending', 'ready', 'shipped', 'cancelled'));

alter table public.invoices drop constraint if exists invoices_source_check;
alter table public.invoices add constraint invoices_source_check
  check (source in ('manual', 'icount'));

create unique index if not exists invoices_one_active_icount_per_order
  on public.invoices (order_id)
  where source = 'icount' and status <> 'cancelled' and order_id is not null;

create or replace function public.prevent_icount_invoice_delete()
returns trigger language plpgsql as $$
begin
  if old.source = 'icount' then
    raise exception 'חשבונית iCount אינה ניתנת למחיקה; יש לבטל או לזכות אותה בתהליך חשבונאי מתועד';
  end if;
  return old;
end $$;

drop trigger if exists trg_prevent_icount_invoice_delete on public.invoices;
create trigger trg_prevent_icount_invoice_delete
before delete on public.invoices for each row execute function public.prevent_icount_invoice_delete();

-- יומן נעילה והתאוששות. הוא מונע שתי לחיצות מקבילות על "הפקה".
create table if not exists public.icount_invoice_generations (
  order_id          uuid primary key references public.orders(id) on delete cascade,
  fingerprint       text not null,
  sanity_string     text not null unique,
  status            text not null check (status in ('processing', 'succeeded', 'failed', 'needs_review')),
  attempts          integer not null default 1,
  external_doctype  text,
  external_docnum   text,
  external_url      text,
  invoice_id        uuid references public.invoices(id) on delete set null,
  error             text,
  locked_at         timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

alter table public.icount_invoice_generations enable row level security;
-- אין policies: רק service_role של פונקציית הקצה יכול לקרוא ולכתוב.

create or replace function public.claim_icount_invoice_generation(
  p_order_id uuid,
  p_fingerprint text,
  p_sanity_string text
)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare v_row public.icount_invoice_generations%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service_role בלבד';
  end if;

  select * into v_row
    from public.icount_invoice_generations
   where order_id = p_order_id
   for update;

  if not found then
    insert into public.icount_invoice_generations
      (order_id, fingerprint, sanity_string, status)
    values (p_order_id, p_fingerprint, p_sanity_string, 'processing')
    returning * into v_row;
    return jsonb_build_object('claimed', true, 'status', v_row.status);
  end if;

  if v_row.status = 'succeeded' then
    return jsonb_build_object('claimed', false, 'status', 'succeeded',
      'invoice_id', v_row.invoice_id, 'docnum', v_row.external_docnum);
  end if;
  if v_row.status = 'needs_review' then
    return jsonb_build_object('claimed', false, 'status', 'needs_review', 'error', v_row.error);
  end if;
  if v_row.status = 'processing' and v_row.locked_at > now() - interval '5 minutes' then
    return jsonb_build_object('claimed', false, 'status', 'processing');
  end if;
  if v_row.fingerprint <> p_fingerprint then
    return jsonb_build_object('claimed', false, 'status', 'changed',
      'error', 'פרטי ההזמנה השתנו מאז ניסיון ההפקה הקודם');
  end if;

  update public.icount_invoice_generations
     set status = 'processing', attempts = attempts + 1, error = null,
         locked_at = now(), updated_at = now()
   where order_id = p_order_id;
  return jsonb_build_object('claimed', true, 'status', 'processing');
end $$;

revoke all on function public.claim_icount_invoice_generation(uuid, text, text) from public, anon, authenticated;
grant execute on function public.claim_icount_invoice_generation(uuid, text, text) to service_role;

-- תצוגת הלקוחות כוללת את כל השדות הנדרשים להגדרות ולחשבונית.
create or replace view public.v_customer_stats
with (security_invoker = on) as
select
  cu.id, cu.name, cu.business_name, cu.phone, cu.email, cu.city, cu.is_active,
  count(distinct o.id)                                          as orders_count,
  coalesce(sum(o.total_units), 0)                               as total_units,
  coalesce(sum(o.total_amount), 0)                              as total_amount,
  max(o.created_at)                                             as last_order_at,
  (select count(*) from public.invoices i where i.customer_id = cu.id) as invoices_count,
  (select coalesce(sum(i.amount), 0) from public.invoices i
     where i.customer_id = cu.id and i.status = 'active')       as open_balance,
  cu.duplicate_candidate_id,
  cu.duplicate_status,
  dc.name                                                       as duplicate_candidate_name,
  dc.business_name                                              as duplicate_candidate_business,
  cu.tax_id,
  cu.address,
  cu.discount_pct,
  cu.notes,
  cu.price_at_cost
from public.customers cu
left join public.orders o on o.customer_id = cu.id and o.status <> 'cancelled'
left join public.customers dc on dc.id = cu.duplicate_candidate_id
group by cu.id, dc.id;

grant select on public.v_customer_stats to authenticated;

-- ============================================================
-- הזמנה של לקוח: מחיר בסיס נשמר בשורה והנחת הלקוח נשמרת בנפרד,
-- כדי שהיא תופיע בהזמנה ובחשבונית. במחיר עלות אין הנחה קבועה.
-- ============================================================
create or replace function public.create_order(
  p_contact_name text,
  p_phone        text,
  p_email        text,
  p_notes        text,
  p_items        jsonb
)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_uid         uuid := auth.uid();
  v_customer_id uuid;
  v_order_id    uuid;
  v_order_no    bigint;
  v_item        jsonb;
  v_product     record;
  v_qty         integer;
  v_size        text;
  v_model       text;
  v_avail       integer;
  v_units       integer := 0;
  v_subtotal    numeric(12,2) := 0;
  v_total       numeric(12,2) := 0;
  v_price       numeric(10,2);
  v_discount    numeric(5,2) := 0;
  v_discount_amount numeric(12,2) := 0;
  v_cost_mode   boolean := false;
begin
  if v_uid is null then raise exception 'יש להתחבר כדי לשלוח הזמנה'; end if;
  if not public.can_order() then raise exception 'יש להשלים את פרטי החשבון לפני הזמנה'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'ההזמנה ריקה';
  end if;

  select p.customer_id, coalesce(c.discount_pct, 0), coalesce(c.price_at_cost, false)
    into v_customer_id, v_discount, v_cost_mode
    from public.profiles p join public.customers c on c.id = p.customer_id
   where p.id = v_uid;
  if v_cost_mode then v_discount := 0; end if;

  insert into public.orders
    (customer_id, user_id, contact_name, phone, email, notes, pricing_mode,
     discount_type, discount_value)
  values
    (v_customer_id, v_uid, coalesce(nullif(btrim(p_contact_name), ''), 'לקוח'), p_phone, p_email, p_notes,
     case when v_cost_mode then 'cost' else 'wholesale' end,
     case when v_discount > 0 then 'pct' else null end, v_discount)
  returning id, order_number into v_order_id, v_order_no;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_model := btrim(v_item->>'model');
    v_size  := btrim(upper(v_item->>'size'));
    v_qty   := coalesce((v_item->>'qty')::integer, 0);
    if v_qty <= 0 then continue; end if;

    select p.id, p.model, p.wholesale_price, p.cost_price, p.is_active
      into v_product from public.products p
     where lower(btrim(p.model)) = lower(v_model);
    if v_product.id is null then raise exception 'דגם % לא נמצא במערכת', v_model; end if;
    if not v_product.is_active then raise exception 'דגם % אינו זמין להזמנה', v_model; end if;

    select qty into v_avail from public.inventory
     where product_id = v_product.id and size = v_size for update;
    if v_avail is null then raise exception 'דגם % מידה % אינו קיים במלאי', v_model, v_size; end if;
    if v_qty > v_avail then
      raise exception 'דגם % מידה %: ביקשת % אך יש רק % במלאי', v_model, v_size, v_qty, v_avail;
    end if;

    v_price := case when v_cost_mode then v_product.cost_price else v_product.wholesale_price end;
    if v_cost_mode and coalesce(v_price, 0) <= 0 then
      raise exception 'לדגם % לא הוגדר מחיר עלות — ההזמנה לא נוצרה', v_model;
    end if;

    insert into public.order_items (order_id, product_id, model, size, qty, qty_ordered, unit_price)
    values (v_order_id, v_product.id, v_product.model, v_size, v_qty, v_qty, v_price);
    v_units := v_units + v_qty;
    v_subtotal := v_subtotal + (v_qty * v_price);
  end loop;

  if v_units = 0 then raise exception 'ההזמנה ריקה'; end if;
  v_discount_amount := round(v_subtotal * v_discount / 100.0, 2);
  v_total := greatest(v_subtotal - v_discount_amount, 0);
  update public.orders set total_units = v_units, subtotal_amount = v_subtotal,
    discount_amount = v_discount_amount, total_amount = v_total where id = v_order_id;
  perform public.refresh_future_order_classification(v_order_id);

  return jsonb_build_object('ok', true, 'order_id', v_order_id, 'order_number', v_order_no,
    'total_units', v_units, 'total_amount', v_total);
end $$;

-- אותה לוגיקה להזמנה ידנית מהמנהל.
create or replace function public.admin_create_order(
  p_customer_id uuid,
  p_customer    jsonb,
  p_notes       text,
  p_items       jsonb
)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_customer    record;
  v_customer_id uuid;
  v_created     boolean := false;
  v_order_id    uuid;
  v_order_no    bigint;
  v_item        jsonb;
  v_product     record;
  v_qty         integer;
  v_size        text;
  v_model       text;
  v_avail       integer;
  v_units       integer := 0;
  v_subtotal    numeric(12,2) := 0;
  v_total       numeric(12,2) := 0;
  v_price       numeric(10,2);
  v_discount    numeric(5,2) := 0;
  v_discount_amount numeric(12,2) := 0;
  v_cost_mode   boolean := false;
  v_name        text;
  v_business    text;
  v_duplicate   uuid;
begin
  if not public.is_admin() then raise exception 'אין הרשאה — יצירת הזמנה ידנית מותרת למנהל בלבד'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'ההזמנה ריקה'; end if;

  if p_customer_id is not null then
    select * into v_customer from public.customers where id = p_customer_id and is_active;
    if v_customer.id is null then raise exception 'הלקוח שנבחר לא נמצא או אינו פעיל'; end if;
    v_customer_id := v_customer.id;
  else
    if p_customer is null or jsonb_typeof(p_customer) <> 'object' then raise exception 'יש לבחור לקוח קיים או להזין לקוח חדש'; end if;
    v_name := nullif(btrim(coalesce(p_customer->>'name', '')), '');
    v_business := nullif(btrim(coalesce(p_customer->>'business_name', '')), '');
    if v_name is null then raise exception 'חסר שם לקוח'; end if;
    insert into public.customers (name, business_name, phone, email, city)
    values (v_name, v_business, nullif(btrim(coalesce(p_customer->>'phone','')),''),
      nullif(btrim(coalesce(p_customer->>'email','')),''), nullif(btrim(coalesce(p_customer->>'city','')),''))
    returning * into v_customer;
    v_customer_id := v_customer.id;
    v_created := true;

    if v_business is not null then
      select c.id into v_duplicate from public.customers c
       where c.id <> v_customer_id and c.business_name is not null
         and lower(btrim(c.business_name)) = lower(v_business)
       order by (select count(*) from public.orders o where o.customer_id = c.id) desc, c.created_at asc limit 1;
      if v_duplicate is not null then
        update public.customers set duplicate_candidate_id = v_duplicate, duplicate_status = 'pending'
         where id = v_customer_id;
      end if;
    end if;
  end if;

  v_cost_mode := coalesce(v_customer.price_at_cost, false);
  v_discount := case when v_cost_mode then 0 else coalesce(v_customer.discount_pct, 0) end;

  insert into public.orders
    (customer_id, user_id, contact_name, phone, email, notes, source, pricing_mode,
     discount_type, discount_value)
  values (v_customer_id, null, coalesce(nullif(btrim(v_customer.name), ''), nullif(btrim(v_customer.business_name), ''), 'לקוח'),
    v_customer.phone, v_customer.email, nullif(btrim(coalesce(p_notes, '')), ''), 'manual',
    case when v_cost_mode then 'cost' else 'wholesale' end,
    case when v_discount > 0 then 'pct' else null end, v_discount)
  returning id, order_number into v_order_id, v_order_no;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_model := btrim(v_item->>'model'); v_size := btrim(upper(v_item->>'size'));
    v_qty := coalesce((v_item->>'qty')::integer, 0); if v_qty <= 0 then continue; end if;
    select p.id, p.model, p.wholesale_price, p.cost_price, p.is_active into v_product
      from public.products p where lower(btrim(p.model)) = lower(v_model);
    if v_product.id is null then raise exception 'דגם % לא נמצא במערכת', v_model; end if;
    if not v_product.is_active then raise exception 'דגם % אינו זמין להזמנה', v_model; end if;
    select qty into v_avail from public.inventory where product_id = v_product.id and size = v_size for update;
    if v_avail is null then raise exception 'דגם % מידה % אינו קיים במלאי', v_model, v_size; end if;
    if v_qty > v_avail then raise exception 'דגם % מידה %: ביקשת % אך יש רק % במלאי', v_model, v_size, v_qty, v_avail; end if;
    v_price := case when v_cost_mode then v_product.cost_price else v_product.wholesale_price end;
    if v_cost_mode and coalesce(v_price, 0) <= 0 then raise exception 'לדגם % לא הוגדר מחיר עלות — ההזמנה לא נוצרה', v_model; end if;
    insert into public.order_items (order_id, product_id, model, size, qty, qty_ordered, unit_price)
    values (v_order_id, v_product.id, v_product.model, v_size, v_qty, v_qty, v_price);
    v_units := v_units + v_qty; v_subtotal := v_subtotal + (v_qty * v_price);
  end loop;

  if v_units = 0 then raise exception 'ההזמנה ריקה'; end if;
  v_discount_amount := round(v_subtotal * v_discount / 100.0, 2);
  v_total := greatest(v_subtotal - v_discount_amount, 0);
  update public.orders set total_units = v_units, subtotal_amount = v_subtotal,
    discount_amount = v_discount_amount, total_amount = v_total where id = v_order_id;
  perform public.refresh_future_order_classification(v_order_id);

  return jsonb_build_object('ok', true, 'order_id', v_order_id, 'order_number', v_order_no,
    'customer_id', v_customer_id, 'customer_created', v_created,
    'duplicate_pending', v_duplicate is not null, 'total_units', v_units, 'total_amount', v_total);
end $$;

grant execute on function public.create_order(text, text, text, text, jsonb) to authenticated;
grant execute on function public.admin_create_order(uuid, jsonb, text, jsonb) to authenticated;

-- ============================================================
-- אין יותר שלב "שולמה". סימון כנשלחה מעביר מיד לארכיון.
-- ============================================================
create or replace function public.set_order_status(p_order_id uuid, p_status text)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_old text; v_applied boolean; v_rec record; v_new integer; v_missing jsonb := '[]'::jsonb;
begin
  if not public.is_admin() then raise exception 'אין הרשאה'; end if;
  if p_status not in ('pending', 'ready', 'shipped', 'cancelled') then raise exception 'סטטוס לא חוקי: %', p_status; end if;
  select status, stock_applied into v_old, v_applied from public.orders where id = p_order_id for update;
  if v_old is null then raise exception 'ההזמנה לא נמצאה'; end if;
  if v_old = p_status then return jsonb_build_object('ok', true, 'unchanged', true, 'archived', p_status = 'shipped'); end if;

  if p_status in ('ready', 'shipped') and not v_applied then
    for v_rec in select product_id, model, size, qty from public.order_items where order_id = p_order_id loop
      v_new := null;
      update public.inventory set qty = greatest(0, qty - v_rec.qty), updated_at = now()
       where product_id = v_rec.product_id and size = v_rec.size returning qty into v_new;
      if v_new is null then v_missing := v_missing || jsonb_build_object('model', v_rec.model, 'size', v_rec.size);
      else insert into public.stock_log (product_id, model, size, delta, reason, ref_id, actor)
        values (v_rec.product_id, v_rec.model, v_rec.size, -v_rec.qty, 'order_' || p_status, p_order_id, auth.uid());
      end if;
    end loop;
    v_applied := true;
  end if;

  if p_status = 'cancelled' and v_applied then
    for v_rec in select product_id, model, size, qty from public.order_items where order_id = p_order_id loop
      insert into public.inventory (product_id, size, qty) values (v_rec.product_id, v_rec.size, v_rec.qty)
      on conflict (product_id, size) do update set qty = public.inventory.qty + excluded.qty, updated_at = now();
      insert into public.stock_log (product_id, model, size, delta, reason, ref_id, actor)
      values (v_rec.product_id, v_rec.model, v_rec.size, v_rec.qty, 'order_cancelled', p_order_id, auth.uid());
    end loop;
    v_applied := false;
  end if;

  update public.orders set status = p_status, stock_applied = v_applied,
    archived_at = case when p_status = 'pending' then null when p_status = 'shipped' then now() else archived_at end,
    future_order_at = case when p_status = 'pending' then future_order_at else null end,
    future_order_source = case when p_status = 'pending' then future_order_source else null end,
    ready_at = case when p_status = 'ready' then coalesce(ready_at, now()) else ready_at end,
    shipped_at = case when p_status = 'shipped' then coalesce(shipped_at, now()) else shipped_at end,
    approved_at = case when p_status in ('ready', 'shipped') then coalesce(approved_at, now()) else approved_at end
  where id = p_order_id;
  return jsonb_build_object('ok', true, 'status', p_status, 'archived', p_status = 'shipped', 'missing', v_missing);
end $$;

grant execute on function public.set_order_status(uuid, text) to authenticated;

-- כל הזמנה שנשלחה שייכת לארכיון.
update public.orders set archived_at = coalesce(archived_at, now()) where status = 'shipped';
