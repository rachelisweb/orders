-- Barcode support was removed from the product workflow and generated documents.
alter table public.products
  drop constraint if exists products_barcode_length_check;

alter table public.products
  drop column if exists barcode;
