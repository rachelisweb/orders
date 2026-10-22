// ============================================================
// רחליס — סנכרון מלאי, מחיר וקולקציה לשופיפיי
//
// האפליקציה היא מקור האמת. כל שינוי שמשפיע על דגם (מלאי, הזמנה
// סיטונאית פתוחה, מחיר לקוח קצה, קולקציה) מכניס אותו לתור
// shopify_sync_queue, ו-pg_cron מריץ את הפונקציה כל דקה על התור.
//
// מצבים (body):
//   { mode: 'queue' }               — מרוקן את התור (cron כל דקה)
//   { mode: 'full' }                — מכניס את כל הדגמים לתור ומסנכרן
//   { mode: 'full', dryRun: true }  — מחזיר מה היה משתנה, בלי לכתוב כלום
//   { action: 'register_webhooks' } — רושם webhooks של הזמנות והחזרים
//
// כניסה: הסוד המשותף מ-Vault (pg_cron) או JWT של מנהל (כפתור בממשק).
// סודות: SHOPIFY_STORE, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET
// ============================================================

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const SHOPIFY_STORE = Deno.env.get('SHOPIFY_STORE') ?? '';
const CLIENT_ID     = Deno.env.get('SHOPIFY_CLIENT_ID') ?? '';
const CLIENT_SECRET = Deno.env.get('SHOPIFY_CLIENT_SECRET') ?? '';
const API_VERSION   = Deno.env.get('SHOPIFY_API_VERSION') ?? '2026-04';
const WEBHOOK_URL   = `${Deno.env.get('SUPABASE_URL')}/functions/v1/shopify-webhook`;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-sync-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL', '5XL'];
const SIZE_RE = /^(.+)-(XS|S|M|L|XL|XXL|3XL|4XL|5XL)$/i;
// דגם שהשם שלו כולל תיאור ("2601 סרפן קטיפה…", "חצאית טאפט שחורה 3611") —
// המק"ט באתר בנוי מהספרות שבשם: בתחילתו, בסופו או באמצעו
const LEADING_CODE_RE = /^([0-9]{3,6}[A-Z]?(?:-[0-9]+)?)\s/i;
const TRAILING_CODE_RE = /\s([0-9]{3,6}[A-Z]?(?:-[0-9]+)?)$/i;
const ANY_CODE_RE = /(?:^|\s)([0-9]{3,6}[A-Z]?(?:-[0-9]+)?)(?=\s|$)/i;
const WEBHOOK_TOPICS = ['ORDERS_CREATE', 'REFUNDS_CREATE', 'ORDERS_CANCELLED'];

// עוצרים לפני מגבלת הזמן של ה-Edge Function; מה שנשאר בתור ימשיך בריצה הבאה
const TIME_BUDGET_MS = 110_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Shopify GraphQL ──────────────────────────────────────────
class Shopify {
  private token = '';

  async connect() {
    const res = await fetch(`https://${SHOPIFY_STORE}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: 'client_credentials' }),
    });
    if (!res.ok) throw new Error(`התחברות לשופיפיי נכשלה (${res.status}): ${(await res.text()).slice(0, 200)}`);
    this.token = (await res.json()).access_token;
  }

  async gql(query: string, variables: Record<string, unknown> = {}): Promise<any> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await fetch(`https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/graphql.json`, {
        method: 'POST',
        headers: { 'X-Shopify-Access-Token': this.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
      });
      if (res.status === 429 || res.status >= 500) { await sleep(1000 * (attempt + 1)); continue; }

      const body = await res.json().catch(() => ({}));
      const errors = body.errors;
      if (Array.isArray(errors) && errors.some((e: any) => e.extensions?.code === 'THROTTLED')) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      if (errors) {
        const msg = Array.isArray(errors) ? errors.map((e: any) => e.message).join('; ') : JSON.stringify(errors);
        throw new Error(`שופיפיי (${res.status}): ${msg}`);
      }

      // שומרים מרווח בדלי הקריאות כדי לא להגיע לחסימה
      const available = body.extensions?.cost?.throttleStatus?.currentlyAvailable;
      if (typeof available === 'number' && available < 150) await sleep(1000);
      return body.data;
    }
    throw new Error('שופיפיי עמוס — ננסה שוב בריצה הבאה');
  }
}

function userErrors(payload: any, what: string) {
  const errs = payload?.userErrors || [];
  if (errs.length) throw new Error(`${what}: ${errs.map((e: any) => e.message).join('; ')}`);
}

// ── קריאת מצב החנות ─────────────────────────────────────────
const CATALOG_QUERY = `
query Catalog($cursor: String) {
  products(first: 50, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id title status tags
      mediaCount { count }
      variants(first: 12) {
        nodes {
          id sku price inventoryQuantity
          selectedOptions { value }
          inventoryItem { id tracked }
        }
      }
    }
  }
}`;

async function loadCatalog(shop: Shopify) {
  const products: any[] = [];
  let cursor: string | null = null;
  do {
    const data: any = await shop.gql(CATALOG_QUERY, { cursor });
    products.push(...data.products.nodes);
    cursor = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
  } while (cursor);

  const loc = await shop.gql(`{ locations(first: 5) { nodes { id isActive } } }`);
  const location = loc.locations.nodes.find((l: any) => l.isActive) ?? loc.locations.nodes[0];
  if (!location) throw new Error('לא נמצא מיקום מלאי בחנות');

  const cols = await shop.gql(`{ collections(first: 100) { nodes { title ruleSet { rules { column relation condition } } } } }`);
  const smartTags = new Set<string>();
  for (const c of cols.collections.nodes) {
    for (const r of c.ruleSet?.rules || []) {
      if (r.column === 'TAG' && r.relation === 'EQUALS') smartTags.add(String(r.condition).toLowerCase());
    }
  }
  return { products, locationId: location.id as string, smartTags };
}

// שם דגם עם טאבים/רווחים כפולים (מהעתקה מאקסל) → רווח אחד
function cleanName(model: string): string {
  return model.replace(/\s+/g, ' ').trim();
}

// הקוד שבשם הדגם: השם כולו כשהוא קוד נקי, אחרת הספרות בתחילת השם, בסופו או באמצעו
function modelCode(model: string): string | null {
  const m = cleanName(model);
  if (/^[0-9A-Za-z-]+$/.test(m)) return m.toUpperCase();
  const c = m.match(LEADING_CODE_RE) || m.match(TRAILING_CODE_RE) || m.match(ANY_CODE_RE);
  return c ? c[1].toUpperCase() : null;
}

// בסיס המק"ט של כל דגם. קוד שמשותף לכמה דגמים ("3619 חום…" / "3619 שחור…") מקבל
// את המילה הראשונה שמבדילה את הדגם מהאחרים ("3619 חום"), כמו "3616 חום" שכבר באתר.
function assignSkuBases(products: any[]) {
  const groups = new Map<string, any[]>();
  for (const p of products) {
    const code = modelCode(p.model);
    p.sku_base = code;
    if (code) groups.set(code, [...(groups.get(code) || []), p]);
  }
  for (const [code, group] of groups) {
    if (group.length < 2) continue;
    for (const p of group) {
      const name = cleanName(p.model);
      if (name.toUpperCase() === code) continue;            // הדגם שהשם שלו הוא הקוד עצמו שומר עליו
      const words = name.split(' ').filter((w) => w.toUpperCase() !== code);
      const others = group.filter((o) => o !== p).map((o) => new Set(cleanName(o.model).split(' ')));
      const distinct = words.find((w) => others.every((set) => !set.has(w)));
      p.sku_base = distinct ? `${code} ${distinct}`.toUpperCase() : name.toUpperCase();
    }
  }
  const count = new Map<string, number>();
  for (const p of products) if (p.sku_base) count.set(p.sku_base, (count.get(p.sku_base) || 0) + 1);
  for (const p of products) p.ambiguous = !!p.sku_base && (count.get(p.sku_base) || 0) > 1;
}

function variantSize(v: any): string | null {
  const m = v.sku?.match(SIZE_RE);
  if (m) return m[2].toUpperCase();
  const opt = (v.selectedOptions || []).map((o: any) => String(o.value).toUpperCase()).find((x: string) => SIZES.includes(x));
  return opt ?? null;
}

// ── תכנון שינויים לדגם ──────────────────────────────────────
type Plan = {
  productId: string;
  model: string;
  action: 'create' | 'update' | 'none' | 'skip';
  shopifyId?: string;
  title?: string;
  reason?: string;
  stock: { size: string; itemId: string; from: number; to: number }[];
  track: string[];
  variantUpdates: { id: string; price?: string; sku?: string }[];
  priceFrom?: string;
  priceTo?: string;
  skuFixes: { from: string; to: string }[];
  tagsAdd: string[];
  tagsRemove: string[];
  warnings: string[];
  addImage?: string;
  addedMediaId?: string | null;
  create?: { tags: string[]; price: string; stock: Record<string, number>; description: string | null; sku: string };
};

function planProduct(p: any, shopifyProduct: any | null, seasonTags: Set<string>): Plan {
  const plan: Plan = {
    productId: p.id, model: p.model, action: 'none', stock: [], track: [], variantUpdates: [],
    skuFixes: [], tagsAdd: [], tagsRemove: [], warnings: [],
  };
  // מחיר 0 = עוד לא נקבע: לא דורסים את המחיר באתר, ודגם חדש נוצר כטיוטה במחיר 0
  const price = Number(p.retail_price) > 0 ? Number(p.retail_price).toFixed(2) : null;
  const seasonTag: string | null = p.season_tag || null;

  if (!shopifyProduct) {
    if (!p.is_active) return plan;
    if (p.no_create) {
      plan.reason = 'הוחרג — נמחק מהאתר בכוונה ולא נוצר מחדש';
      return plan;
    }
    // דגם בלי מלאי זמין לא נוצר באתר — גם אם נמחק משם. יחזור כטיוטה רק כשיהיה לו מלאי.
    const units = Object.values(p.stock as Record<string, number>).reduce((a, b) => a + b, 0);
    if (units <= 0) {
      plan.reason = 'אין מלאי זמין — לא נוצר באתר';
      return plan;
    }
    if (!p.sku_base) {
      plan.action = 'skip';
      plan.reason = 'אין ספרות בשם הדגם — אי אפשר לבנות מק"ט, לא נוצר באתר';
      return plan;
    }
    if (p.ambiguous) {
      plan.action = 'skip';
      plan.reason = `המק"ט ${p.sku_base} יוצא זהה לדגם אחר — יש לשנות את שם הדגם`;
      return plan;
    }
    plan.action = 'create';
    plan.create = { tags: seasonTag ? [seasonTag] : [], price: price ?? '0.00', stock: p.stock, description: p.description, sku: p.sku_base };
    if (p.image_url) plan.addImage = p.image_url;
    if (!price) plan.warnings.push('מחיר לקוח קצה 0 — נוצר כטיוטה, לא לפרסם לפני עדכון המחיר באפליקציה');
    return plan;
  }

  plan.shopifyId = shopifyProduct.id;
  plan.title = shopifyProduct.title;

  const variants = shopifyProduct.variants.nodes;
  const seen = new Set<string>();
  for (const v of variants) {
    const size = variantSize(v);
    if (!size) continue;
    seen.add(size);

    const want = p.stock[size] ?? 0;
    const have = Number(v.inventoryQuantity ?? 0);
    if (!v.inventoryItem.tracked) plan.track.push(v.inventoryItem.id);
    if (have !== want || !v.inventoryItem.tracked) {
      plan.stock.push({ size, itemId: v.inventoryItem.id, from: have, to: want });
    }

    // מחיר ותגיות מסונכרנים רק לדגם פעיל; המלאי תמיד
    if (!p.is_active) continue;
    const update: { id: string; price?: string; sku?: string } = { id: v.id };
    // מק"ט מתוקן רק כשהדגם שונה שם באפליקציה (הבסיס הקיים לא מתאים לאף שם מוכר)
    const base = v.sku?.match(SIZE_RE)?.[1]?.toUpperCase();
    if (base && base !== cleanName(p.model).toUpperCase() && base !== p.sku_base && p.sku_base) {
      update.sku = `${p.sku_base}-${size}`;
      plan.skuFixes.push({ from: v.sku, to: update.sku });
    }
    if (price && Number(v.price) !== Number(price)) {
      update.price = price;
      plan.priceFrom = v.price;
      plan.priceTo = price;
    }
    if (update.sku || update.price) plan.variantUpdates.push(update);
  }

  if (p.is_active) {
    for (const size of SIZES) {
      if (!seen.has(size) && (p.stock[size] ?? 0) > 0) {
        plan.warnings.push(`למידה ${size} יש ${p.stock[size]} במלאי אבל אין לה וריאנט באתר`);
      }
    }
    if (!price) plan.warnings.push('חסר מחיר לקוח קצה — המחיר באתר לא שונה');

    const tags = new Set((shopifyProduct.tags || []).map((t: string) => t.toLowerCase()));
    if (seasonTag && !tags.has(seasonTag)) plan.tagsAdd.push(seasonTag);
    for (const t of shopifyProduct.tags || []) {
      const lower = t.toLowerCase();
      if (seasonTags.has(lower) && lower !== seasonTag) plan.tagsRemove.push(t);
    }
  }

  // תמונה מהאפליקציה רק למוצר שאין בו תמונות שהועלו באתר (כל התמונות שלו הגיעו מהאפליקציה, או שאין בכלל)
  const appImages: Set<string> = p.app_images;
  const mediaCount = Number(shopifyProduct.mediaCount?.count ?? 0);
  if (p.is_active && p.image_url && !appImages.has(p.image_url) && mediaCount <= appImages.size) {
    plan.addImage = p.image_url;
  }

  const changed = plan.stock.length || plan.variantUpdates.length || plan.tagsAdd.length || plan.tagsRemove.length || plan.addImage;
  plan.action = changed ? 'update' : 'none';
  return plan;
}

// ── ביצוע ────────────────────────────────────────────────────
async function applyPlan(shop: Shopify, plan: Plan, locationId: string, p: any): Promise<string | null> {
  if (plan.action === 'create') {
    const c = plan.create!;
    const data = await shop.gql(`
      mutation Create($input: ProductSetInput!) {
        productSet(input: $input, synchronous: true) {
          product { id }
          userErrors { field message }
        }
      }`, {
      input: {
        title: `דגם ${cleanName(plan.model)}`,
        descriptionHtml: c.description ? `<p>${escapeHtml(c.description)}</p>` : undefined,
        status: 'DRAFT',                        // נשאר טיוטה עד שמפרסמים ידנית בשופיפיי
        tags: c.tags,
        productOptions: [{ name: 'מידה', position: 1, values: SIZES.map((name) => ({ name })) }],
        variants: SIZES.map((size, i) => ({
          position: i + 1,
          optionValues: [{ optionName: 'מידה', name: size }],
          sku: `${p.sku_base}-${size}`,
          price: c.price,
          inventoryItem: { tracked: true },
          inventoryQuantities: [{ locationId, name: 'available', quantity: c.stock[size] ?? 0 }],
        })),
      },
    });
    userErrors(data.productSet, 'יצירת מוצר');
    const createdId = data.productSet.product.id;
    if (plan.addImage) plan.addedMediaId = await addImage(shop, createdId, plan.addImage, cleanName(plan.model));
    return createdId;
  }

  if (plan.action !== 'update') return plan.shopifyId ?? null;

  if (plan.variantUpdates.length) {
    const data = await shop.gql(`
      mutation Variants($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          userErrors { field message }
        }
      }`, {
      productId: plan.shopifyId,
      variants: plan.variantUpdates.map((u) => ({
        id: u.id,
        ...(u.price ? { price: u.price } : {}),
        ...(u.sku ? { inventoryItem: { sku: u.sku } } : {}),
      })),
    });
    userErrors(data.productVariantsBulkUpdate, 'עדכון מחיר/מק"ט');
  }

  if (plan.tagsAdd.length) {
    const data = await shop.gql(`
      mutation Add($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { field message } } }`,
      { id: plan.shopifyId, tags: plan.tagsAdd });
    userErrors(data.tagsAdd, 'הוספת תגית');
  }
  if (plan.tagsRemove.length) {
    const data = await shop.gql(`
      mutation Remove($id: ID!, $tags: [String!]!) { tagsRemove(id: $id, tags: $tags) { userErrors { field message } } }`,
      { id: plan.shopifyId, tags: plan.tagsRemove });
    userErrors(data.tagsRemove, 'הסרת תגית');
  }

  for (const itemId of plan.track) {
    const data = await shop.gql(`
      mutation Track($id: ID!) { inventoryItemUpdate(id: $id, input: { tracked: true }) { userErrors { field message } } }`,
      { id: itemId });
    userErrors(data.inventoryItemUpdate, 'הפעלת מעקב מלאי');
  }

  if (plan.stock.length) {
    // compare-and-set: אם בינתיים נמכר משהו באתר, שופיפיי דוחה ונעדכן בריצה הבאה
    const data = await shop.gql(`
      mutation Stock($input: InventorySetQuantitiesInput!, $key: String!) {
        inventorySetQuantities(input: $input) @idempotent(key: $key) {
          userErrors { field message code }
        }
      }`, {
      key: crypto.randomUUID(),
      input: {
        name: 'available',
        reason: 'correction',
        referenceDocumentUri: `rachelis-app://inventory/${encodeURIComponent(plan.model)}`,
        quantities: plan.stock.map((s) => ({
          inventoryItemId: s.itemId,
          locationId,
          quantity: s.to,
          changeFromQuantity: s.from,
        })),
      },
    });
    userErrors(data.inventorySetQuantities, 'עדכון מלאי');
  }

  if (plan.addImage) plan.addedMediaId = await addImage(shop, plan.shopifyId!, plan.addImage, plan.title || cleanName(plan.model));
  return plan.shopifyId ?? null;
}

// מוסיף תמונה בסוף הגלריה של המוצר; תמונות קיימות לא משתנות
async function addImage(shop: Shopify, productId: string, url: string, alt: string): Promise<string | null> {
  const data = await shop.gql(`
    mutation AddImage($product: ProductUpdateInput!, $media: [CreateMediaInput!]) {
      productUpdate(product: $product, media: $media) {
        product { media(last: 1) { nodes { id } } }
        userErrors { field message }
      }
    }`, { product: { id: productId }, media: [{ originalSource: url, mediaContentType: 'IMAGE', alt }] });
  userErrors(data.productUpdate, 'הוספת תמונה');
  return data.productUpdate.product?.media?.nodes?.[0]?.id ?? null;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!));
}

// ── נתוני האפליקציה ─────────────────────────────────────────
async function loadAppProducts(sb: SupabaseClient) {
  const { data: rows, error } = await sb.from('products')
    .select('id, model, description, retail_price, is_active, image_url, collections(shopify_tag)')
    .order('model');
  if (error) throw error;

  // מלאי זמין = מלאי פחות הזמנות סיטונאיות פתוחות
  const { data: avail, error: availErr } = await sb.rpc('get_available_inventory');
  if (availErr) throw availErr;
  const stock = new Map<string, Record<string, number>>();
  for (const a of avail || []) {
    if (!stock.has(a.product_id)) stock.set(a.product_id, {});
    stock.get(a.product_id)![a.size] = Math.max(0, Number(a.qty) || 0);
  }

  const { data: links } = await sb.from('shopify_product_links').select('product_id, shopify_product_id');
  const linkMap = new Map((links || []).map((l: any) => [l.product_id, l.shopify_product_id]));
  const { data: blocked } = await sb.from('shopify_no_create').select('product_id');
  const noCreate = new Set((blocked || []).map((b: any) => b.product_id));
  const { data: uploaded } = await sb.from('shopify_app_images').select('product_id, image_url');
  const appImages = new Map<string, Set<string>>();
  for (const u of uploaded || []) {
    if (!appImages.has(u.product_id)) appImages.set(u.product_id, new Set());
    appImages.get(u.product_id)!.add(u.image_url);
  }

  return (rows || []).map((r: any) => ({
    id: r.id,
    model: String(r.model).trim(),
    description: r.description,
    retail_price: r.retail_price,
    is_active: r.is_active,
    season_tag: r.collections?.shopify_tag ? String(r.collections.shopify_tag).toLowerCase() : null,
    stock: stock.get(r.id) || {},
    link: linkMap.get(r.id) || null,
    no_create: noCreate.has(r.id),
    image_url: r.image_url ? String(r.image_url).trim() : null,
    app_images: appImages.get(r.id) || new Set<string>(),
  }));
}

async function loadSeasonTags(sb: SupabaseClient) {
  const { data: state } = await sb.from('shopify_sync_state').select('season_tags').eq('id', true).maybeSingle();
  const { data: cols } = await sb.from('collections').select('shopify_tag');
  const tags = new Set<string>((state?.season_tags || []).map((t: string) => t.toLowerCase()));
  for (const c of cols || []) if (c.shopify_tag) tags.add(String(c.shopify_tag).toLowerCase());
  return tags;
}

// קישור שמור → מק"ט זהה לשם הדגם → מק"ט לפי בסיס המק"ט שנגזר מהספרות בשם
function matchShopifyProducts(catalog: any[], appProducts: any[]) {
  const byId = new Map<string, any>();
  const byBase = new Map<string, any>();
  for (const sp of catalog) {
    byId.set(sp.id, sp);
    for (const v of sp.variants.nodes) {
      const m = v.sku?.match(SIZE_RE);
      if (m && !byBase.has(m[1].toUpperCase())) byBase.set(m[1].toUpperCase(), sp);
    }
  }
  assignSkuBases(appProducts);
  return (p: any) => {
    if (p.link && byId.has(p.link)) return byId.get(p.link);
    const exact = byBase.get(p.model.toUpperCase()) || byBase.get(cleanName(p.model).toUpperCase());
    if (exact) return exact;
    if (p.sku_base && !p.ambiguous) return byBase.get(p.sku_base) || null;
    return null;
  };
}

function describe(plan: Plan) {
  return {
    model: plan.model,
    title: plan.title,
    action: plan.action,
    reason: plan.reason,
    stock: plan.stock.map((s) => ({ size: s.size, from: s.from, to: s.to })),
    price: plan.priceTo ? { from: plan.priceFrom, to: plan.priceTo } : undefined,
    skuFixes: plan.skuFixes.length ? plan.skuFixes : undefined,
    tagsAdd: plan.tagsAdd.length ? plan.tagsAdd : undefined,
    tagsRemove: plan.tagsRemove.length ? plan.tagsRemove : undefined,
    untracked: plan.track.length || undefined,
    image: plan.addImage,
    warnings: plan.warnings.length ? plan.warnings : undefined,
    create: plan.create ? { sku: plan.create.sku, price: plan.create.price, tags: plan.create.tags, units: Object.values(plan.create.stock).reduce((a, b) => a + b, 0) } : undefined,
  };
}

// ── Webhooks ────────────────────────────────────────────────
async function registerWebhooks(shop: Shopify) {
  const existing = await shop.gql(`{ webhookSubscriptions(first: 50) { nodes { id topic uri } } }`);
  const have = new Set(existing.webhookSubscriptions.nodes
    .filter((w: any) => w.uri === WEBHOOK_URL).map((w: any) => w.topic));
  const created: string[] = [];
  for (const topic of WEBHOOK_TOPICS) {
    if (have.has(topic)) continue;
    const data = await shop.gql(`
      mutation Hook($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
        webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
          webhookSubscription { id }
          userErrors { field message }
        }
      }`, { topic, sub: { uri: WEBHOOK_URL, format: 'JSON' } });
    userErrors(data.webhookSubscriptionCreate, `רישום ${topic}`);
    created.push(topic);
  }
  return { created, existing: [...have] };
}

// ============================================================
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const startedMs = Date.now();

  // שתי דרכי כניסה: הסוד המשותף (pg_cron) או JWT של מנהל (כפתור בממשק)
  const secret = req.headers.get('x-sync-secret');
  let authorized = false;
  if (secret) {
    const { data } = await sb.rpc('shopify_sync_secret_ok', { p_secret: secret });
    authorized = data === true;
  }
  if (!authorized) {
    const jwt = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!jwt) return json({ ok: false, error: 'נדרשת הזדהות' }, 401);
    const { data: { user }, error: authErr } = await sb.auth.getUser(jwt);
    if (authErr || !user) return json({ ok: false, error: 'הזדהות לא תקינה' }, 401);
    const { data: prof } = await sb.from('profiles').select('role').eq('id', user.id).maybeSingle();
    if (prof?.role !== 'admin') return json({ ok: false, error: 'הפעולה מותרת למנהל בלבד' }, 403);
  }

  if (!SHOPIFY_STORE || !CLIENT_ID || !CLIENT_SECRET) {
    return json({ ok: false, error: 'חיבור Shopify טרם הוגדר (חסרים סודות SHOPIFY_*)' }, 503);
  }

  const body = await req.json().catch(() => ({}));
  const mode: 'queue' | 'full' = body.mode === 'full' ? 'full' : 'queue';
  const dryRun = body.dryRun === true;

  const shop = new Shopify();

  if (body.action === 'scopes') {
    try {
      await shop.connect();
      const data = await shop.gql(`{ currentAppInstallation { accessScopes { handle } } }`);
      return json({ ok: true, scopes: data.currentAppInstallation.accessScopes.map((s: any) => s.handle) });
    } catch (e) {
      return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
    }
  }

  if (body.action === 'register_webhooks') {
    try {
      await shop.connect();
      const result = await registerWebhooks(shop);
      await sb.rpc('shopify_mark_webhooks_registered');
      return json({ ok: true, ...result, uri: WEBHOOK_URL });
    } catch (e) {
      return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
    }
  }

  // ── בדיקה בלבד: שום כתיבה לשופיפיי או לתור ──
  if (dryRun) {
    try {
      await shop.connect();
      const [catalog, products, seasonTags] = await Promise.all([
        loadCatalog(shop), loadAppProducts(sb), loadSeasonTags(sb),
      ]);
      const find = matchShopifyProducts(catalog.products, products);
      const plans = products.map((p) => planProduct(p, find(p), seasonTags));
      const matched = new Set(plans.filter((pl) => pl.shopifyId).map((pl) => pl.shopifyId));
      const missingCollections = [...new Set(products.filter((p) => p.is_active && p.season_tag).map((p) => p.season_tag))]
        .filter((t) => !catalog.smartTags.has(t!));
      return json({
        ok: true,
        dryRun: true,
        summary: {
          create: plans.filter((x) => x.action === 'create').length,
          update: plans.filter((x) => x.action === 'update').length,
          unchanged: plans.filter((x) => x.action === 'none' && x.shopifyId).length,
          skipped: plans.filter((x) => x.action === 'skip').length,
          stockChanges: plans.reduce((n, x) => n + x.stock.length, 0),
          shopifyOnly: catalog.products.filter((sp: any) => !matched.has(sp.id)).map((sp: any) => sp.title),
          missingCollections,
        },
        changes: plans.filter((x) => x.action !== 'none' || x.warnings.length).map(describe),
        seconds: Math.round((Date.now() - startedMs) / 1000),
      });
    } catch (e) {
      return json({ ok: false, dryRun: true, error: e instanceof Error ? e.message : String(e) }, 500);
    }
  }

  // ── סנכרון אמיתי ──
  const { data: claimedAt } = await sb.rpc('shopify_sync_claim', { p_seconds: 170 });
  if (!claimedAt) return json({ ok: true, busy: true, message: 'סנכרון אחר כבר רץ' });
  // שורות שנכנסו לתור עד הרגע הזה מטופלות בריצה; מה שנכנס אחריו נשאר לריצה הבאה
  let runStarted: string = claimedAt;

  let ids: string[] = [];
  const done: string[] = [];
  const failed: { product_id: string; error: string }[] = [];
  const summary = { created: 0, updated: 0, unchanged: 0, skipped: 0, remaining: 0, errors: [] as string[], warnings: [] as string[] };

  try {
    if (mode === 'full') {
      const { error } = await sb.rpc('shopify_enqueue_all');
      if (error) throw error;
    }

    const { data: queue, error: qErr } = await sb.from('shopify_sync_queue')
      .select('product_id, queued_at').lt('attempts', 5).order('queued_at').limit(500);
    if (qErr) throw qErr;
    ids = (queue || []).map((q: any) => q.product_id);
    // בסנכרון מלא השורות נכנסו לתור אחרי תפיסת הנעילה — הנתונים נטענים רק אחרי הקריאה הזו
    for (const q of queue || []) if (q.queued_at > runStarted) runStarted = q.queued_at;

    if (ids.length) {
      await shop.connect();
      const [catalog, allProducts, seasonTags] = await Promise.all([
        loadCatalog(shop), loadAppProducts(sb), loadSeasonTags(sb),
      ]);
      const find = matchShopifyProducts(catalog.products, allProducts);
      const queued = new Set(ids);
      const products = allProducts.filter((p) => queued.has(p.id));

      for (const p of products) {
        if (Date.now() - startedMs > TIME_BUDGET_MS) { summary.remaining++; continue; }
        try {
          const plan = planProduct(p, find(p), seasonTags);
          const shopifyId = await applyPlan(shop, plan, catalog.locationId, p);
          if (plan.addImage && shopifyId) {
            await sb.from('shopify_app_images').upsert({
              product_id: p.id, image_url: plan.addImage, shopify_media_id: plan.addedMediaId ?? null,
            });
          }
          if (shopifyId && shopifyId !== p.link) {
            await sb.from('shopify_product_links')
              .upsert({ product_id: p.id, shopify_product_id: shopifyId, linked_at: new Date().toISOString() });
          }
          if (plan.action === 'create') summary.created++;
          else if (plan.action === 'update') summary.updated++;
          else if (plan.action === 'skip') { summary.skipped++; summary.warnings.push(`${p.model}: ${plan.reason}`); }
          else summary.unchanged++;
          for (const w of plan.warnings) summary.warnings.push(`${p.model}: ${w}`);
          done.push(p.id);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          failed.push({ product_id: p.id, error: msg });
          summary.errors.push(`${p.model}: ${msg}`);
        }
      }
      // דגמים שנמחקו בינתיים — אין מה לסנכרן
      const known = new Set(products.map((p) => p.id));
      for (const id of ids) if (!known.has(id)) done.push(id);
    }

    const result = { ...summary, seconds: Math.round((Date.now() - startedMs) / 1000) };
    await sb.rpc('shopify_sync_release', {
      p_mode: mode, p_started: runStarted, p_result: result, p_done: done, p_failed: failed,
    });
    return json({ ok: true, mode, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // מה שלא הספיק לרוץ נשאר בתור עם השגיאה
    for (const id of ids) {
      if (!done.includes(id) && !failed.some((f) => f.product_id === id)) failed.push({ product_id: id, error: msg });
    }
    const result = { ...summary, fatal: msg, seconds: Math.round((Date.now() - startedMs) / 1000) };
    await sb.rpc('shopify_sync_release', {
      p_mode: mode, p_started: runStarted, p_result: result, p_done: done, p_failed: failed,
    });
    return json({ ok: false, error: msg, ...summary }, 500);
  }
});
