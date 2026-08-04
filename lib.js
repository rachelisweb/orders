// ============================================================
// ליבה משותפת ללקוח ולמנהל:
// חיבור ל-Supabase, מצב, תמונות, ייצוא, וכלי עזר
// ============================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const CFG = window.APP_CONFIG || {};

export const BRAND = CFG.BRAND || 'רחליס';
export const CLOUD = CFG.CLOUDINARY_CLOUD || '';
export const IS_CONFIGURED = !!(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY);

export const sb = IS_CONFIGURED
  ? createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  : null;

// סדר המידות — מקור אמת יחיד בצד הלקוח.
// המסד מחזיק את אותו סדר בטבלת sizes; זה כאן כדי לא לשלוף אותו בכל רינדור.
export const SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL', '5XL'];
export const SIZE_SORT = Object.fromEntries(SIZES.map((s, i) => [s, i]));

// זרימת הסטטוסים. next קובע את הכפתור הראשי בכל שלב.
export const ORDER_STATUS = {
  pending:   { label: 'ממתינה',        short: 'ממתינות',      color: 'amber',  icon: '⏳', next: 'ready'   },
  ready:     { label: 'מוכנה לאיסוף',  short: 'מוכנות',       color: 'blue',   icon: '📦', next: 'shipped' },
  shipped:   { label: 'נשלחה',         short: 'נשלחו',        color: 'violet', icon: '🚚', next: 'paid'    },
  paid:      { label: 'שולמה',         short: 'שולמו',        color: 'green',  icon: '✅', next: null      },
  cancelled: { label: 'בוטלה',         short: 'בוטלו',        color: 'red',    icon: '✖',  next: null      },
};

export const STATUS_FLOW = ['pending', 'ready', 'shipped', 'paid'];

export const INVOICE_STATUS = {
  unpaid:    { label: 'לא שולמה', color: 'amber' },
  paid:      { label: 'שולמה',    color: 'green' },
  cancelled: { label: 'בוטלה',    color: 'red'   },
};

// חזרה נקלטת כ-pending (המלאי כבר נכנס) וממתינה לזיכוי ללקוח.
// אחרי הזיכוי היא יורדת לארכיון החזרות.
export const RETURN_STATUS = {
  pending:   { label: 'ממתינה לזיכוי', short: 'ממתינות', color: 'amber', icon: '⏳' },
  credited:  { label: 'בוצע זיכוי',    short: 'ארכיון',  color: 'green', icon: '✅' },
  cancelled: { label: 'בוטלה',         short: 'בוטלו',   color: 'red',   icon: '✖'  },
};

export const state = {
  user: null,
  profile: null,
  customer: null,
  isAdmin: false,
  collections: [],
  products: [],
  cart: {},          // { model: { size: qty } }
  submitting: false,
};

// המנהל יכול לצפות בממשק הלקוח כדי לראות איך הוא נראה בפועל.
// sessionStorage משמש גיבוי למארחים שמנקים query string במעבר בין קבצי HTML.
const CUSTOMER_PREVIEW_KEY = 'rachelis:customerPreview';

export function setCustomerPreview(enabled) {
  try {
    if (enabled) sessionStorage.setItem(CUSTOMER_PREVIEW_KEY, '1');
    else sessionStorage.removeItem(CUSTOMER_PREVIEW_KEY);
  } catch { /* מצב פרטי / אחסון חסום */ }
}

export function isCustomerPreview() {
  const requested = new URLSearchParams(window.location.search).get('view') === 'customer';
  if (requested) setCustomerPreview(true);
  if (requested) return true;
  try { return sessionStorage.getItem(CUSTOMER_PREVIEW_KEY) === '1'; }
  catch { return false; }
}

// ── DOM ─────────────────────────────────────────────────────
export const $  = (id) => document.getElementById(id);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
export const on = (id, ev, fn) => { const e = $(id); if (e) e.addEventListener(ev, fn); };

export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── תמונות ──────────────────────────────────────────────────
// מזריק טרנספורמציות ל-URL של Cloudinary: פורמט ואיכות אוטומטיים + רוחב יעד.
// זה ההבדל בין PNG של 800KB לבין WebP של 30KB בתצוגה של 110px.
export function img(url, width = 400) {
  if (!url) return '';
  const marker = '/image/upload/';
  const i = url.indexOf(marker);
  if (i === -1 || !url.includes('res.cloudinary.com')) return url;
  const head = url.slice(0, i + marker.length);
  const tail = url.slice(i + marker.length);
  // אם כבר יש טרנספורמציה בנתיב, לא נוגעים
  if (/^[a-z]_[^/]*\//.test(tail)) return url;
  return `${head}f_auto,q_auto,c_limit,w_${width}/${tail}`;
}

// תגית <img> מוכנה, עם יחס גובה-רוחב קבוע כדי למנוע קפיצות פריסה
export function imgTag(url, alt, width = 400, cls = '') {
  if (!url) return `<div class="img-ph ${cls}">📷</div>`;
  return `<img class="${cls}" src="${esc(img(url, width))}" alt="${esc(alt)}"
    loading="lazy" decoding="async"
    onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'img-ph ${cls}',textContent:'📷'}))">`;
}

// תמונה שיוצאת ממצלמת סמארטפון היא 4-8MB. דוחסים בדפדפן לפני
// ההעלאה כדי לא לשרוף את מכסת האחסון ואת החבילה של המשתמש.
export async function compressImage(file, maxDim = 1280, quality = 0.72) {
  if (!file || !String(file.type).startsWith('image/')) return file;

  let bitmap;
  try {
    // imageOrientation מיישר תמונות שצולמו לרוחב; ספארי ישן לא תומך באפשרויות
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    try { bitmap = await createImageBitmap(file); }
    catch { return file; }
  }

  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality));
  // אם הדחיסה לא הרוויחה כלום (תמונה כבר קטנה) — עדיף המקור
  return blob && blob.size < file.size ? blob : file;
}

// ── התראות ──────────────────────────────────────────────────
let toastTimer = null;
export function toast(msg, isErr = false) {
  const t = $('toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, 3600);
}

export function showError(id, msg) {
  const e = $(id);
  if (!e) return;
  if (msg) { e.textContent = msg; e.classList.add('show'); }
  else { e.textContent = ''; e.classList.remove('show'); }
}

// ── פורמט ───────────────────────────────────────────────────
export function fmtDate(iso, withTime = true) {
  if (!iso) return '';
  try {
    const o = { day: '2-digit', month: '2-digit', year: 'numeric' };
    if (withTime) { o.hour = '2-digit'; o.minute = '2-digit'; }
    return new Date(iso).toLocaleString('he-IL', o);
  } catch { return String(iso); }
}

// התאריך של היום לפי שעון המשתמש. toISOString היה מחזיר את תאריך ה-UTC,
// ובישראל אחרי חצות זה עדיין "אתמול" — ברירת מחדל שגויה בטופס החזרות.
export function todayISO() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function fmtMoney(n) {
  const v = Number(n || 0);
  // סכומים עגולים בלי אגורות, שברים תמיד עם שתי ספרות — ₪1,234 / ₪1,234.50
  const d = Number.isInteger(v) ? 0 : 2;
  return '₪' + v.toLocaleString('he-IL', { minimumFractionDigits: d, maximumFractionDigits: d });
}

export function fmtNum(n) {
  return Number(n || 0).toLocaleString('he-IL');
}

// ── שגיאות ──────────────────────────────────────────────────
export function friendlyError(err) {
  const m = String(err?.message || err || '');
  if (/Invalid login credentials/i.test(m))       return 'אימייל או סיסמה שגויים';
  if (/User already registered/i.test(m))         return 'המשתמש כבר קיים — נסה להתחבר';
  if (/Password should be at least/i.test(m))     return 'הסיסמה חייבת להכיל לפחות 6 תווים';
  if (/Unable to validate email|invalid.*email/i.test(m)) return 'כתובת אימייל לא תקינה';
  if (/Email not confirmed/i.test(m))             return 'יש לאשר את המייל שנשלח אליך';
  if (/rate limit|too many/i.test(m))             return 'יותר מדי ניסיונות — נסה שוב בעוד רגע';
  if (/Failed to fetch|NetworkError/i.test(m))    return 'אין חיבור לשרת — בדוק את החיבור לרשת';
  if (/row-level security|permission denied/i.test(m)) return 'אין לך הרשאה לפעולה הזו';
  if (/duplicate key/i.test(m))                   return 'הערך כבר קיים במערכת';
  return m || 'אירעה שגיאה';
}

// ── טעינת פרופיל ────────────────────────────────────────────
export async function loadProfile() {
  const { data: { user } } = await sb.auth.getUser();
  state.user = user || null;
  state.profile = null;
  state.customer = null;
  state.isAdmin = false;
  if (!user) return null;

  const { data, error } = await sb
    .from('profiles')
    .select('*, customers(*)')
    .eq('id', user.id)
    .maybeSingle();

  if (error) throw error;

  state.profile  = data || null;
  state.customer = data?.customers || null;
  state.isAdmin  = data?.role === 'admin';
  return data;
}

// אין יותר אישור ידני — די בכרטיס לקוח, שנוצר אוטומטית בהרשמה
export function canOrder() {
  return state.isAdmin || !!state.profile?.customer_id;
}

// המשתמש עוד לא מילא טלפון ושם עסק. מנהלים פטורים.
export function needsProfile() {
  return !state.isAdmin && !!state.profile?.needs_profile;
}

// תא טבלה עם תווית — ב-CSS של הנייד הטבלה הופכת לכרטיסים
// והתווית הזו היא מה שמופיע לצד הערך במקום כותרת העמודה.
export function td(label, value, cls = '') {
  return `<td class="${cls}" data-label="${esc(label)}">${value}</td>`;
}

// ── ייצוא ───────────────────────────────────────────────────
// SheetJS נטען עצלנית: רוב הביקורים לא מייצאים כלום.
let xlsxMod = null;
async function xlsx() {
  if (!xlsxMod) xlsxMod = await import('https://esm.sh/xlsx@0.18.5');
  return xlsxMod;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

/**
 * מייצא גיליון אחד או יותר לקובץ .xlsx
 * sheets: [{ name, rows: [{עמודה: ערך}] }]
 */
export async function exportXlsx(filename, sheets) {
  const XLSX = await xlsx();
  const wb = XLSX.utils.book_new();

  for (const s of sheets) {
    const ws = XLSX.utils.json_to_sheet(s.rows || []);
    // רוחב עמודות לפי התוכן, כדי שלא יצטרכו לגרור ידנית
    const keys = Object.keys((s.rows || [])[0] || {});
    ws['!cols'] = keys.map((k) => ({
      wch: Math.min(40, Math.max(
        k.length + 2,
        ...(s.rows || []).map((r) => String(r[k] ?? '').length + 2),
      )),
    }));
    ws['!rtl'] = true;
    XLSX.utils.book_append_sheet(wb, ws, s.name.slice(0, 31));
  }

  XLSX.writeFile(wb, `${filename}_${stamp()}.xlsx`);
}

export function exportCsv(filename, rows) {
  if (!rows?.length) { toast('אין נתונים לייצוא', true); return; }
  const keys = Object.keys(rows[0]);
  const cell = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const csv = [keys.join(','), ...rows.map((r) => keys.map((k) => cell(r[k])).join(','))].join('\r\n');
  // BOM כדי שאקסל יזהה UTF-8 ולא יהפוך עברית לג'יבריש
  download(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' }),
           `${filename}_${stamp()}.csv`);
}

export function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── גרירה לסידור ────────────────────────────────────────────
/**
 * הופך רשימה לניתנת לסידור בגרירה, בלי ספריות חיצוניות.
 * container — האלמנט העוטף; פריטים חייבים [draggable="true"] ו-data-id
 * onDrop(idsInNewOrder) נקרא רק כשהסדר באמת השתנה.
 */
export function makeSortable(container, onDrop) {
  if (!container || container.dataset.sortableBound === '1') return;
  container.dataset.sortableBound = '1';

  let dragged = null;
  let orderBefore = null;

  const ids = () => $$('[data-id]', container)
    .filter((el) => el.parentElement === container)
    .map((el) => el.dataset.id);

  container.addEventListener('dragstart', (e) => {
    const item = e.target.closest('[data-id]');
    if (!item || item.parentElement !== container) return;
    dragged = item;
    orderBefore = ids().join(',');
    item.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    // פיירפוקס לא מתחיל גרירה בלי setData
    e.dataTransfer.setData('text/plain', item.dataset.id);
  });

  container.addEventListener('dragover', (e) => {
    if (!dragged) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    const over = e.target.closest('[data-id]');
    if (!over || over === dragged || over.parentElement !== container) return;

    const rect = over.getBoundingClientRect();
    // רשימה אנכית: חוצה האמצע קובע לפני/אחרי
    const after = (e.clientY - rect.top) > rect.height / 2;
    container.insertBefore(dragged, after ? over.nextSibling : over);
  });

  container.addEventListener('dragend', async () => {
    if (!dragged) return;
    dragged.classList.remove('dragging');
    dragged = null;
    const now = ids();
    if (now.join(',') !== orderBefore) await onDrop(now);
  });
}

// ── שונות ───────────────────────────────────────────────────
export function debounce(fn, ms = 250) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function groupBy(arr, keyFn) {
  const m = new Map();
  for (const x of arr) {
    const k = keyFn(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

export function sortSizes(a, b) {
  return (SIZE_SORT[a] ?? 99) - (SIZE_SORT[b] ?? 99);
}

export function statusChip(map, key) {
  const s = map[key] || { label: key, color: 'gray' };
  return `<span class="chip ${s.color}">${esc(s.label)}</span>`;
}
