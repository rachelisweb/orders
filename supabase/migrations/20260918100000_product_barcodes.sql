-- Optional admin-only barcode. It is sent as the iCount line SKU so accounts
-- configured to display SKUs show it as a separate document column.
alter table public.products
  add column if not exists barcode text;

alter table public.products
  drop constraint if exists products_barcode_length_check;
alter table public.products
  add constraint products_barcode_length_check
  check (barcode is null or (barcode = btrim(barcode) and length(barcode) between 1 and 100));

