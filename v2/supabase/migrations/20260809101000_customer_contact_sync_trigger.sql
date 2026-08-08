-- Synchronize customer contact details to order snapshots regardless of whether
-- the edit was made by an admin or by the customer in the personal area.

create or replace function public.sync_customer_contact_to_orders()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  update public.orders
     set contact_name = new.name,
         phone = new.phone,
         email = new.email
   where customer_id = new.id;
  return new;
end $$;

drop trigger if exists customers_sync_contact_to_orders on public.customers;
create trigger customers_sync_contact_to_orders
after update of name, phone, email on public.customers
for each row
when (
  old.name is distinct from new.name
  or old.phone is distinct from new.phone
  or old.email is distinct from new.email
)
execute function public.sync_customer_contact_to_orders();

-- Backfill orders whose customer card had already been updated before this trigger existed.
update public.orders o
   set contact_name = c.name,
       phone = c.phone,
       email = c.email
  from public.customers c
 where o.customer_id = c.id
   and (
     o.contact_name is distinct from c.name
     or o.phone is distinct from c.phone
     or o.email is distinct from c.email
   );
