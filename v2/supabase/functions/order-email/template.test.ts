// ============================================================
// בדיקות לתבניות המייל
//
//   node --test supabase/functions/order-email/template.test.ts
//
// רץ ב-Node 22.6+ שמפשיט טיפוסים לבד. בודק את אותו קובץ בדיוק
// שה-Edge Function מייבאת, ולכן מה שנבדק הוא מה שנשלח.
// ============================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  groupByModel, itemsTable, esc, money,
  customerCreatedEmail, teamCreatedEmail, shippedEmail,
  type Brand, type Order, type Item,
} from './template.ts';

const brand: Brand = { name: 'רחליס', phone: '050-1234567', email: 'rachelisweb@gmail.com' };

const items: Item[] = [
  { model: '2611',   size: 'M',  qty: 4, qty_ordered: 4, unit_price: 62 },
  { model: '2420-1', size: 'M',  qty: 3, qty_ordered: 3, unit_price: 45 },
  { model: '2420-1', size: 'XS', qty: 1, qty_ordered: 1, unit_price: 45 },
  { model: '2420-1', size: 'L',  qty: 1, qty_ordered: 1, unit_price: 45 },
  { model: '2611',   size: 'XL', qty: 2, qty_ordered: 5, unit_price: 62 },  // סופק חלקית
];

const order: Order = {
  order_number: 118,
  created_at: '2026-08-04T09:15:00Z',
  shipped_at: '2026-08-06T11:00:00Z',
  total_units: 11,
  subtotal_amount: 574,
  discount_amount: 57.4,
  discount_type: 'pct',
  discount_value: 10,
  total_amount: 516.6,
  notes: 'אפשר לשלוח עם השליח של יום ג׳',
  phone: '052-7654321',
  order_items: items,
};

// ── ריכוז לפי דגם ───────────────────────────────────────────
test('כל דגם מקבל שורה אחת, ממוינת', () => {
  const rows = groupByModel(items);
  assert.equal(rows.length, 2, 'שני דגמים → שתי שורות');
  assert.deepEqual(rows.map((r) => r.model), ['2420-1', '2611']);
});

test('המידות בתוך הדגם ממוינות לפי סדר המידות ולא אלפביתית', () => {
  const rows = groupByModel(items);
  assert.deepEqual(rows[0].sizes.map((s) => s.size), ['XS', 'M', 'L']);
  assert.deepEqual(rows[1].sizes.map((s) => s.size), ['M', 'XL']);
});

test('סכומי הדגם מחושבים לפי מה שסופק', () => {
  const rows = groupByModel(items);
  const m2611 = rows.find((r) => r.model === '2611')!;
  assert.equal(m2611.total, 6, '4 + 2 שסופקו');
  assert.equal(m2611.ordered, 9, '4 + 5 שהוזמנו');
  assert.equal(m2611.amount, 6 * 62);
});

test('qty_ordered חסר נחשב כשווה ל-qty', () => {
  const rows = groupByModel([{ model: 'A', size: 'M', qty: 3 }]);
  assert.equal(rows[0].ordered, 3);
});

// ── הטבלה ───────────────────────────────────────────────────
test('הדגם וכל המידות שלו נמצאים באותה שורת טבלה', () => {
  const html = itemsTable(items);
  const rows = html.split('<tr>').filter((r) => r.includes('2420-1'));
  assert.equal(rows.length, 1, 'דגם 2420-1 מופיע בשורה אחת בלבד');
  for (const size of ['XS', 'M', 'L']) {
    assert.ok(rows[0].includes(`<b>${size}</b>`), `המידה ${size} באותה שורה`);
  }
});

test('שורת סיכום סוגרת את הטבלה', () => {
  const html = itemsTable(items, { showPrice: true });
  assert.ok(html.includes('סה״כ 2 דגמים'));
  assert.ok(html.includes('>11<'), 'סה״כ 11 יחידות');
});

test('מחירים מוצגים רק כשמבקשים', () => {
  assert.ok(!itemsTable(items).includes('סכום'), 'ללקוח — בלי מחירים');
  assert.ok(itemsTable(items, { showPrice: true }).includes('סכום'), 'למנהל — עם מחירים');
});

test('showOrdered מסמן רק את המידה שסופקה חלקית', () => {
  const html = itemsTable(items, { showOrdered: true });
  const struck = html.match(/text-decoration:line-through/g) || [];
  assert.equal(struck.length, 1, 'רק XL של 2611 השתנה');
  assert.ok(html.includes('#fffbeb'), 'הגלולה שהשתנתה נצבעת');
});

test('בלי showOrdered אין סימון בכלל', () => {
  assert.ok(!itemsTable(items).includes('line-through'));
});

test('טבלה ריקה לא מייצרת HTML שבור', () => {
  assert.equal(itemsTable([]), '');
});

// ── בטיחות ──────────────────────────────────────────────────
test('שם דגם עוין עובר escape ולא נכנס כ-HTML', () => {
  const html = itemsTable([{ model: '<img src=x onerror=alert(1)>', size: 'M', qty: 1 }]);
  assert.ok(!html.includes('<img src=x'), 'התג לא נשאר חי');
  assert.ok(html.includes('&lt;img'));
});

test('esc מנטרל את כל חמשת התווים', () => {
  assert.equal(esc(`<>&"'`), '&lt;&gt;&amp;&quot;\'');
});

test('הערת לקוח עוינת עוברת escape בכל שלושת המיילים', () => {
  const evil = { ...order, notes: '</td></table><script>alert(1)</script>' };
  for (const html of [
    customerCreatedEmail(evil, brand, 'פרקטי'),
    teamCreatedEmail(evil, brand, 'פרקטי', 'a@b.com'),
  ]) {
    assert.ok(!html.includes('<script>'), 'אין תג script חי');
  }
});

// ── המיילים עצמם ────────────────────────────────────────────
test('מייל הלקוח: בלי מחירים, עם מספר ההזמנה', () => {
  const html = customerCreatedEmail(order, brand, 'פרקטי');
  assert.ok(html.includes('ההזמנה שלך התקבלה'));
  assert.ok(html.includes('#118'));
  assert.ok(html.includes('פרקטי'));
  assert.ok(!html.includes('₪'), 'הלקוח לא רואה מחירים באישור');
});

test('מייל הצוות: עם מחירים, טלפון ומייל הלקוח', () => {
  const html = teamCreatedEmail(order, brand, 'פרקטי', 'shop@example.com');
  assert.ok(html.includes('הזמנה חדשה'));
  assert.ok(html.includes('052-7654321'));
  assert.ok(html.includes('shop@example.com'));
  assert.ok(html.includes('₪'), 'המנהל כן רואה מחירים');
});

test('מייל המשלוח: מסביר את הפער ומפרט את ההנחה', () => {
  const html = shippedEmail(order, brand, 'פרקטי', true);
  assert.ok(html.includes('יצאה לדרך'));
  assert.ok(html.includes('<b>14</b> יחידות'), 'סה״כ שהוזמן');
  assert.ok(html.includes('<b>11</b>'), 'סה״כ שנשלח');
  assert.ok(html.includes('−₪57.4'), 'סכום ההנחה');
  assert.ok(html.includes('(10%)'), 'שיעור ההנחה');
  assert.ok(html.includes('₪516.6'), 'לתשלום');
  assert.ok(html.includes('החשבונית מצורפת'));
});

test('בלי חשבונית — הודעה אחרת, בלי הבטחה שקרית', () => {
  const html = shippedEmail(order, brand, 'פרקטי', false);
  assert.ok(!html.includes('החשבונית מצורפת'));
  assert.ok(html.includes('תישלח בנפרד'));
});

test('הזמנה שסופקה במלואה לא מציגה אזהרת חוסר', () => {
  const full = { ...order, order_items: items.map((i) => ({ ...i, qty_ordered: i.qty })) };
  const html = shippedEmail(full, brand, 'פרקטי', true);
  assert.ok(!html.includes('אזלו מהמלאי'));
  assert.ok(!html.includes('line-through'));
});

test('בלי הנחה אין בלוק הנחה', () => {
  const plain = { ...order, discount_amount: 0, discount_type: null };
  assert.ok(!shippedEmail(plain, brand, 'פרקטי', true).includes('לפני הנחה'));
});

// ── תקינות HTML למייל ───────────────────────────────────────
const allEmails = () => [
  ['לקוח — התקבלה', customerCreatedEmail(order, brand, 'פרקטי')],
  ['מנהל — חדשה',   teamCreatedEmail(order, brand, 'פרקטי', 'a@b.com')],
  ['לקוח — נשלחה',  shippedEmail(order, brand, 'פרקטי', true)],
] as const;

test('כל מייל הוא RTL בעברית עם doctype', () => {
  for (const [name, html] of allEmails()) {
    assert.ok(html.startsWith('<!DOCTYPE html>'), `${name}: doctype`);
    assert.ok(html.includes('dir="rtl" lang="he"'), `${name}: rtl`);
    assert.ok(html.includes('charset="utf-8"'), `${name}: utf-8`);
  }
});

test('אין CSS חיצוני או תמונות מרוחקות — ג׳ימייל חוסם אותם', () => {
  for (const [name, html] of allEmails()) {
    assert.ok(!/<style[\s>]/i.test(html), `${name}: בלי <style>`);
    assert.ok(!/<link[\s>]/i.test(html), `${name}: בלי <link>`);
    assert.ok(!/<img[\s>]/i.test(html), `${name}: בלי <img>`);
  }
});

test('תגי הטבלה מאוזנים', () => {
  const count = (h: string, re: RegExp) => (h.match(re) || []).length;
  for (const [name, html] of allEmails()) {
    assert.equal(count(html, /<table/g),  count(html, /<\/table>/g), `${name}: table`);
    assert.equal(count(html, /<tr[\s>]/g), count(html, /<\/tr>/g),   `${name}: tr`);
    assert.equal(count(html, /<td[\s>]/g), count(html, /<\/td>/g),   `${name}: td`);
  }
});

test('פרטי המותג מופיעים בכל מייל', () => {
  for (const [name, html] of allEmails()) {
    assert.ok(html.includes('רחליס'), `${name}: שם`);
    assert.ok(html.includes('050-1234567'), `${name}: טלפון`);
    assert.ok(html.includes('rachelisweb@gmail.com'), `${name}: מייל`);
  }
});

test('כל מייל נשאר קטן מ-102KB — מעבר לזה ג׳ימייל גוזם', () => {
  for (const [name, html] of allEmails()) {
    assert.ok(Buffer.byteLength(html, 'utf8') < 102 * 1024,
      `${name}: ${Math.round(Buffer.byteLength(html, 'utf8') / 1024)}KB`);
  }
});

test('money מעצב בעברית', () => {
  assert.equal(money(1234), '₪1,234');
  assert.equal(money(0), '₪0');
  assert.equal(money(null), '₪0');
});
