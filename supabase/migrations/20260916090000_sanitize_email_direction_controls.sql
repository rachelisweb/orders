-- Remove invisible Unicode direction controls that can turn a visually valid
-- address such as gmail.com into an invalid internationalized domain.

create or replace function public.sanitize_email_text(p_value text)
returns text
language sql
immutable
set search_path = public
as $$
  select nullif(lower(btrim(translate(
    coalesce(p_value, ''),
    chr(1564) || chr(8206) || chr(8207)
      || chr(8234) || chr(8235) || chr(8236) || chr(8237) || chr(8238)
      || chr(8294) || chr(8295) || chr(8296) || chr(8297) || chr(65279),
    ''
  ))), '')
$$;

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
  ), cleaned as (
    select public.sanitize_email_text(value) as email, ord
      from candidates
  ), normalized as (
    select email, min(ord) as first_ord
      from cleaned
     where email is not null
       and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     group by email
  )
  select coalesce(array_agg(email order by first_ord), '{}'::text[])
    from normalized
$$;

-- Existing customer addresses and order snapshots.
update public.customers
   set email_recipients = public.normalize_customer_emails(email_recipients, email),
       email = (public.normalize_customer_emails(email_recipients, email))[1]
 where email is distinct from public.sanitize_email_text(email)
    or email_recipients is distinct from public.normalize_customer_emails(email_recipients, email);

update public.orders
   set email = public.sanitize_email_text(email)
 where email is distinct from public.sanitize_email_text(email);

-- Administrative notification and brand addresses are also sanitized.
update public.notification_emails
   set email = public.sanitize_email_text(email)
 where email is distinct from public.sanitize_email_text(email)
   and public.sanitize_email_text(email) is not null;

update public.app_settings
   set value = public.sanitize_email_text(value)
 where key = 'brand_email'
   and value is distinct from public.sanitize_email_text(value);

-- Ensure future direct writes are cleaned even when they bypass the UI.
create or replace function public.sanitize_notification_email()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.email := public.sanitize_email_text(new.email);
  if new.email is null or new.email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'כתובת מייל אינה תקינה';
  end if;
  return new;
end;
$$;

drop trigger if exists notification_emails_sanitize on public.notification_emails;
create trigger notification_emails_sanitize
before insert or update of email on public.notification_emails
for each row execute function public.sanitize_notification_email();
