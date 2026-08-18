-- מחירים מותאמים להזמנה מוכנה + שמירה בטוחה של חשבוניות זיכוי לחזרות.

alter table public.invoices
  add column if not exists return_id uuid references public.returns(id) on delete set null;

create index if not exists invoices_return_id_idx
  on public.invoices (return_id)
  where return_id is not null;

create table if not exists public.icount_refund_generations (
  return_id          uuid primary key references public.returns(id) on delete cascade,
  fingerprint        text not null,
  sanity_string      text not null unique,
  status             text not null check (status in ('processing', 'succeeded', 'failed', 'needs_review')),
  attempts           integer not null default 1,
  external_docnum    text,
  external_url       text,
  invoice_id         uuid references public.invoices(id) on delete set null,
  error              text,
  locked_at          timestamptz not null default now(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

alter table public.icount_refund_generations enable row level security;

create or replace function public.claim_icount_refund_generation(
  p_return_id uuid,
  p_fingerprint text,
  p_sanity_string text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.icount_refund_generations%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service_role בלבד';
  end if;

  select * into v_row
    from public.icount_refund_generations
   where return_id = p_return_id
   for update;

  if not found then
    insert into public.icount_refund_generations
      (return_id, fingerprint, sanity_string, status)
    values (p_return_id, p_fingerprint, p_sanity_string, 'processing')
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
      'error', 'פרטי החזרה השתנו מאז ניסיון ההפקה הקודם');
  end if;

  update public.icount_refund_generations
     set status = 'processing', attempts = attempts + 1, error = null,
         locked_at = now(), updated_at = now()
   where return_id = p_return_id;
  return jsonb_build_object('claimed', true, 'status', 'processing');
end;
$$;

revoke all on function public.claim_icount_refund_generation(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.claim_icount_refund_generation(uuid, text, text)
  to service_role;

create or replace function public.set_order_model_prices(
  p_order_id uuid,
  p_prices jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders%rowtype;
  v_item jsonb;
  v_model text;
  v_price numeric(12,2);
  v_prices jsonb := '{}'::jsonb;
  v_subtotal numeric(12,2);
  v_discount numeric(12,2);
  v_total numeric(12,2);
begin
  if not public.is_admin() then
    raise exception 'אין הרשאה';
  end if;
  if p_prices is null or jsonb_typeof(p_prices) <> 'array'
     or jsonb_array_length(p_prices) = 0 or jsonb_array_length(p_prices) > 500 then
    raise exception 'רשימת המחירים אינה תקינה';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'ההזמנה לא נמצאה'; end if;
  if v_order.status <> 'ready' then
    raise exception 'ניתן לשנות מחיר מותאם רק להזמנה שמוכנה לאיסוף';
  end if;
  if exists (
    select 1 from public.invoices i
     where i.order_id = p_order_id and coalesce(i.status, 'active') <> 'cancelled'
  ) then
    raise exception 'לא ניתן לשנות מחירים לאחר שכבר נשמר מסמך להזמנה';
  end if;

  for v_item in select value from jsonb_array_elements(p_prices) loop
    v_model := btrim(coalesce(v_item->>'model', ''));
    begin
      v_price := round((v_item->>'unit_price')::numeric, 2);
    exception when others then
      raise exception 'מחיר לא תקין לדגם %', coalesce(nullif(v_model, ''), 'לא ידוע');
    end;
    if v_model = '' or v_price <= 0 or v_price > 10000000 then
      raise exception 'מחיר לא תקין לדגם %', coalesce(nullif(v_model, ''), 'לא ידוע');
    end if;
    if v_prices ? v_model then raise exception 'הדגם % מופיע יותר מפעם אחת', v_model; end if;
    if not exists (
      select 1 from public.order_items oi where oi.order_id = p_order_id and oi.model = v_model
    ) then
      raise exception 'הדגם % אינו קיים בהזמנה', v_model;
    end if;
    v_prices := v_prices || jsonb_build_object(v_model, v_price);
  end loop;

  if exists (
    select 1 from (select distinct oi.model from public.order_items oi where oi.order_id = p_order_id) models
     where not (v_prices ? models.model)
  ) then
    raise exception 'יש להזין מחיר לכל דגם בהזמנה';
  end if;

  update public.order_items oi
     set unit_price = (v_prices->>oi.model)::numeric
   where oi.order_id = p_order_id;

  select round(coalesce(sum(oi.qty * oi.unit_price), 0), 2)
    into v_subtotal
    from public.order_items oi
   where oi.order_id = p_order_id;

  v_discount := case v_order.discount_type
    when 'pct' then round(v_subtotal * least(greatest(coalesce(v_order.discount_value, 0), 0), 100) / 100.0, 2)
    when 'amt' then least(greatest(coalesce(v_order.discount_value, 0), 0), v_subtotal)
    else 0
  end;
  v_total := greatest(v_subtotal - v_discount, 0);

  update public.orders
     set subtotal_amount = v_subtotal,
         discount_amount = v_discount,
         total_amount = v_total
   where id = p_order_id;

  return jsonb_build_object(
    'ok', true,
    'subtotal', v_subtotal,
    'discount', v_discount,
    'total', v_total
  );
end;
$$;

revoke all on function public.set_order_model_prices(uuid, jsonb) from public, anon;
grant execute on function public.set_order_model_prices(uuid, jsonb) to authenticated;
