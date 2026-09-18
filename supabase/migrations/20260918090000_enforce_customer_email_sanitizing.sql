-- Keep customer and order addresses clean even when a write bypasses the UI.
create or replace function public.sanitize_customer_emails()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.email_recipients := public.normalize_customer_emails(new.email_recipients, new.email);
  new.email := new.email_recipients[1];
  return new;
end;
$$;

drop trigger if exists customers_sanitize_emails on public.customers;
create trigger customers_sanitize_emails
before insert or update of email, email_recipients on public.customers
for each row execute function public.sanitize_customer_emails();

create or replace function public.sanitize_order_email()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.email := public.sanitize_email_text(new.email);
  return new;
end;
$$;

drop trigger if exists orders_sanitize_email on public.orders;
create trigger orders_sanitize_email
before insert or update of email on public.orders
for each row execute function public.sanitize_order_email();

