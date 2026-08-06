-- הסרת מושגי "שולמה / לא שולמה" מהזמנות ומחשבוניות.
-- אין כאן מחיקה של מסמך או הזמנה: נתוני עבר מומרים לסטטוסים הקיימים.

alter table public.invoices drop constraint if exists invoices_status_check;
update public.invoices set status = 'active' where status in ('unpaid', 'paid');
alter table public.invoices alter column status set default 'active';
alter table public.invoices add constraint invoices_status_check
  check (status in ('active', 'cancelled'));

alter table public.orders drop constraint if exists orders_status_check;
update public.orders
   set status = 'shipped',
       shipped_at = coalesce(shipped_at, paid_at, created_at, now()),
       archived_at = coalesce(archived_at, paid_at, created_at, now())
 where status = 'paid';
alter table public.orders add constraint orders_status_check
  check (status in ('pending', 'ready', 'shipped', 'cancelled'));

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
