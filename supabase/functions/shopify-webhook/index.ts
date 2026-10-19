// ============================================================
// רחליס — webhooks משופיפיי: מכירה באתר מורידה מהמלאי באפליקציה
//
//   orders/create     — מוריד את הכמויות שנמכרו
//   refunds/create    — מחזיר למלאי פריטים שהוחזרו עם restock
//   orders/cancelled  — כנ"ל, דרך ההחזרים שבתוך ההזמנה המבוטלת
//
// כל אירוע נרשם ב-shopify_stock_events ומוחל פעם אחת בלבד, גם אם
// שופיפיי שולח אותו שוב. החתימה נבדקת מול SHOPIFY_CLIENT_SECRET.
// הפונקציה נפרסת עם verify_jwt=false — ההזדהות היא חתימת ה-HMAC.
// ============================================================

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const CLIENT_SECRET = Deno.env.get('SHOPIFY_CLIENT_SECRET') ?? '';

async function validHmac(raw: Uint8Array<ArrayBuffer>, header: string | null): Promise<boolean> {
  if (!header || !CLIENT_SECRET) return false;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(CLIENT_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, raw));
  let expected: Uint8Array;
  try {
    expected = Uint8Array.from(atob(header), (c) => c.charCodeAt(0));
  } catch {
    return false;
  }
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig[i] ^ expected[i];
  return diff === 0;
}

type Line = { sku: string; qty: number; product_id: number | null; variant_title: string | null };

// הדגם מזוהה לפי המוצר בשופיפיי (הקישור שנשמר בסנכרון), ואם אין — לפי המק"ט
function lineOf(li: any, qty: number): Line {
  return { sku: li?.sku || '', qty, product_id: li?.product_id ?? null, variant_title: li?.variant_title ?? null };
}

async function applyEvent(
  sb: SupabaseClient, key: string, topic: string, orderId: number | null, orderName: string | null,
  direction: 1 | -1, lines: Line[], requiresEvent: string | null = null,
) {
  const { data, error } = await sb.rpc('apply_shopify_stock_event', {
    p_event_key: key,
    p_topic: topic,
    p_order_id: orderId,
    p_order_name: orderName,
    p_direction: direction,
    p_lines: lines,
    p_requires_event: requiresEvent,
  });
  if (error) throw error;
  return data;
}

// שורות שחזרו למלאי בהחזר (ביטול/החזרה). no_restock לא נוגע במלאי.
function restockedLines(refund: any) {
  return (refund.refund_line_items || [])
    .filter((r: any) => r.restock_type && r.restock_type !== 'no_restock')
    .map((r: any) => lineOf(r.line_item, Number(r.quantity) || 0))
    .filter((l: Line) => l.qty > 0);
}

async function applyRefund(sb: SupabaseClient, topic: string, refund: any, orderId: number, orderName: string | null) {
  const lines = restockedLines(refund);
  if (!lines.length) return { skipped: 'no restock' };
  // אותו מפתח לשני הנושאים: ביטול שולח גם refunds/create וגם orders/cancelled
  return applyEvent(sb, `refund:${refund.id}`, topic, orderId, orderName, 1, lines, `order:${orderId}`);
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });

  const raw = new Uint8Array(await req.arrayBuffer());
  if (!(await validHmac(raw, req.headers.get('x-shopify-hmac-sha256')))) {
    return new Response('invalid signature', { status: 401 });
  }

  const topic = req.headers.get('x-shopify-topic') || '';
  let payload: any;
  try {
    payload = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return new Response('bad json', { status: 400 });
  }

  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  try {
    let result: unknown = { ignored: topic };
    if (topic === 'orders/create') {
      const lines = (payload.line_items || [])
        .map((li: any) => lineOf(li, Number(li.quantity) || 0))
        .filter((l: Line) => l.qty > 0);
      result = await applyEvent(sb, `order:${payload.id}`, topic, payload.id, payload.name ?? null, -1, lines);
    } else if (topic === 'refunds/create') {
      result = await applyRefund(sb, topic, payload, payload.order_id, null);
    } else if (topic === 'orders/cancelled') {
      const results = [];
      for (const refund of payload.refunds || []) {
        results.push(await applyRefund(sb, topic, refund, payload.id, payload.name ?? null));
      }
      result = results;
    }
    return new Response(JSON.stringify({ ok: true, result }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    // 500 → שופיפיי ינסה שוב; המפתח הייחודי מונע החלה כפולה
    console.error('shopify-webhook', topic, e);
    return new Response(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
});
