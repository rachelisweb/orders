alter table public.orders
  add column if not exists future_order_manual_pending boolean not null default false;

-- A manual return from the future-season bucket is authoritative. Automatic
-- collection classification must not move that order back on a later update.
create or replace function public.preserve_manual_pending_order()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- Any explicit transition out of the future bucket becomes a persistent
  -- manual override. Existing RPCs do not need to know about the new marker.
  if old.future_order_at is not null and new.future_order_at is null then
    new.future_order_manual_pending := true;
    return new;
  end if;

  -- Ignore later attempts by the automatic collection classifier.
  if old.future_order_at is null
     and old.future_order_manual_pending
     and new.future_order_at is not null
     and new.future_order_source = 'automatic' then
    new.future_order_at := null;
    new.future_order_manual_pending := true;
    return new;
  end if;

  -- A later explicit move to the future bucket intentionally clears the lock.
  if new.future_order_at is not null
     and new.future_order_source is distinct from 'automatic' then
    new.future_order_manual_pending := false;
  end if;

  return new;
end;
$$;

drop trigger if exists orders_preserve_manual_pending on public.orders;
create trigger orders_preserve_manual_pending
before update of future_order_at, future_order_source on public.orders
for each row execute function public.preserve_manual_pending_order();

-- A split child inherits the parent's manual decision as well.
create or replace function public.inherit_manual_pending_on_split()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.split_from_order_id is not null then
    select coalesce(o.future_order_manual_pending, false)
      into new.future_order_manual_pending
    from public.orders o
    where o.id = new.split_from_order_id;
  end if;
  return new;
end;
$$;

drop trigger if exists orders_inherit_manual_pending_on_split on public.orders;
create trigger orders_inherit_manual_pending_on_split
before insert on public.orders
for each row execute function public.inherit_manual_pending_on_split();
