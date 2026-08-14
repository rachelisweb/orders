-- אורחים מקבלים רק זמינות לפי מידה, לעולם לא את הכמות המדויקת.
create or replace function public.get_guest_catalog()
returns jsonb
language sql
stable
security definer set search_path = public
as $$
  select jsonb_build_object(
    'collections', coalesce((
      select jsonb_agg(to_jsonb(c) order by c.sort_order)
        from public.collections c where c.is_active
    ), '[]'::jsonb),
    'products', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'model', p.model, 'description', p.description,
        'image_url', p.image_url, 'sort_order', p.sort_order,
        'collection_id', p.collection_id
      ) order by p.sort_order)
        from public.products p where p.is_active
    ), '[]'::jsonb),
    'inventory', coalesce((
      select jsonb_agg(jsonb_build_object(
        'product_id', a.product_id, 'size', a.size, 'available', true
      )) from public.get_available_inventory() a where a.qty > 0
    ), '[]'::jsonb)
  )
$$;

revoke all on function public.get_guest_catalog() from public, authenticated;
grant execute on function public.get_guest_catalog() to anon;

-- CREATE FUNCTION מעניק EXECUTE ל-PUBLIC כברירת מחדל. מבטלים זאת
-- במפורש כדי שאורח לא יוכל לעקוף את הקטלוג ולקבל כמויות מדויקות.
revoke execute on function public.get_available_inventory() from public, anon;
grant execute on function public.get_available_inventory() to authenticated;

-- מעטפת הזמנה שמונעת שימוש בשגיאות שרת כאורקל לגילוי כמות המלאי.
-- פונקציית הליבה נשארת פרטית ונקראת רק מתוך המעטפת המאובטחת.
create or replace function public.submit_guest_order(
  p_business_name text,
  p_phone         text,
  p_email         text,
  p_notes         text,
  p_items         jsonb
)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
begin
  return public.create_guest_order(
    p_business_name, p_phone, p_email, p_notes, p_items
  );
exception when others then
  if sqlerrm like '%אך יש רק % במלאי%' then
    raise exception 'הכמות המבוקשת אינה זמינה כרגע';
  end if;
  raise;
end $$;

revoke all on function public.create_guest_order(text, text, text, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.submit_guest_order(text, text, text, text, jsonb)
  from public, authenticated;
grant execute on function public.submit_guest_order(text, text, text, text, jsonb)
  to anon;
