// ============================================================
// רחליס — סנכרון מלאי ומחירים ל-Shopify
//
// גרסת Edge Function של "עדכון מלאי שופיפיי.js" מ-Apps Script.
// אותה לוגיקה בדיוק: יצירת מוצר חסר, עדכון רק כשיש שינוי אמיתי,
// ומרווח בין קריאות כדי לא לחטוף 429.
// ההבדל היחיד: מקור הנתונים הוא Postgres ולא Google Sheets.
//
// פריסה:
//   supabase functions deploy shopify-sync
//   supabase secrets set SHOPIFY_STORE=... SHOPIFY_CLIENT_ID=... SHOPIFY_CLIENT_SECRET=...
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const SHOPIFY_STORE  = Deno.env.get('SHOPIFY_STORE') ?? '';
const CLIENT_ID      = Deno.env.get('SHOPIFY_CLIENT_ID')!;
const CLIENT_SECRET  = Deno.env.get('SHOPIFY_CLIENT_SECRET')!;
const API_VERSION    = Deno.env.get('SHOPIFY_API_VERSION') ?? '2026-04';
const SYNC_SECRET    = Deno.env.get('SYNC_SECRET') ?? '';       // ל-cron בלבד

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-sync-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const API = `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}`;
const SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL', '5XL'];

// Shopify מגביל ל-2 בקשות לשנייה ב-REST. 550ms נותן שוליים.
const MIN_INTERVAL = 550;
let lastCall = 0;

async function throttledFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const wait = MIN_INTERVAL - (Date.now() - lastCall);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));

  let res = await fetch(url, init);
  lastCall = Date.now();

  // כיבוד Retry-After כשבכל זאת נחטפנו
  if (res.status === 429) {
    const retry = Number(res.headers.get('Retry-After') || 2) * 1000;
    await new Promise((r) => setTimeout(r, retry));
    res = await fetch(url, init);
    lastCall = Date.now();
  }
  return res;
}

async function getAccessToken(): Promise<string> {
  const res = await throttledFetch(`https://${SHOPIFY_STORE}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'client_credentials',
    }),
  });
  if (!res.ok) throw new Error(`התחברות לשופיפיי נכשלה: ${res.status}`);
  return (await res.json()).access_token;
}

function headers(token: string) {
  return { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };
}

async function getLocationId(token: string): Promise<number> {
  const res = await throttledFetch(`${API}/locations.json`, { headers: headers(token) });
  const { locations } = await res.json();
  if (!locations?.length) throw new Error('לא נמצא Location ID בחנות');
  return locations[0].id;
}

async function getAllProducts(token: string) {
  const all: any[] = [];
  let url: string | null = `${API}/products.json?fields=id,title,tags,variants&limit=250`;

  while (url) {
    const res: Response = await throttledFetch(url, { headers: headers(token) });
    if (!res.ok) throw new Error(`שליפת מוצרים נכשלה: ${res.status}`);
    all.push(...((await res.json()).products || []));

    const link = res.headers.get('link') || '';
    const m = link.includes('rel="next"') ? link.match(/<([^>]+)>;\s*rel="next"/) : null;
    url = m ? m[1] : null;
  }
  return all;
}

async function setInventory(token: string, locationId: number, itemId: number, qty: number) {
  await throttledFetch(`${API}/inventory_levels/set.json`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({ location_id: locationId, inventory_item_id: itemId, available: qty }),
  });
}

async function createProduct(token: string, locationId: number, p: any) {
  const variants = SIZES.map((size) => ({
    option1: size,
    price: String(p.price ?? 0),
    sku: `${p.model}-${size}`,
    inventory_management: 'shopify',
  }));

  const payload: any = {
    product: {
      title: `דגם ${p.model}`,
      body_html: p.description ? `<p>${p.description}</p>` : undefined,
      status: 'draft',                      // נשאר טיוטה עד שמאשרים ידנית בשופיפיי
      options: [{ name: 'מידה' }],
      variants,
    },
  };
  if (p.shopify_tag) payload.product.tags = p.shopify_tag;
  if (p.image_url)   payload.product.images = [{ src: p.image_url }];

  const res = await throttledFetch(`${API}/products.json`, {
    method: 'POST', headers: headers(token), body: JSON.stringify(payload),
  });

  if (res.status !== 201) throw new Error(`יצירת דגם ${p.model} נכשלה: ${await res.text()}`);

  const created = (await res.json()).product;
  for (const v of created.variants) {
    const size = v.sku?.split('-').pop();
    const qty = p.stock[size!] ?? 0;
    if (qty > 0) await setInventory(token, locationId, v.inventory_item_id, qty);
  }
  return created;
}

async function updateProduct(token: string, locationId: number, existing: any, p: any) {
  const priceUpdates: any[] = [];
  const stockUpdates: { itemId: number; qty: number }[] = [];

  for (const size of SIZES) {
    const sku = `${p.model}-${size}`;
    const variant = existing.variants.find((v: any) => v.sku === sku);
    if (!variant) continue;

    const wantQty   = p.stock[size] ?? 0;
    const wantPrice = Number(p.price ?? 0);

    if (Number(variant.price) !== wantPrice) {
      priceUpdates.push({ id: variant.id, price: String(wantPrice) });
    }
    if (Number(variant.inventory_quantity) !== wantQty) {
      stockUpdates.push({ itemId: variant.inventory_item_id, qty: wantQty });
    }
  }

  // אין שינוי — לא שורפים קריאות API
  if (!priceUpdates.length && !stockUpdates.length) return 'unchanged';

  if (priceUpdates.length) {
    await throttledFetch(`${API}/products/${existing.id}.json`, {
      method: 'PUT',
      headers: headers(token),
      body: JSON.stringify({ product: { id: existing.id, variants: priceUpdates } }),
    });
  }
  for (const u of stockUpdates) {
    await setInventory(token, locationId, u.itemId, u.qty);
  }
  return 'updated';
}

// ── קולקציה חכמה לפי תגית ──────────────────────────────────
async function ensureSmartCollection(token: string, title: string, tag: string) {
  const check = await throttledFetch(
    `${API}/smart_collections.json?title=${encodeURIComponent(title)}`,
    { headers: headers(token) },
  );
  if (check.ok) {
    const { smart_collections } = await check.json();
    if (smart_collections?.length) return;
  }

  await throttledFetch(`${API}/smart_collections.json`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({
      smart_collection: {
        title,
        rules: [{ column: 'tag', relation: 'equals', condition: tag }],
      },
    }),
  });
}

// ============================================================
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

  const started = Date.now();
  const summary = { created: 0, updated: 0, unchanged: 0, errors: [] as string[] };

  try {
    const sb = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // שתי דרכי כניסה: הסוד המשותף (pg_cron) או JWT של מנהל (כפתור בממשק)
    const secretOk = !!SYNC_SECRET && req.headers.get('x-sync-secret') === SYNC_SECRET;

    if (!secretOk) {
      const jwt = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
      if (!jwt) return json({ ok: false, error: 'נדרשת הזדהות' }, 401);

      const { data: { user }, error: authErr } = await sb.auth.getUser(jwt);
      if (authErr || !user) return json({ ok: false, error: 'הזדהות לא תקינה' }, 401);

      const { data: prof } = await sb.from('profiles').select('role').eq('id', user.id).maybeSingle();
      if (prof?.role !== 'admin') return json({ ok: false, error: 'הפעולה מותרת למנהל בלבד' }, 403);
    }

    if (!SHOPIFY_STORE || !CLIENT_ID || !CLIENT_SECRET) {
      return json({ ok: false, error: 'חיבור Shopify טרם הוגדר' }, 503);
    }

    const { data: rows, error } = await sb
      .from('products')
      .select('id, model, description, image_url, retail_price, is_active, inventory(size, qty), collections(shopify_tag, name)')
      .eq('is_active', true)
      .order('model');
    if (error) throw error;

    // לחנות עולה מחיר לקוח קצה — לא הסיטונאי ולא העלות
    const products = (rows || []).map((r: any) => ({
      model: r.model,
      description: r.description,
      image_url: r.image_url,
      price: r.retail_price,
      shopify_tag: r.collections?.shopify_tag || null,
      collection_name: r.collections?.name || null,
      stock: Object.fromEntries((r.inventory || []).map((i: any) => [i.size, i.qty])),
    }));

    const token = await getAccessToken();
    const locationId = await getLocationId(token);

    // מוודאים שכל קולקציה עם תגית קיימת גם בשופיפיי
    const tagged = new Map<string, string>();
    for (const p of products) {
      if (p.shopify_tag && p.collection_name) tagged.set(p.shopify_tag, p.collection_name);
    }
    for (const [tag, name] of tagged) {
      await ensureSmartCollection(token, name, tag);
    }

    const shopify = await getAllProducts(token);
    // אינדוקס לפי קידומת ה-SKU, כמו בקוד המקורי
    const bySku = new Map<string, any>();
    for (const sp of shopify) {
      for (const v of sp.variants || []) {
        const m = v.sku?.match(/^(.+)-(XS|S|M|L|XL|XXL|3XL|4XL|5XL)$/);
        if (m && !bySku.has(m[1])) bySku.set(m[1], sp);
      }
    }

    for (const p of products) {
      // Edge Function מוגבל בזמן ריצה — עוצרים בבטחה כמו בקוד המקורי
      if (Date.now() - started > 130_000) {
        summary.errors.push('הסנכרון נעצר בגלל מגבלת זמן — הרץ שוב להשלמה');
        break;
      }
      try {
        const existing = bySku.get(p.model);
        if (existing) {
          const r = await updateProduct(token, locationId, existing, p);
          r === 'updated' ? summary.updated++ : summary.unchanged++;
        } else {
          await createProduct(token, locationId, p);
          summary.created++;
        }
      } catch (e) {
        summary.errors.push(`${p.model}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    return json({ ok: true, ...summary, seconds: Math.round((Date.now() - started) / 1000) });
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : String(e), ...summary }, 500);
  }
});
