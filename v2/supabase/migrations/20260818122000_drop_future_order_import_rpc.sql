-- The audited import completed successfully; remove the temporary write surface.
drop function if exists public.import_future_orders(text, jsonb);
