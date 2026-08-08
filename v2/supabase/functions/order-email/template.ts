// ============================================================
// רחליס — תבניות המייל
//
// מודול טהור בלי שום API של Deno: אותו קובץ רץ גם ב-Edge Function
// וגם בבדיקות ב-Node (`node --test`), כך שמה שנבדק הוא בדיוק מה
// שנשלח ללקוח.
//
// כללי מייל שחשוב לא לשבור:
//   • טבלאות ו-inline styles בלבד. ג'ימייל מוחק <style> חיצוני.
//   • dir="rtl" גם על <html> וגם על כל תא, אחרת אאוטלוק מיישר לשמאל.
//   • בלי תמונות חיצוניות — הן נחסמות כברירת מחדל ומורידות מסירוּת.
// ============================================================

export const SIZE_ORDER = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL', '5XL'];

export type Item = {
  model: string;
  size: string;
  qty: number;
  qty_ordered?: number | null;
  unit_price?: number | null;
};

export type Brand = { name: string; phone: string; email: string };

export type Order = {
  order_number: number | string;
  created_at: string;
  shipped_at?: string | null;
  total_units: number;
  total_amount?: number | null;
  subtotal_amount?: number | null;
  discount_amount?: number | null;
  discount_type?: string | null;
  discount_value?: number | null;
  notes?: string | null;
  phone?: string | null;
  order_items?: Item[];
};

export const esc = (s: unknown) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
                 .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric' });

export const money = (n: unknown) =>
  '₪' + Number(n || 0).toLocaleString('he-IL', { maximumFractionDigits: 2 });

// ── פלטה ────────────────────────────────────────────────────
const INK    = '#0f172a';
const MUTED  = '#52627a';
const LINE   = '#e2e8f0';
const HEAD   = '#f1f5f9';

// ============================================================
// שלד המייל
// ============================================================
export function shell(title: string, accent: string, body: string, brand: Brand) {
  return `<!DOCTYPE html>
<html dir="rtl" lang="he"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<title>${esc(title)}</title></head>
<body dir="rtl" style="margin:0;padding:0;background:#f1f5f9;
  font-family:'Segoe UI',Arial,Helvetica,sans-serif;color:${INK};">

<!-- טקסט התצוגה המקדימה בתיבת הדואר, מוסתר מגוף ההודעה -->
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">
  ${esc(title)} — ${esc(brand.name)}
</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
       style="background:#f1f5f9;padding:24px 12px;">
<tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
         style="max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden;
                box-shadow:0 2px 8px rgba(15,23,42,.08);">

    <tr><td style="background:${accent};padding:26px 24px;text-align:center;">
      <div style="font-size:30px;line-height:1;margin-bottom:6px;">🛍️</div>
      <div style="color:#ffffff;font-size:21px;font-weight:bold;">${esc(brand.name)}</div>
      <div style="color:#e8eefc;font-size:14px;margin-top:4px;">${esc(title)}</div>
    </td></tr>

    <tr><td style="padding:24px;color:${INK};font-size:15px;line-height:1.65;" dir="rtl">${body}</td></tr>

    <tr><td style="background:#f8fafc;padding:18px 24px;text-align:center;
                   color:${MUTED};font-size:12px;border-top:1px solid ${LINE};">
      ${brand.phone ? `📞 ${esc(brand.phone)}<br>` : ''}
      ${brand.email ? `✉️ <a href="mailto:${esc(brand.email)}" style="color:#2563eb;">${esc(brand.email)}</a><br>` : ''}
      <span style="color:#8a97a8;">הודעה זו נשלחה אוטומטית ממערכת ההזמנות</span>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
}

export const box = (bg: string, border: string, color: string, html: string) =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
     style="margin:14px 0;"><tr><td dir="rtl" style="background:${bg};border:1px solid ${border};
     color:${color};border-radius:10px;padding:12px 14px;font-size:14px;line-height:1.6;">${html}</td></tr></table>`;

// ============================================================
// ריכוז הפריטים לפי דגם
// ============================================================
type Row = { model: string; sizes: Item[]; total: number; ordered: number; amount: number };

export function groupByModel(items: Item[]): Row[] {
  const map = new Map<string, Row>();
  for (const i of items) {
    let e = map.get(i.model);
    if (!e) {
      e = { model: i.model, sizes: [], total: 0, ordered: 0, amount: 0 };
      map.set(i.model, e);
    }
    e.sizes.push(i);
    e.total   += Number(i.qty) || 0;
    e.ordered += Number(i.qty_ordered ?? i.qty) || 0;
    e.amount  += (Number(i.qty) || 0) * (Number(i.unit_price) || 0);
  }
  for (const e of map.values()) {
    e.sizes.sort((a, b) => SIZE_ORDER.indexOf(a.size) - SIZE_ORDER.indexOf(b.size));
  }
  return [...map.values()].sort((a, b) => String(a.model).localeCompare(String(b.model), 'he'));
}

// גלולת מידה אחת: "M × 3". כשהכמות שסופקה נמוכה מזו שהוזמנה
// הגלולה נצבעת ומראה את שתי הכמויות, כדי שלא תהיה הפתעה.
function sizePill(i: Item, showOrdered: boolean) {
  const ordered = Number(i.qty_ordered ?? i.qty);
  const short = showOrdered && ordered !== i.qty;
  const bg     = short ? '#fffbeb' : '#f1f5f9';
  const border = short ? '#fcd34d' : '#cbd5e1';
  const color  = short ? '#78350f' : INK;
  const qty = short
    ? `<span style="text-decoration:line-through;opacity:.65;">${ordered}</span> ${i.qty}`
    : String(i.qty);

  return `<span style="display:inline-block;background:${bg};border:1px solid ${border};
    color:${color};border-radius:6px;padding:3px 8px;margin:2px 0 2px 4px;
    font-size:13px;white-space:nowrap;">
    <b>${esc(i.size)}</b> × ${qty}</span>`;
}

/**
 * שורה אחת לכל דגם, וכל המידות שלו באותה שורה.
 * showPrice  — עמודת סכום (למייל של המנהל בלבד)
 * showOrdered — מסמן מידות שסופקו בכמות שונה מזו שהוזמנה
 */
export function itemsTable(
  items: Item[],
  opts: { showPrice?: boolean; showOrdered?: boolean } = {},
) {
  const { showPrice = false, showOrdered = false } = opts;
  const rows = groupByModel(items);
  if (!rows.length) return '';

  const th = `padding:9px 10px;background:${HEAD};font-size:12px;font-weight:bold;
              color:#334155;border-bottom:2px solid #cbd5e1;`;
  const cell = `padding:10px;border-bottom:1px solid ${LINE};font-size:14px;vertical-align:middle;`;

  const totalUnits = rows.reduce((a, r) => a + r.total, 0);
  const totalAmount = rows.reduce((a, r) => a + r.amount, 0);

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" dir="rtl"
    style="border-collapse:collapse;margin:14px 0;border:1px solid ${LINE};border-radius:10px;overflow:hidden;">
    <tr>
      <th align="right"  style="${th}">דגם</th>
      <th align="right"  style="${th}">מידות</th>
      <th align="center" style="${th}">סה״כ</th>
      ${showPrice ? `<th align="center" style="${th}">סכום</th>` : ''}
    </tr>
    ${rows.map((r) => `<tr>
      <td align="right"  style="${cell}font-weight:bold;white-space:nowrap;">${esc(r.model)}</td>
      <td align="right"  style="${cell}">${r.sizes.map((i) => sizePill(i, showOrdered)).join('')}</td>
      <td align="center" style="${cell}font-weight:bold;">${r.total}</td>
      ${showPrice ? `<td align="center" style="${cell}white-space:nowrap;">${money(r.amount)}</td>` : ''}
    </tr>`).join('')}
    <tr>
      <td align="right" style="padding:10px;background:${HEAD};font-weight:bold;font-size:14px;">
        סה״כ ${rows.length} דגמים</td>
      <td style="background:${HEAD};"></td>
      <td align="center" style="padding:10px;background:${HEAD};font-weight:bold;font-size:14px;">${totalUnits}</td>
      ${showPrice ? `<td align="center" style="padding:10px;background:${HEAD};font-weight:bold;
        font-size:14px;white-space:nowrap;">${money(totalAmount)}</td>` : ''}
    </tr>
  </table>`;
}

// ============================================================
// שלושת המיילים
// ============================================================

/** ללקוח, מיד עם קליטת ההזמנה. בלי מחירים. */
export function customerCreatedEmail(order: Order, brand: Brand, who: string) {
  return shell('ההזמנה שלך התקבלה', '#2563eb', `
    <p style="margin:0 0 4px;font-size:17px;font-weight:bold;">שלום ${esc(who)},</p>
    <p style="margin:0 0 14px;">קיבלנו את ההזמנה שלך והיא ממתינה לטיפול. נעדכן אותך ברגע שתישלח.</p>
    ${box('#eff6ff', '#bfdbfe', '#1e40af',
      `<span style="font-size:16px;font-weight:bold;">הזמנה #${esc(order.order_number)}</span><br>
       ${fmtDate(order.created_at)} · ${order.total_units} יחידות`)}
    <p style="margin:16px 0 0;font-weight:bold;">פירוט ההזמנה</p>
    ${itemsTable(order.order_items || [], { showPrice: false })}
    ${order.notes ? box('#f8fafc', LINE, '#334155', `<b>ההערה שלך:</b><br>${esc(order.notes)}`) : ''}
    <p style="margin:16px 0 0;color:${MUTED};font-size:13px;">
      שים לב: הכמויות עשויות להשתנות בהתאם למלאי בפועל. הפירוט הסופי יישלח עם המשלוח.</p>
  `, brand);
}

/** למנהלים — התראה על הזמנה חדשה, עם מחירים. */
export function teamCreatedEmail(order: Order, brand: Brand, who: string, customerEmail?: string | null) {
  return shell('הזמנה חדשה', '#b45309', `
    <p style="margin:0 0 14px;font-size:17px;font-weight:bold;">התקבלה הזמנה חדשה</p>
    ${box('#fffbeb', '#fcd34d', '#78350f',
      `<span style="font-size:16px;font-weight:bold;">#${esc(order.order_number)} — ${esc(who)}</span><br>
       ${order.total_units} יחידות · ${money(order.total_amount)}<br>
       ${order.phone ? `📞 ${esc(order.phone)}` : ''}${customerEmail ? ` · ✉️ ${esc(customerEmail)}` : ''}`)}
    ${itemsTable(order.order_items || [], { showPrice: true })}
    ${order.notes ? box('#f8fafc', LINE, '#334155', `<b>הערת הלקוח:</b><br>${esc(order.notes)}`) : ''}
  `, brand);
}

/** ללקוח בסימון "נשלחה" — מה יצא בפועל, עם החשבונית מצורפת. */
export function shippedEmail(order: Order, brand: Brand, who: string, hasInvoice: boolean) {
  const items = order.order_items || [];
  const ordered  = items.reduce((a, i) => a + Number(i.qty_ordered ?? i.qty), 0);
  const supplied = items.reduce((a, i) => a + Number(i.qty), 0);
  const short = ordered !== supplied;
  const disc = Number(order.discount_amount || 0);

  return shell('ההזמנה שלך נשלחה', '#7c3aed', `
    <p style="margin:0 0 4px;font-size:17px;font-weight:bold;">שלום ${esc(who)},</p>
    <p style="margin:0 0 14px;">ההזמנה שלך יצאה לדרך 🚚</p>
    ${box('#f5f3ff', '#c4b5fd', '#5b21b6',
      `<span style="font-size:16px;font-weight:bold;">הזמנה #${esc(order.order_number)}</span><br>
       ${supplied} יחידות · נשלחה ב-${fmtDate(order.shipped_at || new Date().toISOString())}`)}

    ${short ? box('#fffbeb', '#fcd34d', '#78350f',
      `הזמנת <b>${ordered}</b> יחידות ונשלחו <b>${supplied}</b> — חלק מהפריטים אזלו מהמלאי.
       המידות שהשתנו מסומנות בטבלה, והחיוב הוא על מה שנשלח בפועל.`) : ''}

    <p style="margin:16px 0 0;font-weight:bold;">מה נשלח בפועל</p>
    ${itemsTable(items, { showOrdered: short })}

    ${disc > 0 ? box('#ecfdf5', '#6ee7b7', '#065f46',
      `לפני הנחה: ${money(order.subtotal_amount)}<br>
       הנחה${order.discount_type === 'pct' ? ` (${order.discount_value}%)` : ''}:
       <b>−${money(disc)}</b><br>
       <span style="font-size:16px;">לתשלום: <b>${money(order.total_amount)}</b></span>`) : ''}

    ${hasInvoice
      ? box('#ecfdf5', '#6ee7b7', '#065f46',
          `🧾 <b>החשבונית מצורפת למייל הזה.</b><br>
           אפשר גם להוריד אותה בכל עת מהאזור האישי, בתוך ההזמנה.`)
      : box('#f8fafc', LINE, '#334155', 'החשבונית תישלח בנפרד ותופיע גם באזור האישי.')}
  `, brand);
}
