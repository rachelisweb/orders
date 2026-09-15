-- Preserve every useful detail when two customer cards are merged. Fields that
-- can contain several values (emails) are unioned. Conflicting single-value
-- fields keep the target value and retain the source value in the admin notes.
alter table public.customers
  add column if not exists phone_numbers text[] not null default '{}'::text[];

update public.customers
set phone_numbers = array[phone]
where coalesce(btrim(phone), '') <> ''
  and not (phone = any(phone_numbers));

create or replace function public.merge_customers(p_source uuid, p_target uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_src public.customers%rowtype;
  v_tgt public.customers%rowtype;
  v_orders integer;
  v_inv integer;
  v_users integer;
  v_preserved text := '';
begin
  if not public.is_admin() then raise exception 'אין הרשאה'; end if;
  if p_source is null or p_target is null then raise exception 'חסר לקוח מקור או יעד'; end if;
  if p_source = p_target then raise exception 'לא ניתן לאחד לקוח עם עצמו'; end if;

  select * into v_src from public.customers where id = p_source for update;
  if v_src.id is null then raise exception 'לקוח המקור לא נמצא'; end if;
  select * into v_tgt from public.customers where id = p_target for update;
  if v_tgt.id is null then raise exception 'לקוח היעד לא נמצא'; end if;

  if coalesce(btrim(v_src.business_name), '') <> '' and coalesce(btrim(v_tgt.business_name), '') <> ''
     and btrim(v_src.business_name) <> btrim(v_tgt.business_name) then
    v_preserved := concat_ws(E'\n', nullif(v_preserved, ''), 'שם עסק נוסף: ' || v_src.business_name);
  end if;
  if coalesce(btrim(v_src.city), '') <> '' and coalesce(btrim(v_tgt.city), '') <> ''
     and btrim(v_src.city) <> btrim(v_tgt.city) then
    v_preserved := concat_ws(E'\n', nullif(v_preserved, ''), 'עיר נוספת: ' || v_src.city);
  end if;
  if coalesce(btrim(v_src.address), '') <> '' and coalesce(btrim(v_tgt.address), '') <> ''
     and btrim(v_src.address) <> btrim(v_tgt.address) then
    v_preserved := concat_ws(E'\n', nullif(v_preserved, ''), 'כתובת נוספת: ' || v_src.address);
  end if;
  if coalesce(btrim(v_src.tax_id), '') <> '' and coalesce(btrim(v_tgt.tax_id), '') <> ''
     and btrim(v_src.tax_id) <> btrim(v_tgt.tax_id) then
    v_preserved := concat_ws(E'\n', nullif(v_preserved, ''), 'ח״פ/עוסק נוסף: ' || v_src.tax_id);
  end if;
  if v_src.discount_pct is distinct from v_tgt.discount_pct and coalesce(v_src.discount_pct, 0) <> 0 then
    v_preserved := concat_ws(E'\n', nullif(v_preserved, ''), 'הנחת כרטיס קודם: ' || v_src.discount_pct || '%');
  end if;
  if v_src.price_at_cost is distinct from v_tgt.price_at_cost then
    v_preserved := concat_ws(E'\n', nullif(v_preserved, ''),
      'תמחור כרטיס קודם: ' || case when v_src.price_at_cost then 'מחיר עלות' else 'מחיר סיטונאי' end);
  end if;
  if v_src.icount_client_id is not null and v_tgt.icount_client_id is not null
     and v_src.icount_client_id <> v_tgt.icount_client_id then
    v_preserved := concat_ws(E'\n', nullif(v_preserved, ''),
      'קישור iCount נוסף: ' || v_src.icount_client_id ||
      case when coalesce(btrim(v_src.icount_client_name), '') <> '' then ' — ' || v_src.icount_client_name else '' end);
  end if;

  update public.orders set customer_id = p_target where customer_id = p_source;
  get diagnostics v_orders = row_count;
  update public.invoices set customer_id = p_target where customer_id = p_source;
  get diagnostics v_inv = row_count;
  update public.profiles set customer_id = p_target where customer_id = p_source;
  get diagnostics v_users = row_count;
  update public.returns set customer_id = p_target where customer_id = p_source;

  -- Delete first to avoid the unique business-name index conflicting when a
  -- missing target business name is filled from the source card.
  delete from public.customers where id = p_source;

  update public.customers t
  set business_name = coalesce(nullif(btrim(t.business_name), ''), nullif(btrim(v_src.business_name), '')),
      phone = coalesce(nullif(btrim(t.phone), ''), nullif(btrim(v_src.phone), '')),
      phone_numbers = (
        select coalesce(array_agg(x.phone order by x.first_seen), '{}'::text[])
        from (
          select btrim(value) as phone, min(ord) as first_seen
          from unnest(
            array[coalesce(t.phone, ''), coalesce(v_src.phone, '')]
            || coalesce(t.phone_numbers, '{}'::text[])
            || coalesce(v_src.phone_numbers, '{}'::text[])
          ) with ordinality as phones(value, ord)
          where coalesce(btrim(value), '') <> ''
          group by btrim(value)
        ) x
      ),
      email = coalesce(nullif(btrim(t.email), ''), nullif(btrim(v_src.email), '')),
      email_recipients = (
        select coalesce(array_agg(x.email order by x.email), '{}'::text[])
        from (
          select distinct lower(btrim(value)) as email
          from unnest(
            coalesce(t.email_recipients, '{}'::text[])
            || coalesce(v_src.email_recipients, '{}'::text[])
            || array[coalesce(t.email, ''), coalesce(v_src.email, '')]
          ) as values_list(value)
          where coalesce(btrim(value), '') <> ''
        ) x
      ),
      city = coalesce(nullif(btrim(t.city), ''), nullif(btrim(v_src.city), '')),
      address = coalesce(nullif(btrim(t.address), ''), nullif(btrim(v_src.address), '')),
      tax_id = coalesce(nullif(btrim(t.tax_id), ''), nullif(btrim(v_src.tax_id), '')),
      is_active = coalesce(t.is_active, false) or coalesce(v_src.is_active, false),
      icount_client_id = coalesce(t.icount_client_id, v_src.icount_client_id),
      icount_client_name = case when t.icount_client_id is null
        then coalesce(t.icount_client_name, v_src.icount_client_name) else t.icount_client_name end,
      icount_linked_at = case when t.icount_client_id is null
        then coalesce(t.icount_linked_at, v_src.icount_linked_at) else t.icount_linked_at end,
      icount_linked_by = case when t.icount_client_id is null
        then coalesce(t.icount_linked_by, v_src.icount_linked_by) else t.icount_linked_by end,
      duplicate_candidate_id = null,
      duplicate_status = null,
      notes = concat_ws(E'\n',
        nullif(btrim(t.notes), ''),
        case when coalesce(btrim(v_src.notes), '') <> ''
          then '— הערות מהכרטיס "' || v_src.name || '":' || E'\n' || v_src.notes end,
        case when v_preserved <> ''
          then '— פרטים נוספים שנשמרו מהכרטיס "' || v_src.name || '":' || E'\n' || v_preserved end
      ),
      updated_at = now()
  where t.id = p_target;

  return jsonb_build_object(
    'ok', true,
    'orders', v_orders,
    'invoices', v_inv,
    'users', v_users,
    'merged_name', v_src.name
  );
end
$$;

revoke all on function public.merge_customers(uuid, uuid) from public;
grant execute on function public.merge_customers(uuid, uuid) to authenticated;
