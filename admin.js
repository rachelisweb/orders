// ============================================================
// ממשק ניהול
// ============================================================
import {
  sb, state, IS_CONFIGURED, SIZES,
  $, $$, on, esc, img, imgTag, toast, showError, fmtDate, fmtMoney, fmtNum, td, todayISO,
  friendlyError, loadProfile, sortSizes, statusChip, debounce, compressImage,
  makeSortable, exportXlsx, exportCsv, setCustomerPreview,
  ORDER_STATUS, STATUS_FLOW, INVOICE_STATUS, RETURN_STATUS,
} from './lib.js';

const db = {
  collections: [], products: [], orders: [], customers: [],
  invoices: [], users: [], emails: [], settings: {},
  returns: [], returnItems: [], orderNotes: {},
};

const filters = { from: '', to: '', collection: '', customer: '', status: '', model: '' };

let activeTab = 'dash';
let orderStatusTab = 'pending';
let returnStatusTab = 'pending';
let stockSortMode = false;
const picked = new Set();     // דגמים מסומנים לעדכון מחירים מרובה
let newOrderCustomerMode = 'existing';
let newOrderCustomerHighlight = -1;
let newOrderCollection = null;
let newOrderCart = {};
let newOrderSubmitting = false;

// ============================================================
// אתחול
// ============================================================
async function init() {
  if (!IS_CONFIGURED) { deny('חסרים פרטי החיבור ב-config.js'); return; }

  // חזרה למסך הניהול מסיימת תמיד מצב תצוגת לקוח קודם.
  setCustomerPreview(false);

  try { await loadProfile(); }
  catch (err) { deny(friendlyError(err)); return; }

  if (!state.user)    { deny('יש להתחבר תחילה.'); return; }
  if (!state.isAdmin) { deny('החשבון הזה אינו חשבון מנהל.'); return; }

  $('whoName').textContent = state.profile?.full_name || 'מנהל';
  $('whoMail').textContent = state.profile?.email || '';
  show('adminScreen');

  wire();
  await loadAll();
}

function deny(msg) { $('denyMsg').textContent = msg; show('denyScreen'); }
function show(id) { ['denyScreen', 'adminScreen'].forEach((s) => $(s)?.classList.toggle('active', s === id)); }

// ============================================================
// טעינה
// ============================================================
async function loadAll() {
  $('headerSub').textContent = 'טוען…';
  try {
    const [cols, prods, orders, customers, invoices, users, emails, settings, rets, retItems, notes] =
      await Promise.all([
        sb.from('collections').select('*').order('sort_order'),
        sb.from('products').select('*, inventory(size, qty), collections(name, slug, icon)').order('sort_order'),
        sb.from('orders')
          .select('*, order_items(id, model, size, qty, qty_ordered, unit_price, product_id), customers(name, business_name, phone)')
          .order('created_at', { ascending: false }).limit(3000),
        sb.from('v_customer_stats').select('*').order('name'),
        sb.from('invoices').select('*, customers(name), orders(order_number)').order('issued_at', { ascending: false }),
        sb.from('profiles').select('*, customers(name)').order('created_at', { ascending: false }),
        sb.from('notification_emails').select('*').order('email'),
        sb.from('app_settings').select('*'),
        sb.from('v_returns').select('*').order('return_date', { ascending: false }),
        sb.from('return_items').select('*'),
        sb.from('order_admin_notes').select('*'),
      ]);

    for (const r of [cols, prods, orders, customers, invoices, users, emails, settings, rets, retItems, notes]) {
      if (r.error) throw r.error;
    }

    db.collections = cols.data || [];
    db.products = (prods.data || []).map((p) => ({
      ...p,
      stock: Object.fromEntries((p.inventory || []).map((i) => [i.size, i.qty])),
      total: (p.inventory || []).reduce((a, i) => a + i.qty, 0),
    }));
    db.orders    = orders.data || [];
    db.customers = customers.data || [];
    db.invoices  = invoices.data || [];
    db.users     = users.data || [];
    db.emails    = emails.data || [];
    db.settings  = Object.fromEntries((settings.data || []).map((s) => [s.key, s.value]));
    db.returns   = rets.data || [];
    db.returnItems = retItems.data || [];
    db.orderNotes  = Object.fromEntries((notes.data || []).map((n) => [n.order_id, n.notes || '']));

    fillFilterOptions();

    const pending    = db.orders.filter((o) => o.status === 'pending').length;
    const openReturn = db.returns.filter((r) => r.status === 'pending').length;
    $('cntOrders').textContent = pending || db.orders.length;
    $('cntReturns').textContent = openReturn;
    $('headerSub').textContent =
      `${fmtNum(db.orders.length)} הזמנות · ${pending} ממתינות · ${openReturn} חזרות · ${fmtNum(db.products.length)} דגמים`;

    renderActiveTab();
  } catch (err) {
    console.error(err);
    toast(friendlyError(err), true);
    $('headerSub').textContent = 'שגיאה בטעינה';
  }
}

function fillFilterOptions() {
  const colOpts = db.collections.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  $('stockCollection').innerHTML = '<option value="">כל הקולקציות</option>' + colOpts;

  const custOpts = db.customers.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  $('invCustomer').innerHTML = '<option value="">כל הלקוחות</option>' + custOpts;
}

// ============================================================
// סינון
// ============================================================
const productByModel = (m) => db.products.find((p) => p.model === m);
const productCollection = (m) => productByModel(m)?.collection_id || null;

// ── הנחה ברמת ההזמנה ────────────────────────────────────────
// הדוחות מסכמים שורה-שורה (qty × unit_price), אבל ההנחה יושבת על
// ההזמנה כולה. מפזרים אותה יחסית על השורות כדי שגם דוח מסונן
// לפי דגם או קולקציה יראה מחזור נכון.
function discRatio(o) {
  const sub  = Number(o?.subtotal_amount || 0);
  const disc = Number(o?.discount_amount || 0);
  if (!(sub > 0) || !(disc > 0)) return 0;
  return Math.min(disc / sub, 1);
}
const lineGross = (it) => it.qty * (it.unit_price || 0);
const lineNet   = (it) => lineGross(it) * (1 - discRatio(it.order));
const lineCost  = (it) => it.qty * (productByModel(it.model)?.cost_price || 0);

// ── חלון חישוב הרווח ────────────────────────────────────────
// הזמנות שקדמו לתאריך הזה הן היסטוריה שיובאה מהגיליון הישן:
// אין להן מחירי עלות אמיתיים והן היו מעוותות כל דוח רווחיות.
function profitStart() {
  const v = db.settings.profit_start_date;
  if (!v) return null;
  const d = new Date(v + 'T00:00:00');
  return Number.isNaN(d.getTime()) ? null : d;
}
function inProfitWindow(order) {
  const from = profitStart();
  return !from || new Date(order.created_at) >= from;
}
const profitItems = () => filteredItems().filter((it) => inProfitWindow(it.order));

function filteredOrders() {
  const from = filters.from ? new Date(filters.from + 'T00:00:00') : null;
  const to   = filters.to   ? new Date(filters.to   + 'T23:59:59') : null;
  const q = filters.model.trim().toLowerCase();

  return db.orders.filter((o) => {
    if (filters.status   && o.status !== filters.status) return false;
    if (filters.customer && o.customer_id !== filters.customer) return false;
    const d = new Date(o.created_at);
    if (from && d < from) return false;
    if (to   && d > to)   return false;

    if (filters.collection || q) {
      const ok = (o.order_items || []).some((it) => {
        if (q && !it.model.toLowerCase().includes(q)) return false;
        if (filters.collection && productCollection(it.model) !== filters.collection) return false;
        return true;
      });
      if (!ok) return false;
    }
    return true;
  });
}

function filteredItems() {
  const q = filters.model.trim().toLowerCase();
  const rows = [];
  for (const o of filteredOrders()) {
    if (o.status === 'cancelled') continue;
    for (const it of o.order_items || []) {
      if (q && !it.model.toLowerCase().includes(q)) continue;
      if (filters.collection && productCollection(it.model) !== filters.collection) continue;
      rows.push({ ...it, order: o });
    }
  }
  return rows;
}

// הזמנה ממתינה לחשבונית רק לאחר שהוכנה או נשלחה. ארכיון אינו משימה פתוחה.
const isWaitingForInvoice = (o) =>
  !isArchived(o) && ['ready', 'shipped'].includes(o.status) && !hasInvoice(o.id);

// כרטיס "דורש טיפול" — משימות פתוחות בלבד, בראש הדשבורד.
function renderActionCard() {
  const live    = db.orders.filter((o) => !isArchived(o));
  const pending = live.filter((o) => o.status === 'pending');
  const toInv   = db.orders.filter(isWaitingForInvoice);
  const openRet = db.returns.filter((r) => r.status === 'pending');
  const box = $('pendingList');

  if (!pending.length && !toInv.length && !openRet.length) {
    box.innerHTML = '<div class="empty"><div class="ico">🎉</div>הכל מטופל — אין הזמנות או חזרות ממתינות</div>';
    $('actionCard').classList.remove('urgent');
    return;
  }
  $('actionCard').classList.add('urgent');

  const group = (title, list, next, cls) => !list.length ? '' : `
    <div class="act-group">
      <div class="act-title">${title} <span class="chip ${cls}">${list.length}</span></div>
      ${list.slice(0, 8).map((o) => `
        <div class="act-row" data-order="${o.id}">
          <div class="grow">
            <div class="bold">#${o.order_number} · ${esc(o.customers?.business_name || o.customers?.name || o.contact_name || '—')}</div>
            <div class="small muted">${fmtNum(o.total_units)} יח׳ · ${fmtDate(o.created_at, false)}${o.total_amount > 0 ? ' · ' + fmtMoney(o.total_amount) : ''}</div>
          </div>
          ${next === 'invoice'
            ? `<button class="btn ghost sm" data-upload-inv="${o.id}">⬆️ חשבונית</button>`
            : `<button class="btn ${next === 'ready' ? 'success' : 'violet'} sm" data-adv="${o.id}|${next}">
                 ${ORDER_STATUS[next].icon} ${esc(ORDER_STATUS[next].label)}</button>`}
        </div>`).join('')}
      ${list.length > 8 ? `<div class="small faint" style="padding:.3rem .2rem">ועוד ${list.length - 8}…</div>` : ''}
    </div>`;

  // חזרות ממתינות לזיכוי — לצד ההזמנות, כי זו אותה ערמת משימות
  const returnsGroup = !openRet.length ? '' : `
    <div class="act-group">
      <div class="act-title">🔄 חזרות — ממתינות לזיכוי <span class="chip amber">${openRet.length}</span></div>
      ${openRet.slice(0, 8).map((r) => `
        <div class="act-row" data-return="${r.id}">
          <div class="grow">
            <div class="bold">חזרה #${r.return_number} · ${esc(r.returner_name || r.customer_name || '—')}</div>
            <div class="small muted">${fmtNum(r.total_units)} יח׳ · ${fmtDate(r.return_date, false)}${
              r.damaged_units > 0 ? ` · <span class="qty-diff">${r.damaged_units} פגומים</span>` : ''}</div>
          </div>
          <button class="btn success sm" data-credit="${r.id}">✅ בוצע זיכוי</button>
        </div>`).join('')}
      ${openRet.length > 8 ? `<div class="small faint" style="padding:.3rem .2rem">ועוד ${openRet.length - 8}…</div>` : ''}
    </div>`;

  box.innerHTML =
      group('⏳ ממתינות לאישור', pending, 'ready', 'amber')
    + group('🧾 ממתינות להעלאת חשבונית', toInv, 'invoice', 'violet')
    + returnsGroup;

  box.onclick = async (e) => {
    const adv = e.target.closest('[data-adv]');
    if (adv) {
      e.stopPropagation();
      const [id, st] = adv.dataset.adv.split('|');
      await advanceOrder(id, st);
      return;
    }
    const cr = e.target.closest('[data-credit]');
    if (cr) { e.stopPropagation(); await creditReturn(cr.dataset.credit); return; }
    if (e.target.closest('[data-upload-inv]')) return;   // מטופל בהאזנה הכללית

    const ret = e.target.closest('[data-return]');
    if (ret) { openReturn(ret.dataset.return); return; }
    const row = e.target.closest('[data-order]');
    if (row) openOrder(row.dataset.order);
  };
}

// ============================================================
// דשבורד
// ============================================================
function renderDash() {
  renderActionCard();

  const orders = filteredOrders();
  const items  = filteredItems();
  // כסף נספר רק מתאריך תחילת החישוב.
  const money   = profitItems();
  const revenue = money.reduce((a, i) => a + lineNet(i), 0);
  const cost    = money.reduce((a, i) => a + lineCost(i), 0);
  const from    = profitStart();
  const moneyFoot = from ? `מ-${fmtDate(from, false)}` : 'כל התקופה';
  const pending = orders.filter((o) => o.status === 'pending' && !isArchived(o)).length;
  const waitingForInvoice = db.orders.filter(isWaitingForInvoice).length;
  const unpaid  = db.invoices.filter((v) => v.status === 'unpaid').reduce((a, v) => a + Number(v.amount || 0), 0);

  $('kpis').innerHTML = [
    ['הזמנות ממתינות',          fmtNum(pending),           'ממתינות לאישור',                   pending ? 'warn' : 'green'],
    ['ממתינות להעלאת חשבונית',  fmtNum(waitingForInvoice), 'מוכנות או נשלחו, ללא ארכיון',      waitingForInvoice ? 'violet' : 'green'],
    ['מחזור',                   fmtMoney(revenue),         moneyFoot,                           'green'],
    ['רווח',                    fmtMoney(revenue - cost),  cost > 0 ? moneyFoot : 'חסרים מחירי עלות', cost > 0 ? 'green' : 'warn'],
    ['חוב פתוח',                fmtMoney(unpaid),          'חשבוניות שלא שולמו',               unpaid > 0 ? 'red' : 'green'],
  ].map(([label, value, foot, cls]) => `
    <div class="kpi ${cls}">
      <div class="label">${esc(label)}</div>
      <div class="value ${String(value).length > 8 ? 'sm' : ''}">${esc(value)}</div>
      <div class="foot">${esc(foot)}</div>
    </div>`).join('');

  // דגמים מובילים
  const byM = new Map();
  for (const it of items) {
    const e = byM.get(it.model) || { model: it.model, qty: 0 };
    e.qty += it.qty;
    byM.set(it.model, e);
  }
  const top = [...byM.values()].sort((a, b) => b.qty - a.qty);
  const max = top[0]?.qty || 1;

  $('topModels').innerHTML = top.length
    ? top.slice(0, 15).map((m) => {
        const p = productByModel(m.model);
        return `<div class="bar-row">
          ${p?.image_url
            ? `<img class="thumb" style="width:30px;height:30px" src="${esc(img(p.image_url, 80))}" alt="" loading="lazy" decoding="async">`
            : '<div class="thumb img-ph" style="width:30px;height:30px">📷</div>'}
          <span class="nm">${esc(m.model)}</span>
          <div class="bar-track"><div class="bar-fill" style="width:${(m.qty / max * 100).toFixed(1)}%"></div></div>
          <span class="vl">${fmtNum(m.qty)}</span>
        </div>`;
      }).join('')
    : '<div class="empty">אין נתונים</div>';

  // לקוחות
  const byC = new Map();
  for (const it of items) {
    const n = it.order.customers?.name || it.order.contact_name || '—';
    byC.set(n, (byC.get(n) || 0) + it.qty);
  }
  const topC = [...byC.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const maxC = topC[0]?.[1] || 1;
  $('topCustomers').innerHTML = topC.length
    ? topC.map(([n, q]) => `<div class="bar-row">
        <span class="nm" title="${esc(n)}">${esc(n)}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${(q / maxC * 100).toFixed(1)}%"></div></div>
        <span class="vl">${fmtNum(q)}</span>
      </div>`).join('')
    : '<div class="empty">אין נתונים</div>';

  // מלאי נמוך
  const low = [];
  for (const p of db.products) {
    if (!p.is_active) continue;
    if (filters.collection && p.collection_id !== filters.collection) continue;
    for (const [size, qty] of Object.entries(p.stock)) {
      if (qty > 0 && qty < 5) low.push({ model: p.model, size, qty, collection: p.collections?.name });
    }
  }
  low.sort((a, b) => a.qty - b.qty);
  $('lowHint').textContent = low.length ? `${low.length} שורות` : 'תקין';
  $('lowStock').innerHTML = low.length
    ? `<div class="table-wrap"><table class="responsive"><thead><tr>
         <th>דגם</th><th>קולקציה</th><th>מידה</th><th class="num">נותרו</th></tr></thead><tbody>
       ${low.slice(0, 40).map((r) => `<tr>
         ${td('דגם', esc(r.model), 'bold')}
         ${td('קולקציה', esc(r.collection || ''), 'muted small')}
         ${td('מידה', esc(r.size))}
         ${td('נותרו', `<span class="chip ${r.qty <= 2 ? 'red' : 'amber'}">${r.qty}</span>`, 'num')}
       </tr>`).join('')}</tbody></table></div>
       ${low.length > 40 ? `<div class="small faint center" style="margin-top:.6rem">ועוד ${low.length - 40}…</div>` : ''}`
    : '<div class="empty">אין דגמים במלאי נמוך 👍</div>';
}

// ============================================================
// הזמנות — לשוניות לפי סטטוס
//
// "ארכיון" הוא פעולה מפורשת של המנהל (archived_at) ולא נגזרת.
// כך אפשר להוריד מהעיניים גם הזמנות היסטוריות שלא תהיה להן
// חשבונית לעולם, ועדיין להעלות להן חשבונית בהמשך מתוך הארכיון.
// הזמנה ממתינה היא משימה פתוחה, ולכן לא ניתנת לארכוב.
// ============================================================
const hasInvoice = (orderId) => db.invoices.some((v) => v.order_id === orderId);
const isArchived = (o) => !!o.archived_at;
const canArchive = (o) => !o.archived_at && o.status !== 'pending';

const ORDER_BUCKETS = [...STATUS_FLOW, 'archive', 'cancelled'];
const BUCKET_META = {
  archive: { label: 'ארכיון', short: 'ארכיון', icon: '🗄️', color: 'gray' },
};
const bucketMeta = (k) => ORDER_STATUS[k] || BUCKET_META[k];

// ── יצירת הזמנה ידנית — אותה בחירת דגמים ומידות כמו אצל לקוח ──
const newOrderProducts = () => db.products.filter((p) =>
  p.is_active && Object.values(p.stock || {}).some((qty) => Number(qty) > 0));

function newOrderUnits() {
  return Object.values(newOrderCart).reduce((total, sizes) =>
    total + Object.values(sizes).reduce((sum, qty) => sum + Number(qty || 0), 0), 0);
}

function renderNewOrderSummary() {
  const models = Object.values(newOrderCart).filter((sizes) =>
    Object.values(sizes).some((qty) => qty > 0)).length;
  const units = newOrderUnits();
  $('newOrderSummary').textContent = units
    ? `${fmtNum(models)} דגמים · ${fmtNum(units)} יחידות`
    : 'הסל ריק';
}

function renderNewOrderCustomerMode() {
  $$('#newOrderCustomerMode button').forEach((b) =>
    b.classList.toggle('on', b.dataset.newOrderMode === newOrderCustomerMode));
  $('newOrderExistingCustomer').style.display = newOrderCustomerMode === 'existing' ? 'block' : 'none';
  $('newOrderNewCustomer').style.display = newOrderCustomerMode === 'new' ? 'block' : 'none';
  closeNewOrderCustomerOptions();
  showError('newOrderError', '');
}

const newOrderCustomerLabel = (customer) => customer.business_name
  ? `${customer.business_name} — ${customer.name}`
  : customer.name;

function closeNewOrderCustomerOptions() {
  newOrderCustomerHighlight = -1;
  $('newOrderCustomerList').classList.remove('open');
  $('newOrderCustomerSearch').setAttribute('aria-expanded', 'false');
  $('newOrderCustomerSearch').removeAttribute('aria-activedescendant');
}

function renderNewOrderCustomerOptions(open = true) {
  const selected = $('newOrderCustomer').value;
  const q = $('newOrderCustomerSearch').value.trim().toLowerCase();
  const customers = db.customers
    .filter((c) => c.is_active !== false)
    .filter((c) => !q
      || newOrderCustomerLabel(c).toLowerCase().includes(q)
      || (c.name || '').toLowerCase().includes(q)
      || (c.business_name || '').toLowerCase().includes(q)
      || (c.phone || '').includes(q)
      || (c.email || '').toLowerCase().includes(q))
    .sort((a, b) => (a.business_name || a.name).localeCompare(b.business_name || b.name, 'he'));

  const list = $('newOrderCustomerList');
  list.innerHTML = customers.length ? customers.map((c, index) => {
    const details = [c.phone, c.email, c.city].filter(Boolean).join(' · ');
    return `<button type="button" class="customer-option ${c.id === selected ? 'selected' : ''}"
                    id="newOrderCustomerOption${index}" role="option"
                    aria-selected="${c.id === selected}" data-new-order-customer="${c.id}">
      <span class="customer-option-title">${esc(newOrderCustomerLabel(c))}</span>
      ${details ? `<span class="customer-option-details">${esc(details)}</span>` : ''}
    </button>`;
  }).join('') : '<div class="customer-option-empty">לא נמצאו לקוחות מתאימים</div>';

  const selectedIndex = customers.findIndex((c) => c.id === selected);
  newOrderCustomerHighlight = selectedIndex;
  list.classList.toggle('open', open);
  $('newOrderCustomerSearch').setAttribute('aria-expanded', String(open));
  updateNewOrderCustomerHighlight();
}

function updateNewOrderCustomerHighlight() {
  const options = $$('#newOrderCustomerList [data-new-order-customer]');
  options.forEach((option, index) => option.classList.toggle('highlighted', index === newOrderCustomerHighlight));
  const active = options[newOrderCustomerHighlight];
  if (active) {
    $('newOrderCustomerSearch').setAttribute('aria-activedescendant', active.id);
    active.scrollIntoView({ block: 'nearest' });
  } else {
    $('newOrderCustomerSearch').removeAttribute('aria-activedescendant');
  }
}

function selectNewOrderCustomer(customerId) {
  const customer = db.customers.find((c) => c.id === customerId && c.is_active !== false);
  if (!customer) return;
  $('newOrderCustomer').value = customer.id;
  $('newOrderCustomerSearch').value = newOrderCustomerLabel(customer);
  closeNewOrderCustomerOptions();
  showError('newOrderError', '');
}

function renderNewOrderCollections() {
  const products = newOrderProducts();
  const collections = db.collections.filter((c) =>
    c.is_active && products.some((p) => p.collection_id === c.id));

  if (!newOrderCollection || !collections.some((c) => c.id === newOrderCollection)) {
    newOrderCollection = collections[0]?.id || null;
  }

  $('newOrderCollectionTabs').innerHTML = collections.map((c) => {
    const count = products.filter((p) => p.collection_id === c.id).length;
    return `<button class="tab ${c.id === newOrderCollection ? 'active' : ''}" data-new-order-col="${c.id}">
      ${esc(c.icon || '📦')} ${esc(c.name)} <span class="tab-count">${count}</span>
    </button>`;
  }).join('');
}

function renderNewOrderProducts() {
  const q = $('newOrderProductSearch').value.trim().toLowerCase();
  const products = newOrderProducts().filter((p) =>
    p.collection_id === newOrderCollection
    && (!q || p.model.toLowerCase().includes(q) || (p.description || '').toLowerCase().includes(q)));
  const box = $('newOrderProductList');

  if (!products.length) {
    box.innerHTML = '<div class="empty"><div class="ico">🔍</div>לא נמצאו דגמים זמינים</div>';
    return;
  }

  box.innerHTML = products.map((p) => {
    const sizes = Object.entries(p.stock || {})
      .filter(([, qty]) => Number(qty) > 0)
      .map(([size]) => size)
      .sort(sortSizes);
    return `<div class="product" data-new-order-model="${esc(p.model)}">
      <div class="product-img" data-new-order-zoom="${esc(p.model)}">
        ${imgTag(p.image_url, 'דגם ' + p.model, 320)}
        ${p.image_url ? '<span class="zoom" aria-hidden="true">🔍</span>' : ''}
      </div>
      <div class="product-body">
        <div class="product-top">
          <div class="product-title">דגם ${esc(p.model)}</div>
          <button class="btn ghost sm" data-new-order-series="${esc(p.model)}">📦 סריה</button>
        </div>
        ${p.description ? `<div class="product-desc">${esc(p.description)}</div>` : ''}
        <div class="sizes">
          ${sizes.map((size) => {
            const qty = newOrderCart[p.model]?.[size] || 0;
            return `<label class="size">
              <span class="lbl">${esc(size)}</span>
              <input type="number" inputmode="numeric" pattern="[0-9]*" min="0" max="${p.stock[size]}"
                     value="${qty || ''}" placeholder="0" class="${qty > 0 ? 'on' : ''}"
                     aria-label="דגם ${esc(p.model)} מידה ${esc(size)}"
                     data-new-order-qty="${esc(p.model)}|${esc(size)}">
            </label>`;
          }).join('')}
        </div>
      </div>
    </div>`;
  }).join('');
}

function setNewOrderQty(input) {
  const [model, size] = input.dataset.newOrderQty.split('|');
  const max = Number(input.max) || 0;
  let qty = parseInt(input.value, 10);
  if (!Number.isFinite(qty) || qty < 0) qty = 0;
  if (qty > max) {
    qty = max;
    toast(`דגם ${model} מידה ${size}: אין כמות כזו במלאי`, true);
  }

  input.value = qty || '';
  input.classList.toggle('on', qty > 0);
  if (qty > 0) {
    (newOrderCart[model] ||= {})[size] = qty;
  } else if (newOrderCart[model]) {
    delete newOrderCart[model][size];
    if (!Object.keys(newOrderCart[model]).length) delete newOrderCart[model];
  }
  renderNewOrderSummary();
}

function addNewOrderSeries(model) {
  const product = db.products.find((p) => p.model === model);
  if (!product) return;
  const cart = (newOrderCart[model] ||= {});
  for (const [size, available] of Object.entries(product.stock || {})) {
    if (available > 0 && (cart[size] || 0) < available) cart[size] = (cart[size] || 0) + 1;
  }
  renderNewOrderProducts();
  renderNewOrderSummary();
  toast(`נוספה סריה לדגם ${model}`);
}

function openNewOrder() {
  newOrderCustomerMode = 'existing';
  newOrderCart = {};
  newOrderCollection = null;
  newOrderSubmitting = false;

  for (const id of ['newOrderCustomerSearch', 'newOrderName', 'newOrderBusiness',
                    'newOrderPhone', 'newOrderEmail', 'newOrderCity',
                    'newOrderProductSearch', 'newOrderNotes']) {
    $(id).value = '';
  }
  $('newOrderCustomer').value = '';
  $('newOrderSubmit').disabled = false;
  $('newOrderSubmit').textContent = 'יצירת הזמנה';
  showError('newOrderError', '');

  renderNewOrderCustomerMode();
  renderNewOrderCustomerOptions(false);
  renderNewOrderCollections();
  renderNewOrderProducts();
  renderNewOrderSummary();
  $('newOrderOverlay').classList.add('active');
}

async function submitNewOrder() {
  if (newOrderSubmitting) return;
  showError('newOrderError', '');

  const customerId = newOrderCustomerMode === 'existing' ? $('newOrderCustomer').value : null;
  const customer = newOrderCustomerMode === 'new' ? {
    name: $('newOrderName').value.trim(),
    business_name: $('newOrderBusiness').value.trim() || null,
    phone: $('newOrderPhone').value.trim() || null,
    email: $('newOrderEmail').value.trim() || null,
    city: $('newOrderCity').value.trim() || null,
  } : null;

  if (newOrderCustomerMode === 'existing' && !customerId) {
    showError('newOrderError', 'יש לבחור לקוח');
    return;
  }
  if (newOrderCustomerMode === 'new' && !customer.name) {
    showError('newOrderError', 'יש להזין שם ללקוח החדש');
    return;
  }

  const items = [];
  for (const [model, sizes] of Object.entries(newOrderCart)) {
    for (const [size, qty] of Object.entries(sizes)) {
      if (qty > 0) items.push({ model, size, qty });
    }
  }
  if (!items.length) {
    showError('newOrderError', 'יש לבחור לפחות מוצר אחד');
    return;
  }

  newOrderSubmitting = true;
  const btn = $('newOrderSubmit');
  btn.disabled = true;
  btn.textContent = 'יוצר הזמנה…';

  try {
    const { data, error } = await sb.rpc('admin_create_order', {
      p_customer_id: customerId || null,
      p_customer: customer,
      p_notes: $('newOrderNotes').value.trim() || null,
      p_items: items,
    });
    if (error) throw error;

    $('newOrderOverlay').classList.remove('active');
    orderStatusTab = 'pending';
    const duplicateNote = data.duplicate_pending ? ' · הלקוח סומן לבדיקת כפילות' : '';
    toast(`הזמנה #${data.order_number} נוצרה · ${fmtNum(data.total_units)} יחידות${duplicateNote}`);
    notifyOrder(data.order_id, 'created');
    await loadAll();
    if (activeTab !== 'orders') switchTab('orders');
    openOrder(data.order_id);
  } catch (err) {
    showError('newOrderError', friendlyError(err));
  } finally {
    newOrderSubmitting = false;
    btn.disabled = false;
    btn.textContent = 'יצירת הזמנה';
  }
}

function inBucket(o, bucket) {
  // "בוטלו" גובר על הארכיון: שם מוחקים ומשחזרים, ושם צריך למצוא אותן
  if (o.status === 'cancelled') return bucket === 'cancelled';
  if (bucket === 'archive') return isArchived(o);
  if (isArchived(o)) return false;
  return o.status === bucket;
}

function renderOrders() {
  const all = filteredOrders();
  const counts = {};
  for (const k of ORDER_BUCKETS) counts[k] = all.filter((o) => inBucket(o, k)).length;

  $('statusTabs').innerHTML = ORDER_BUCKETS.map((k) => {
    const s = bucketMeta(k);
    return `<button class="tab ${k === orderStatusTab ? 'active' : ''}" data-st="${k}">
      ${s.icon} ${esc(s.short)} <span class="tab-count">${counts[k]}</span></button>`;
  }).join('');

  $('statusTabs').onclick = (e) => {
    const b = e.target.closest('[data-st]');
    if (!b) return;
    orderStatusTab = b.dataset.st;
    renderOrders();
  };

  const orders = all.filter((o) => inBucket(o, orderStatusTab));

  const meta = bucketMeta(orderStatusTab);
  if (!orders.length) {
    $('ordersTable').innerHTML =
      `<div class="empty"><div class="ico">${meta.icon}</div>
       אין הזמנות ב"${esc(meta.label)}"</div>`;
    return;
  }

  const archiveView   = orderStatusTab === 'archive';
  const cancelledView = orderStatusTab === 'cancelled';
  const archivable    = orders.filter(canArchive);

  const rowActions = (o, next, nInv) => {
    if (cancelledView) {
      return `<button class="btn ghost sm" data-restore="${o.id}">↩️ שחזור</button>
              <button class="btn danger sm" data-del-order="${o.id}">🗑️ מחיקה</button>`;
    }
    if (archiveView) {
      return `<button class="btn ghost sm" data-upload-inv="${o.id}">⬆️ חשבונית</button>
              <button class="btn ghost sm" data-unarchive="${o.id}">↩️ מהארכיון</button>`;
    }
    const parts = [];
    if (next) {
      parts.push(`<button class="btn ${next === 'ready' ? 'success' : next === 'shipped' ? 'violet' : ''} sm"
        data-adv="${o.id}|${next}">${ORDER_STATUS[next].icon} ${esc(ORDER_STATUS[next].label)}</button>`);
    }
    if (o.status === 'shipped' && !nInv) {
      parts.push(`<button class="btn ghost sm" data-upload-inv="${o.id}">⬆️ חשבונית</button>`);
    }
    if (canArchive(o)) {
      parts.push(`<button class="btn ghost sm" data-archive="${o.id}" title="העברה לארכיון">🗄️</button>`);
    }
    return parts.join(' ');
  };

  $('ordersTable').innerHTML = `
    ${archiveView ? `<div class="note small">
       הזמנות שהמנהל העביר לארכיון. הטיפול בהן הסתיים — אפשר עדיין להעלות להן
       חשבונית, והן ייכללו ברווחיות אם תזיז אחורה את <b>תאריך תחילת החישוב</b>
       בלשונית 💰 רווחיות.</div>` : ''}
    ${cancelledView ? `<div class="note small">
       <b>שחזור</b> מחזיר את ההזמנה למצב "ממתינה". <b>מחיקה</b> היא לצמיתות —
       החשבוניות יישמרו אבל יאבדו את השיוך להזמנה.</div>` : ''}
    ${archivable.length && !archiveView && !cancelledView ? `<div class="row" style="margin-bottom:.7rem">
       <button class="btn ghost sm" id="archiveBucket">🗄️ העבר את כל ${fmtNum(archivable.length)} ההזמנות בלשונית לארכיון</button>
     </div>` : ''}
    <div class="table-wrap"><table class="responsive"><thead><tr>
      <th>#</th><th>לקוח</th><th>תאריך</th><th class="num">יח׳</th>
      <th class="num">סכום</th>${archiveView ? '<th>סטטוס</th>' : ''}<th class="num">🧾</th><th></th>
    </tr></thead><tbody>
    ${orders.slice(0, 400).map((o) => {
      const next = ORDER_STATUS[o.status].next;
      const nInv = db.invoices.filter((v) => v.order_id === o.id).length;
      const note = db.orderNotes[o.id];
      return `<tr class="clickable" data-order="${o.id}">
      ${td('הזמנה', `#${o.order_number}${note ? ' <span title="יש הערת מנהל">📝</span>' : ''}`, 'bold')}
      ${td('לקוח', esc(o.customers?.business_name || o.customers?.name || o.contact_name || '—'))}
      ${td('תאריך', fmtDate(o.created_at, false), 'small nowrap')}
      ${td('יחידות', fmtNum(o.total_units), 'num')}
      ${td('סכום', o.total_amount > 0
        ? fmtMoney(o.total_amount) + (o.discount_amount > 0
            ? ` <span class="chip green" title="הנחה ${fmtMoney(o.discount_amount)}">−${o.discount_type === 'pct' ? o.discount_value + '%' : fmtMoney(o.discount_amount)}</span>`
            : '')
        : '—', 'num')}
      ${archiveView ? td('סטטוס', statusChip(ORDER_STATUS, o.status)) : ''}
      ${td('חשבוניות', nInv ? `<span class="chip green">${nInv}</span>` : '—', 'num')}
      ${td('', rowActions(o, next, nInv), 'nowrap')}
    </tr>`; }).join('')}
    </tbody></table></div>
    ${orders.length > 400 ? `<div class="small faint center" style="margin-top:.7rem">
      מוצגות 400 מתוך ${fmtNum(orders.length)} — צמצם את הסינון או ייצא</div>` : ''}`;

  on('archiveBucket', 'click', async () => {
    if (!confirm(`להעביר ${archivable.length} הזמנות לארכיון?\n\nאפשר להחזיר אותן משם בכל רגע.`)) return;
    try {
      const { data, error } = await sb.rpc('archive_orders', { p_ids: archivable.map((o) => o.id) });
      if (error) throw error;
      toast(`${fmtNum(data?.archived ?? 0)} הזמנות הועברו לארכיון`);
      await loadAll();
    } catch (err) { toast(friendlyError(err), true); }
  });

  $('ordersTable').onclick = async (e) => {
    const adv = e.target.closest('[data-adv]');
    if (adv) {
      e.stopPropagation();
      const [id, st] = adv.dataset.adv.split('|');
      await advanceOrder(id, st);
      return;
    }
    const arc = e.target.closest('[data-archive]');
    if (arc) { e.stopPropagation(); await setArchived(arc.dataset.archive, true); return; }
    const un = e.target.closest('[data-unarchive]');
    if (un) { e.stopPropagation(); await setArchived(un.dataset.unarchive, false); return; }
    const rs = e.target.closest('[data-restore]');
    if (rs) { e.stopPropagation(); await restoreOrder(rs.dataset.restore); return; }
    const dl = e.target.closest('[data-del-order]');
    if (dl) { e.stopPropagation(); await deleteOrder(dl.dataset.delOrder); return; }
    if (e.target.closest('[data-upload-inv]')) return;    // מטופל בהאזנה הכללית

    const row = e.target.closest('[data-order]');
    if (row) openOrder(row.dataset.order);
  };
}

// ============================================================
// ארכיון, שחזור ומחיקה
// ============================================================
async function setArchived(id, archived) {
  const o = db.orders.find((x) => x.id === id);
  try {
    const { error } = await sb.rpc('archive_order', { p_order_id: id, p_archived: archived });
    if (error) throw error;
    toast(archived ? `הזמנה #${o?.order_number} הועברה לארכיון` : `הזמנה #${o?.order_number} חזרה מהארכיון`);
    $('orderOverlay').classList.remove('active');
    await loadAll();
  } catch (err) {
    toast(friendlyError(err), true);
  }
}

async function restoreOrder(id) {
  const o = db.orders.find((x) => x.id === id);
  if (!confirm(`לשחזר את הזמנה #${o?.order_number}?\n\nהיא תחזור למצב "ממתינה" ותופיע שוב ברשימת המשימות.`)) return;
  await advanceOrder(id, 'pending', true);
}

async function deleteOrder(id) {
  const o = db.orders.find((x) => x.id === id);
  if (!confirm(`למחוק לצמיתות את הזמנה #${o?.order_number}?\n\n`
    + `${fmtNum(o?.total_units)} יחידות · ${esc(o?.customers?.name || o?.contact_name || '')}\n`
    + 'הפעולה אינה הפיכה. חשבוניות שהועלו יישמרו אך יאבדו את השיוך.')) return;
  try {
    const { data, error } = await sb.rpc('delete_order', { p_order_id: id });
    if (error) throw error;
    toast(`הזמנה #${data?.order_number} נמחקה`);
    $('orderOverlay').classList.remove('active');
    await loadAll();
  } catch (err) {
    toast(friendlyError(err), true);
  }
}

async function advanceOrder(id, status, skipConfirm = false) {
  const o = db.orders.find((x) => x.id === id);
  const label = ORDER_STATUS[status].label;

  if (!skipConfirm) {
    if (status === 'ready') {
      if (!confirm(`לסמן הזמנה #${o?.order_number} כ"${label}"?\n\nהמלאי יירד ב-${fmtNum(o?.total_units)} יחידות.`)) return;
    } else if (!confirm(`לסמן הזמנה #${o?.order_number} כ"${label}"?`)) return;
  }

  try {
    const { data, error } = await sb.rpc('set_order_status', { p_order_id: id, p_status: status });
    if (error) throw error;

    if (data?.missing?.length) toast(`עודכן, אך ${data.missing.length} שורות לא נמצאו במלאי`, true);
    else toast(`ההזמנה סומנה כ"${label}"`);

    if (status === 'shipped') notifyOrder(id, 'shipped');
    $('orderOverlay').classList.remove('active');
    await loadAll();
  } catch (err) {
    toast(friendlyError(err), true);
  }
}

async function notifyOrder(orderId, event) {
  try { await sb.functions.invoke('order-email', { body: { order_id: orderId, event } }); }
  catch (err) { console.warn('order-email failed', err); }
}

function openOrder(id) {
  const o = db.orders.find((x) => x.id === id);
  if (!o) return;

  const lines = (o.order_items || []).slice()
    .sort((a, b) => a.model.localeCompare(b.model, 'he') || sortSizes(a.size, b.size));
  const invs = db.invoices.filter((v) => v.order_id === o.id);
  const editable = o.status === 'pending' && !o.stock_applied;
  // ההנחה נקבעת רק כשידוע מה באמת יוצא ללקוח
  const canDiscount = ['ready', 'shipped', 'paid'].includes(o.status);
  // הוזמן מול סופק — רלוונטי רק אם המנהל שינה כמויות לפני השליחה
  const anyShort = lines.some((l) => (l.qty_ordered ?? l.qty) !== l.qty);
  const sub = Number(o.subtotal_amount || o.total_amount || 0);

  $('orderPanelTitle').textContent = `הזמנה #${o.order_number}`;
  $('orderPanelBody').innerHTML = `
    <div class="row" style="margin-bottom:.9rem">
      ${statusChip(ORDER_STATUS, o.status)}
      ${isArchived(o) ? '<span class="chip gray">🗄️ בארכיון</span>' : ''}
      <span class="muted small">${fmtDate(o.created_at)}</span>
    </div>

    <div class="card" style="padding:.8rem;margin-bottom:.9rem">
      <div class="grid-2 small">
        <div><span class="muted">לקוח:</span> <b>${esc(o.customers?.name || o.contact_name || '—')}</b></div>
        <div><span class="muted">עסק:</span> ${esc(o.customers?.business_name || '—')}</div>
        <div><span class="muted">טלפון:</span> ${o.phone ? `<a href="tel:${esc(o.phone)}">${esc(o.phone)}</a>` : '—'}</div>
        <div><span class="muted">מייל:</span> ${o.email ? `<a href="mailto:${esc(o.email)}">${esc(o.email)}</a>` : '—'}</div>
        <div><span class="muted">יחידות:</span> <b>${fmtNum(o.total_units)}</b></div>
        <div><span class="muted">לתשלום:</span> <b>${o.total_amount > 0 ? fmtMoney(o.total_amount) : '—'}</b></div>
      </div>
      ${o.discount_amount > 0 ? `<div class="small" style="margin-top:.5rem">
        <span class="muted">לפני הנחה:</span> ${fmtMoney(sub)} ·
        <span class="muted">הנחה:</span> <b style="color:var(--success)">−${fmtMoney(o.discount_amount)}</b>
        ${o.discount_type === 'pct' ? ` <span class="chip green">${o.discount_value}%</span>` : ''}
      </div>` : ''}
      ${o.notes ? `<div class="small" style="margin-top:.5rem"><span class="muted">הערת לקוח:</span> ${esc(o.notes)}</div>` : ''}
    </div>

    <h4 class="bold" style="margin-bottom:.5rem">💸 הנחה על ההזמנה</h4>
    ${canDiscount ? `
      <div class="note small">הזן אחוז או סכום. ריק או 0 מבטל את ההנחה.</div>
      <div class="disc-row" style="margin-bottom:.4rem">
        <div class="seg" id="discSeg">
          <button data-dtype="pct" class="${o.discount_type !== 'amt' ? 'on' : ''}">%</button>
          <button data-dtype="amt" class="${o.discount_type === 'amt' ? 'on' : ''}">₪</button>
        </div>
        <input type="number" id="discValue" min="0" step="0.5" inputmode="decimal"
               value="${o.discount_value > 0 ? o.discount_value : ''}" placeholder="0"
               aria-label="שיעור או סכום ההנחה">
        <button class="btn sm" id="discSave">שמירה</button>
      </div>
      <div class="small muted" id="discPreview" style="margin-bottom:1rem"></div>`
    : `<div class="note small" style="margin-bottom:1rem">
        ההנחה נפתחת משלב <b>"מוכנה לאיסוף"</b> והלאה — עד אז הכמויות עוד יכולות להשתנות.</div>`}

    <h4 class="bold" style="margin-bottom:.5rem">📝 הערת מנהל</h4>
    <div class="note small">גלויה למנהלים בלבד. הלקוח לא רואה אותה.</div>
    <div class="field">
      <textarea id="admNotes" rows="2"
        placeholder="לדוגמה: תיאמנו איסוף ליום ג׳, חסר דגם 2420 במידה L…">${esc(db.orderNotes[o.id] || '')}</textarea>
    </div>
    <button class="btn ghost sm" id="admNotesSave" style="margin-bottom:1.1rem">שמירת ההערה</button>

    <h4 class="bold" style="margin-bottom:.5rem">פריטים (${lines.length})</h4>
    ${editable
      ? '<div class="note small">✏️ ניתן לשנות כמויות ולמחוק שורות כל עוד ההזמנה ממתינה. אחרי סימון "מוכנה לאיסוף" המלאי יורד וההזמנה ננעלת.</div>'
      : '<div class="note small">🔒 ההזמנה נעולה לעריכה — המלאי כבר עודכן.</div>'}
    ${anyShort ? '<div class="note warn small">⚠️ בשורות המסומנות הכמות שסופקה שונה ממה שהלקוח הזמין. הלקוח רואה את שתי הכמויות באזור האישי.</div>' : ''}

    <div class="table-wrap" style="margin-bottom:1rem">
      <table class="responsive"><thead><tr>
        <th>דגם</th><th>מידה</th>${anyShort ? '<th class="num">הוזמן</th>' : ''}
        <th class="num">${anyShort ? 'סופק' : 'כמות'}</th><th class="num">מחיר</th><th class="num">סה״כ</th>${editable ? '<th></th>' : ''}
      </tr></thead><tbody>
      ${lines.map((l) => {
        const ord = l.qty_ordered ?? l.qty;
        const short = ord !== l.qty;
        return `<tr class="${short ? 'short' : ''}">
        ${td('דגם', esc(l.model), 'bold')}
        ${td('מידה', esc(l.size))}
        ${anyShort ? td('הוזמן', `<span class="${short ? 'qty-diff' : 'muted'}">${ord}</span>`, 'num') : ''}
        ${td(anyShort ? 'סופק' : 'כמות', editable
          ? `<input type="number" min="0" value="${l.qty}" data-item="${l.id}"
               style="width:74px;text-align:center;font-weight:800;min-height:40px">`
          : l.qty, 'num')}
        ${td('מחיר', l.unit_price > 0 ? fmtMoney(l.unit_price) : '—', 'num')}
        ${td('סה״כ', l.unit_price > 0 ? fmtMoney(l.qty * l.unit_price) : '—', 'num')}
        ${editable ? td('', `<button class="btn danger sm" data-del-item="${l.id}">🗑️</button>`) : ''}
      </tr>`; }).join('')}
      </tbody></table>
    </div>

    <h4 class="bold" style="margin-bottom:.5rem">חשבוניות (${invs.length})</h4>
    ${invs.length
      ? invs.map((v) => `<div class="row small" style="padding:.4rem 0;border-bottom:1px solid var(--border)">
          <span class="bold">${esc(v.invoice_number || v.file_name || '—')}</span>
          ${statusChip(INVOICE_STATUS, v.status)}
          <span class="grow"></span>
          <span>${v.amount != null ? fmtMoney(v.amount) : ''}</span>
        </div>`).join('')
      : '<div class="small muted">טרם הועלתה חשבונית</div>'}
    <button class="btn ghost sm" style="margin-top:.6rem" data-upload-inv="${o.id}">⬆️ העלאת חשבונית</button>
  `;

  const next = ORDER_STATUS[o.status].next;
  $('orderPanelFoot').innerHTML = `
    <div class="row">
      ${next ? `<button class="btn ${next === 'ready' ? 'success' : next === 'shipped' ? 'violet' : ''}"
        data-adv-panel="${o.id}|${next}">${ORDER_STATUS[next].icon} ${esc(ORDER_STATUS[next].label)}</button>` : ''}
      ${canArchive(o) ? `<button class="btn ghost sm" data-archive-panel="${o.id}">🗄️ לארכיון</button>` : ''}
      ${isArchived(o) ? `<button class="btn ghost sm" data-unarchive-panel="${o.id}">↩️ מהארכיון</button>` : ''}
      <button class="btn ghost sm" data-export-order="${o.id}">⬇️ ייצוא</button>
      <span class="grow"></span>
      ${o.status === 'cancelled'
        ? `<button class="btn ghost sm" data-restore-panel="${o.id}">↩️ שחזור</button>
           <button class="btn danger sm" data-del-order-panel="${o.id}">🗑️ מחיקה</button>`
        : `<button class="btn danger sm" data-adv-panel="${o.id}|cancelled">ביטול</button>`}
    </div>`;

  if (editable) {
    $('orderPanelBody').onchange = async (e) => {
      const inp = e.target.closest('[data-item]');
      if (inp) await editItem(inp.dataset.item, parseInt(inp.value, 10), o.id);
    };
  } else {
    $('orderPanelBody').onchange = null;
  }

  wireOrderPanel(o, sub);
  $('orderOverlay').classList.add('active');
}

// ── הנחה והערת מנהל בתוך פאנל ההזמנה ────────────────────────
function wireOrderPanel(o, sub) {
  on('admNotesSave', 'click', async () => {
    const btn = $('admNotesSave');
    const body = $('admNotes').value.trim();
    btn.disabled = true;
    try {
      const { error } = await sb.from('order_admin_notes').upsert({
        order_id: o.id, notes: body || null,
        updated_by: state.user.id, updated_at: new Date().toISOString(),
      }, { onConflict: 'order_id' });
      if (error) throw error;
      db.orderNotes[o.id] = body;
      toast(body ? 'ההערה נשמרה' : 'ההערה נמחקה');
      if (activeTab === 'orders') renderOrders();
    } catch (err) { toast(friendlyError(err), true); }
    finally { btn.disabled = false; }
  });

  const seg = $('discSeg');
  if (!seg) return;

  let dtype = o.discount_type === 'amt' ? 'amt' : 'pct';

  const preview = () => {
    const v = Number($('discValue').value) || 0;
    const amount = dtype === 'pct'
      ? Math.round(sub * Math.min(Math.max(v, 0), 100)) / 100
      : Math.min(Math.max(v, 0), sub);
    $('discPreview').innerHTML = v > 0
      ? `${fmtMoney(sub)} − <b style="color:var(--success)">${fmtMoney(amount)}</b> =
         <b>${fmtMoney(Math.max(sub - amount, 0))}</b>`
      : `ללא הנחה · לתשלום ${fmtMoney(sub)}`;
  };

  seg.onclick = (e) => {
    const b = e.target.closest('[data-dtype]');
    if (!b) return;
    dtype = b.dataset.dtype;
    $$('#discSeg button').forEach((x) => x.classList.toggle('on', x.dataset.dtype === dtype));
    preview();
  };
  on('discValue', 'input', preview);
  preview();

  on('discSave', 'click', async () => {
    const raw = $('discValue').value.trim();
    const v = raw === '' ? 0 : Number(raw);
    if (!Number.isFinite(v) || v < 0) { toast('ערך הנחה לא תקין', true); return; }
    if (dtype === 'pct' && v > 100) { toast('אחוז הנחה לא יכול לעבור 100', true); return; }
    if (dtype === 'amt' && v > sub) { toast('סכום ההנחה גדול מסכום ההזמנה', true); return; }

    $('discSave').disabled = true;
    try {
      const { data, error } = await sb.rpc('set_order_discount', {
        p_order_id: o.id,
        p_type: v > 0 ? dtype : null,
        p_value: v,
      });
      if (error) throw error;
      toast(v > 0 ? `ההנחה נשמרה — לתשלום ${fmtMoney(data.total)}` : 'ההנחה בוטלה');
      await loadAll();
      openOrder(o.id);
    } catch (err) {
      toast(friendlyError(err), true);
      $('discSave').disabled = false;
    }
  });
}

async function editItem(itemId, qty, orderId) {
  try {
    const { data, error } = await sb.rpc('edit_order_item', {
      p_item_id: Number(itemId), p_qty: Number.isFinite(qty) ? qty : 0,
    });
    if (error) throw error;
    toast(qty > 0 ? 'הכמות עודכנה' : 'השורה נמחקה');

    await loadAll();
    if (data?.lines_left > 0) openOrder(orderId);
    else { $('orderOverlay').classList.remove('active'); toast('ההזמנה נותרה ללא פריטים', true); }
  } catch (err) {
    toast(friendlyError(err), true);
    openOrder(orderId);
  }
}

// ============================================================
// ריכוז לפי דגם
// ============================================================
// סינון ייעודי ללשונית הריכוז
const dmFilters = { collection: '', model: '', status: '' };

function demandItems() {
  const q = dmFilters.model.trim().toLowerCase();
  return filteredItems().filter((it) => {
    if (q && !it.model.toLowerCase().includes(q)) return false;
    if (dmFilters.collection && productCollection(it.model) !== dmFilters.collection) return false;
    if (dmFilters.status && it.order.status !== dmFilters.status) return false;
    return true;
  });
}

// source מאפשר ללשונית הרווחיות להזין את החלון שלה במקום סינון הריכוז
function demandMatrix(source = null) {
  const items = source || demandItems();
  const map = new Map();

  for (const it of items) {
    let e = map.get(it.model);
    if (!e) {
      const p = productByModel(it.model);
      e = {
        model: it.model,
        collection: p?.collections?.name || '',
        image: p?.image_url || '',
        cost: p?.cost_price || 0,
        wholesale: p?.wholesale_price || 0,
        retail: p?.retail_price || 0,
        sizes: {}, total: 0, amount: 0, profit: 0, orders: new Set(),
      };
      map.set(it.model, e);
    }
    e.sizes[it.size] = (e.sizes[it.size] || 0) + it.qty;
    e.total  += it.qty;
    e.amount += lineNet(it);
    e.profit += lineNet(it) - lineCost(it);
    e.orders.add(it.order.id);
  }
  return [...map.values()].sort((a, b) => b.total - a.total);
}

function usedSizes(rows) {
  const set = new Set();
  for (const r of rows) for (const s of Object.keys(r.sizes)) set.add(s);
  return SIZES.filter((s) => set.has(s));
}

// מי הזמין דגם מסוים, וכמה — הבסיס גם למסך הפירוט וגם לגיליון הייצוא
function demandBreakdown(model) {
  const rows = new Map();
  for (const it of demandItems()) {
    if (it.model !== model) continue;
    const o = it.order;
    const key = o.id;
    let e = rows.get(key);
    if (!e) {
      e = {
        order_number: o.order_number,
        customer: o.customers?.business_name || o.customers?.name || o.contact_name || '—',
        date: o.created_at,
        status: o.status,
        sizes: {}, total: 0, amount: 0,
      };
      rows.set(key, e);
    }
    e.sizes[it.size] = (e.sizes[it.size] || 0) + it.qty;
    e.total  += it.qty;
    e.amount += it.qty * (it.unit_price || 0);
  }
  return [...rows.values()].sort((a, b) => b.total - a.total);
}

function openDemandDetail(model) {
  const rows = demandBreakdown(model);
  if (!rows.length) return;

  const cols = SIZES.filter((s) => rows.some((r) => r.sizes[s]));
  const p = productByModel(model);
  const total = rows.reduce((a, r) => a + r.total, 0);

  // מאחד לפי לקוח, כי אותו לקוח יכול להזמין את אותו דגם כמה פעמים
  const byCust = new Map();
  for (const r of rows) {
    let e = byCust.get(r.customer);
    if (!e) { e = { customer: r.customer, orders: 0, sizes: {}, total: 0, amount: 0 }; byCust.set(r.customer, e); }
    e.orders++;
    for (const [s, q] of Object.entries(r.sizes)) e.sizes[s] = (e.sizes[s] || 0) + q;
    e.total += r.total;
    e.amount += r.amount;
  }
  const custRows = [...byCust.values()].sort((a, b) => b.total - a.total);

  $('orderPanelTitle').textContent = `דגם ${model} — מי הזמין`;
  $('orderPanelBody').innerHTML = `
    <div class="row" style="margin-bottom:1rem">
      ${p?.image_url
        ? `<img class="thumb" style="width:64px;height:64px" src="${esc(img(p.image_url, 160))}" alt="">`
        : ''}
      <div>
        <div class="bold" style="font-size:1.05rem">דגם ${esc(model)}</div>
        <div class="small muted">${esc(p?.collections?.name || '')} · ${fmtNum(total)} יח׳ ב-${rows.length} הזמנות</div>
      </div>
    </div>

    <h4 class="bold" style="margin-bottom:.5rem">לפי לקוח (${custRows.length})</h4>
    <div class="table-wrap" style="margin-bottom:1.2rem">
      <table class="responsive"><thead><tr>
        <th>לקוח</th><th class="num">הזמנות</th>
        ${cols.map((s) => `<th class="num">${esc(s)}</th>`).join('')}
        <th class="num">סה״כ</th><th class="num">שווי</th>
      </tr></thead><tbody>
      ${custRows.map((r) => `<tr>
        ${td('לקוח', esc(r.customer), 'bold')}
        ${td('הזמנות', r.orders, 'num')}
        ${cols.map((s) => td(s, r.sizes[s] || '<span class="faint">·</span>', 'num')).join('')}
        ${td('סה״כ', fmtNum(r.total), 'num bold')}
        ${td('שווי', r.amount > 0 ? fmtMoney(r.amount) : '—', 'num')}
      </tr>`).join('')}
      </tbody></table>
    </div>

    <h4 class="bold" style="margin-bottom:.5rem">לפי הזמנה (${rows.length})</h4>
    <div class="table-wrap">
      <table class="responsive"><thead><tr>
        <th>#</th><th>לקוח</th><th>תאריך</th><th>סטטוס</th>
        ${cols.map((s) => `<th class="num">${esc(s)}</th>`).join('')}
        <th class="num">סה״כ</th>
      </tr></thead><tbody>
      ${rows.map((r) => `<tr>
        ${td('הזמנה', '#' + r.order_number, 'bold')}
        ${td('לקוח', esc(r.customer))}
        ${td('תאריך', fmtDate(r.date, false), 'small nowrap')}
        ${td('סטטוס', statusChip(ORDER_STATUS, r.status))}
        ${cols.map((s) => td(s, r.sizes[s] || '<span class="faint">·</span>', 'num')).join('')}
        ${td('סה״כ', fmtNum(r.total), 'num bold')}
      </tr>`).join('')}
      </tbody></table>
    </div>`;

  $('orderPanelBody').onchange = null;
  $('orderPanelFoot').innerHTML = `
    <button class="btn" data-export-model="${esc(model)}">⬇️ ייצוא הפירוט לאקסל</button>`;
  $('orderOverlay').classList.add('active');
}

function renderDemand() {
  // מילוי אפשרויות הסינון המקומי
  if (!$('dmCollection').options.length) {
    $('dmCollection').innerHTML = '<option value="">כל הקולקציות</option>' +
      db.collections.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
    $('dmStatus').innerHTML = '<option value="">כל הסטטוסים</option>' +
      Object.entries(ORDER_STATUS).map(([k, s]) => `<option value="${k}">${esc(s.label)}</option>`).join('');
  }

  const rows = demandMatrix();
  if (!rows.length) {
    $('demandTable').innerHTML = '<div class="empty"><div class="ico">🎯</div>אין נתונים לסינון הנוכחי</div>';
    return;
  }
  const cols = usedSizes(rows);
  const totals = Object.fromEntries(cols.map((s) => [s, rows.reduce((a, r) => a + (r.sizes[s] || 0), 0)]));
  const grand = rows.reduce((a, r) => a + r.total, 0);

  $('demandTable').innerHTML = `<div class="table-wrap"><table><thead><tr>
      <th></th><th>דגם</th><th>קולקציה</th>
      ${cols.map((s) => `<th class="num">${esc(s)}</th>`).join('')}
      <th class="num">סה״כ</th><th class="num">לקוחות</th><th class="num">שווי</th><th></th>
    </tr></thead><tbody>
    ${rows.map((r) => `<tr class="clickable" data-dm="${esc(r.model)}">
      <td>${r.image ? `<img class="thumb" style="width:32px;height:32px" src="${esc(img(r.image, 80))}" alt="" loading="lazy" decoding="async">` : ''}</td>
      <td class="bold">${esc(r.model)}</td>
      <td class="muted small">${esc(r.collection)}</td>
      ${cols.map((s) => `<td class="num">${r.sizes[s] || '<span class="faint">·</span>'}</td>`).join('')}
      <td class="num bold">${fmtNum(r.total)}</td>
      <td class="num">${r.orders.size}</td>
      <td class="num">${r.amount > 0 ? fmtMoney(r.amount) : '—'}</td>
      <td class="num"><span class="faint">👁️</span></td>
    </tr>`).join('')}
    </tbody><tfoot><tr>
      <td colspan="3">סה״כ ${rows.length} דגמים</td>
      ${cols.map((s) => `<td class="num">${fmtNum(totals[s])}</td>`).join('')}
      <td class="num">${fmtNum(grand)}</td><td></td>
      <td class="num">${fmtMoney(rows.reduce((a, r) => a + r.amount, 0))}</td><td></td>
    </tr></tfoot></table></div>`;

  $('demandTable').onclick = (e) => {
    const row = e.target.closest('[data-dm]');
    if (row) openDemandDetail(row.dataset.dm);
  };
}

// ============================================================
// רווחיות
// ============================================================
function renderProfit() {
  const noCost = db.products.filter((p) => p.is_active && p.cost_price <= 0).length;
  const warn = $('costWarn');
  if (noCost) {
    warn.innerHTML = `⚠️ ל-<b>${noCost}</b> דגמים פעילים אין מחיר עלות, ולכן הרווח שלהם מוצג
      כמחזור מלא. עדכן מחירי עלות בלשונית <b>📦 מלאי</b> — אפשר גם לכמה דגמים בבת אחת.`;
    warn.style.display = 'block';
  } else {
    warn.style.display = 'none';
  }

  // ── תאריך תחילת החישוב ──
  const from     = profitStart();
  const excluded = filteredItems().length - profitItems().length;
  $('profitStart').value = db.settings.profit_start_date || '';
  $('profitStartHint').innerHTML = from
    ? `נספרות הזמנות מ-<b>${fmtDate(from, false)}</b> ואילך.
       ${excluded > 0 ? `<b>${fmtNum(excluded)}</b> שורות היסטוריות מוחרגות מהחישוב.` : ''}`
    : 'כרגע נספרת <b>כל</b> ההיסטוריה, כולל ההזמנות שיובאו מהגיליון הישן.';

  const items   = profitItems();
  const revenue = items.reduce((a, i) => a + lineNet(i), 0);
  const gross   = items.reduce((a, i) => a + lineGross(i), 0);
  const cost    = items.reduce((a, i) => a + lineCost(i), 0);
  const profit  = revenue - cost;
  const margin  = revenue > 0 ? (profit / revenue * 100) : 0;
  const units   = items.reduce((a, i) => a + i.qty, 0);
  const discounts = gross - revenue;

  $('profitKpis').innerHTML = [
    ['מחזור', fmtMoney(revenue), discounts > 0 ? `אחרי ${fmtMoney(discounts)} הנחות` : 'לפי סיטונאי', 'accent'],
    ['עלות',  fmtMoney(cost),    noCost ? 'חלקי' : 'מלא', 'warn'],
    ['רווח',  fmtMoney(profit),  `${margin.toFixed(1)}% מרווח`, profit > 0 ? 'green' : 'red'],
    ['יחידות', fmtNum(units),    `${fmtNum(items.length)} שורות`, 'accent'],
  ].map(([l, v, f, c]) => `<div class="kpi ${c}">
      <div class="label">${esc(l)}</div>
      <div class="value ${String(v).length > 8 ? 'sm' : ''}">${esc(v)}</div>
      <div class="foot">${esc(f)}</div></div>`).join('');

  // ── חודשי ──
  const byMonth = new Map();
  for (const it of items) {
    const d = new Date(it.order.created_at);
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const e = byMonth.get(k) || { month: k, revenue: 0, cost: 0, units: 0, orders: new Set() };
    e.revenue += lineNet(it);
    e.cost    += lineCost(it);
    e.units   += it.qty;
    e.orders.add(it.order.id);
    byMonth.set(k, e);
  }
  const months = [...byMonth.values()].sort((a, b) => b.month.localeCompare(a.month));
  const maxRev = Math.max(...months.map((m) => m.revenue), 1);

  const monthName = (k) => {
    const [y, m] = k.split('-');
    return new Date(+y, +m - 1, 1).toLocaleDateString('he-IL', { month: 'long', year: 'numeric' });
  };

  $('profitMonthly').innerHTML = months.length
    ? `<div class="table-wrap"><table class="responsive"><thead><tr>
        <th>חודש</th><th class="num">הזמנות</th><th class="num">יח׳</th>
        <th class="num">מחזור</th><th class="num">עלות</th><th class="num">רווח</th><th class="num">מרווח</th>
        <th style="min-width:110px"></th></tr></thead><tbody>
      ${months.map((m) => {
        const pr = m.revenue - m.cost;
        const mg = m.revenue > 0 ? (pr / m.revenue * 100) : 0;
        return `<tr>
          ${td('חודש', esc(monthName(m.month)), 'bold nowrap')}
          ${td('הזמנות', m.orders.size, 'num')}
          ${td('יחידות', fmtNum(m.units), 'num')}
          ${td('מחזור', fmtMoney(m.revenue), 'num')}
          ${td('עלות', fmtMoney(m.cost), 'num')}
          ${td('רווח', `<b style="color:${pr >= 0 ? 'var(--success)' : 'var(--danger)'}">${fmtMoney(pr)}</b>`, 'num')}
          ${td('מרווח', mg.toFixed(1) + '%', 'num')}
          ${td('', `<div class="bar-track"><div class="bar-fill green" style="width:${(m.revenue / maxRev * 100).toFixed(1)}%"></div></div>`)}
        </tr>`;
      }).join('')}
      </tbody></table></div>`
    : '<div class="empty">אין נתונים לסינון הנוכחי</div>';

  // ── לפי דגם ──
  const rows = demandMatrix(items).slice().sort((a, b) => b.profit - a.profit);
  $('profitByModel').innerHTML = rows.length
    ? `<div class="table-wrap"><table class="responsive"><thead><tr>
        <th>דגם</th><th class="num">יח׳</th><th class="num">עלות ליח׳</th>
        <th class="num">סיטונאי</th><th class="num">מחזור</th><th class="num">רווח</th></tr></thead><tbody>
      ${rows.slice(0, 60).map((r) => `<tr>
        ${td('דגם', esc(r.model), 'bold')}
        ${td('יחידות', fmtNum(r.total), 'num')}
        ${td('עלות ליח׳', r.cost > 0 ? fmtMoney(r.cost) : '<span class="chip amber">חסר</span>', 'num')}
        ${td('סיטונאי', fmtMoney(r.wholesale), 'num')}
        ${td('מחזור', fmtMoney(r.amount), 'num')}
        ${td('רווח', `<b style="color:${r.profit >= 0 ? 'var(--success)' : 'var(--danger)'}">${fmtMoney(r.profit)}</b>`, 'num')}
      </tr>`).join('')}
      </tbody></table></div>`
    : '<div class="empty">אין נתונים</div>';
}

// ============================================================
// מלאי
// ============================================================
function stockProducts() {
  const q = $('stockSearch').value.trim().toLowerCase();
  const col = $('stockCollection').value;
  return db.products.filter((p) => {
    if (col && p.collection_id !== col) return false;
    if (!q) return true;
    return p.model.toLowerCase().includes(q) || (p.description || '').toLowerCase().includes(q);
  });
}

function renderStock() {
  const items = stockProducts();
  const box = $('stockList');
  $('sortHint').style.display = stockSortMode ? 'block' : 'none';

  if (!items.length) {
    box.innerHTML = '<div class="empty"><div class="ico">📦</div>אין דגמים תואמים</div>';
    updateBulkBar();
    return;
  }

  if (stockSortMode) {
    updateBulkBar();
    box.className = 'sortable';
    box.innerHTML = items.map((p) => `
      <div class="sort-row" data-id="${p.id}" draggable="true">
        <span class="drag-handle">⠿</span>
        ${p.image_url
          ? `<img class="thumb" src="${esc(img(p.image_url, 80))}" alt="" loading="lazy" decoding="async">`
          : '<div class="thumb img-ph">📷</div>'}
        <div class="grow">
          <div class="bold">דגם ${esc(p.model)}</div>
          <div class="small muted">${esc(p.collections?.name || '')} · ${fmtNum(p.total)} יח׳</div>
        </div>
        ${p.is_active ? '' : '<span class="chip gray">מוסתר</span>'}
      </div>`).join('');

    makeSortable(box, async (ids) => {
      try {
        const { error } = await sb.rpc('reorder_products', { p_ids: ids });
        if (error) throw error;
        ids.forEach((id, i) => {
          const p = db.products.find((x) => x.id === id);
          if (p) p.sort_order = i + 1;
        });
        db.products.sort((a, b) => a.sort_order - b.sort_order);
        toast('הסדר נשמר');
      } catch (err) {
        toast(friendlyError(err), true);
        renderStock();
      }
    });
    return;
  }

  box.className = '';
  const allPicked = items.length > 0 && items.every((p) => picked.has(p.id));
  box.innerHTML = `<div class="table-wrap"><table class="responsive"><thead><tr>
    <th class="pick"><input type="checkbox" id="pickAll" ${allPicked ? 'checked' : ''}
      aria-label="בחירת כל הדגמים המוצגים"></th>
    <th></th><th>דגם</th><th>קולקציה</th>
    ${SIZES.map((s) => `<th class="num">${s}</th>`).join('')}
    <th class="num">סה״כ</th><th class="num">עלות</th><th class="num">סיטונאי</th><th class="num">קמעונאי</th>
    <th>מוצג</th><th></th></tr></thead><tbody>
    ${items.map((p) => `<tr data-product="${p.id}">
      ${td('בחירה', `<input type="checkbox" data-pick="${p.id}" ${picked.has(p.id) ? 'checked' : ''}
             aria-label="בחירת דגם ${esc(p.model)}">`, 'pick')}
      ${td('', p.image_url
        ? `<img class="thumb" src="${esc(img(p.image_url, 80))}" alt="" loading="lazy" decoding="async">`
        : '<div class="thumb img-ph">📷</div>')}
      ${td('דגם', esc(p.model), 'bold')}
      ${td('קולקציה', esc(p.collections?.name || ''), 'muted small')}
      ${SIZES.map((s) => td(s,
        `<input type="number" min="0" value="${p.stock[s] ?? ''}" placeholder="—"
           data-stock="${p.id}|${s}" aria-label="דגם ${esc(p.model)} מידה ${s}"
           style="width:60px;text-align:center;font-weight:700;min-height:40px">`, 'num')).join('')}
      ${td('סה״כ', fmtNum(p.total), 'num bold')}
      ${td('עלות', p.cost_price > 0 ? fmtMoney(p.cost_price) : '<span class="chip amber">חסר</span>', 'num')}
      ${td('סיטונאי', p.wholesale_price > 0 ? fmtMoney(p.wholesale_price) : '—', 'num')}
      ${td('קמעונאי', p.retail_price > 0 ? fmtMoney(p.retail_price) : '—', 'num')}
      ${td('מוצג', `<input type="checkbox" ${p.is_active ? 'checked' : ''} data-active="${p.id}"
             aria-label="הצג דגם ${esc(p.model)}">`)}
      ${td('', `<button class="btn ghost sm" data-edit="${p.id}">✏️ עריכה</button>`)}
    </tr>`).join('')}
    </tbody></table></div>`;

  box.onchange = async (e) => {
    const pk = e.target.closest('[data-pick]');
    if (pk) {
      if (pk.checked) picked.add(pk.dataset.pick); else picked.delete(pk.dataset.pick);
      updateBulkBar();
      return;
    }
    if (e.target.id === 'pickAll') {
      for (const p of items) {
        if (e.target.checked) picked.add(p.id); else picked.delete(p.id);
      }
      renderStock();
      return;
    }
    const st = e.target.closest('[data-stock]');
    if (st) { await saveStock(st); return; }
    const ac = e.target.closest('[data-active]');
    if (ac) await saveActive(ac);
  };
  box.onclick = (e) => {
    const ed = e.target.closest('[data-edit]');
    if (ed) editProduct(ed.dataset.edit);
  };

  updateBulkBar();
}

// ── עדכון מחירים לבחירה מרובה ───────────────────────────────
// לעבור דגם-דגם כדי להזין עלות זו עבודה סיזיפית; פה מסמנים
// כמה שרוצים ומעדכנים במכה אחת.
function updateBulkBar() {
  const bar = $('bulkBar');
  if (!bar) return;
  bar.classList.toggle('on', picked.size > 0 && !stockSortMode);
  $('bulkCount').textContent = `${fmtNum(picked.size)} דגמים נבחרו`;
}

function bulkPrices() {
  const ids = [...picked];
  if (!ids.length) { toast('לא נבחרו דגמים', true); return; }
  const chosen = db.products.filter((p) => picked.has(p.id));

  modal(`💲 מחירים ל-${ids.length} דגמים`, `
    <div class="note small">
      שדה שנשאר <b>ריק</b> לא ישתנה. כך אפשר לעדכן רק עלות בלי לגעת
      במחירי המכירה.
    </div>
    <div class="lines-wrap" style="margin-bottom:.9rem">
      ${chosen.slice(0, 40).map((p) => `<span class="tag">${esc(p.model)}</span>`).join('')}
      ${chosen.length > 40 ? `<span class="tag">ועוד ${chosen.length - 40}…</span>` : ''}
    </div>
    <div class="grid-3">
      <div class="field"><label>עלות (₪)</label>
        <input type="number" id="bkCost" min="0" step="0.01" inputmode="decimal" placeholder="ללא שינוי"></div>
      <div class="field"><label>סיטונאי (₪)</label>
        <input type="number" id="bkWholesale" min="0" step="0.01" inputmode="decimal" placeholder="ללא שינוי"></div>
      <div class="field"><label>לקוח קצה (₪)</label>
        <input type="number" id="bkRetail" min="0" step="0.01" inputmode="decimal" placeholder="ללא שינוי"></div>
    </div>
    <div class="err-msg" id="bkError"></div>
    <button class="btn block lg" id="bkSave">עדכון ${ids.length} דגמים</button>
  `);

  on('bkSave', 'click', async () => {
    const num = (id) => {
      const v = $(id).value.trim();
      return v === '' ? null : Number(v);
    };
    const cost = num('bkCost'), whole = num('bkWholesale'), retail = num('bkRetail');
    const err = $('bkError');
    err.classList.remove('show');

    if (cost === null && whole === null && retail === null) {
      err.textContent = 'לא הוזן אף מחיר'; err.classList.add('show'); return;
    }
    if ([cost, whole, retail].some((v) => v !== null && (!Number.isFinite(v) || v < 0))) {
      err.textContent = 'מחיר לא תקין'; err.classList.add('show'); return;
    }

    $('bkSave').disabled = true;
    try {
      const { data, error } = await sb.rpc('set_products_prices', {
        p_ids: ids, p_cost: cost, p_wholesale: whole, p_retail: retail,
      });
      if (error) throw error;
      toast(`${fmtNum(data?.updated ?? 0)} דגמים עודכנו`);
      picked.clear();
      closeModal();
      await loadAll();
    } catch (e2) {
      err.textContent = friendlyError(e2);
      err.classList.add('show');
      $('bkSave').disabled = false;
    }
  });
}

async function saveStock(inp) {
  const [pid, size] = inp.dataset.stock.split('|');
  const qty = parseInt(inp.value, 10);
  if (!Number.isFinite(qty) || qty < 0) { toast('כמות לא תקינה', true); renderStock(); return; }

  inp.disabled = true;
  try {
    const { error } = await sb.rpc('set_stock', { p_product_id: pid, p_size: size, p_qty: qty });
    if (error) throw error;
    const p = db.products.find((x) => x.id === pid);
    if (p) {
      p.stock[size] = qty;
      p.total = Object.values(p.stock).reduce((a, b) => a + b, 0);
    }
    toast(`דגם ${p?.model} ${size} → ${qty}`);
  } catch (err) {
    toast(friendlyError(err), true);
    renderStock();
  } finally {
    inp.disabled = false;
  }
}

async function saveActive(cb) {
  const id = cb.dataset.active;
  try {
    const { error } = await sb.from('products').update({ is_active: cb.checked }).eq('id', id);
    if (error) throw error;
    const p = db.products.find((x) => x.id === id);
    if (p) p.is_active = cb.checked;
    toast(cb.checked ? 'הדגם מוצג בקטלוג' : 'הדגם הוסתר');
  } catch (err) {
    toast(friendlyError(err), true);
    cb.checked = !cb.checked;
  }
}

function editProduct(id) {
  const p = id ? db.products.find((x) => x.id === id) : null;

  modal(p ? `עריכת דגם ${p.model}` : 'דגם חדש', `
    <div class="field"><label>מספר דגם <span class="req">*</span></label>
      <input type="text" id="pModel" value="${esc(p?.model || '')}"></div>
    <div class="field"><label>קולקציה <span class="req">*</span></label>
      <select id="pCollection">${db.collections.map((c) =>
        `<option value="${c.id}" ${p?.collection_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
    <div class="field"><label>תיאור קצר</label>
      <textarea id="pDesc" rows="2" placeholder="חומר, גזרה, פרטים…">${esc(p?.description || '')}</textarea></div>
    <div class="field"><label>קישור לתמונה</label>
      <input type="text" id="pImage" value="${esc(p?.image_url || '')}" placeholder="https://res.cloudinary.com/…"></div>
    <div id="pPreview" style="margin-bottom:.9rem"></div>

    <div class="note small">
      <b>עלות</b> — כמה הדגם עולה לך. משמש לחישוב הרווח.<br>
      <b>סיטונאי</b> — מה הלקוח משלם. זה הסכום בהזמנות.<br>
      <b>לקוח קצה</b> — המחיר שמסונכרן לשופיפיי.
    </div>
    <div class="grid-3">
      <div class="field"><label>עלות (₪)</label>
        <input type="number" id="pCost" min="0" step="0.01" inputmode="decimal" value="${p?.cost_price ?? 0}"></div>
      <div class="field"><label>סיטונאי (₪)</label>
        <input type="number" id="pWholesale" min="0" step="0.01" inputmode="decimal" value="${p?.wholesale_price ?? 0}"></div>
      <div class="field"><label>לקוח קצה (₪)</label>
        <input type="number" id="pRetail" min="0" step="0.01" inputmode="decimal" value="${p?.retail_price ?? 0}"></div>
    </div>
    <div class="note small" id="pMargin"></div>

    <div class="field"><label>מוצג בקטלוג</label>
      <select id="pActive">
        <option value="1" ${p?.is_active !== false ? 'selected' : ''}>כן</option>
        <option value="0" ${p?.is_active === false ? 'selected' : ''}>לא</option>
      </select></div>
    <button class="btn block lg" id="pSave">שמירה</button>
  `);

  const preview = () => {
    if (!$('pImage') || !$('pPreview')) return;
    const u = $('pImage').value.trim();
    $('pPreview').innerHTML = u
      ? `<img src="${esc(img(u, 240))}" alt="" style="max-height:150px;border-radius:10px;border:1px solid var(--border)">`
      : '';
  };
  const showMargin = () => {
    if (!$('pMargin')) return;
    const c = Number($('pCost').value) || 0;
    const w = Number($('pWholesale').value) || 0;
    const pr = w - c;
    const mg = w > 0 ? (pr / w * 100) : 0;
    $('pMargin').innerHTML = w > 0
      ? `רווח ליחידה: <b>${fmtMoney(pr)}</b> · מרווח <b>${mg.toFixed(1)}%</b>`
      : 'הזן מחיר סיטונאי כדי לראות את הרווח';
  };
  preview(); showMargin();
  on('pImage', 'input', debounce(preview, 400));
  ['pCost', 'pWholesale'].forEach((f) => on(f, 'input', showMargin));

  on('pSave', 'click', async () => {
    const model = $('pModel').value.trim();
    if (!model) { toast('חסר מספר דגם', true); return; }

    const rec = {
      model,
      collection_id: $('pCollection').value,
      description: $('pDesc').value.trim() || null,
      image_url:   $('pImage').value.trim() || null,
      cost_price:      Number($('pCost').value) || 0,
      wholesale_price: Number($('pWholesale').value) || 0,
      retail_price:    Number($('pRetail').value) || 0,
      is_active:   $('pActive').value === '1',
    };

    $('pSave').disabled = true;
    try {
      const { error } = p
        ? await sb.from('products').update(rec).eq('id', p.id)
        : await sb.from('products').insert(rec);
      if (error) throw error;
      toast(p ? 'הדגם עודכן' : 'הדגם נוסף');
      closeModal();
      await loadAll();
    } catch (err) {
      toast(friendlyError(err), true);
      $('pSave').disabled = false;
    }
  });
}

// ============================================================
// חזרות
//
// הזרימה: המנהל קולט את החזרה → הפריטים התקינים נכנסים למלאי
// באותו רגע → החזרה ממתינה לזיכוי → "בוצע זיכוי" מעביר לארכיון.
// פריט פגום לא נכנס למלאי בכלל, ולכן מותר לו להיות בלי מספר דגם —
// מספיקה תמונה מהמצלמה.
// ============================================================
const returnItemsOf = (id) => db.returnItems.filter((i) => i.return_id === id);

function renderReturns() {
  const buckets = { pending: [], credited: [] };
  for (const r of db.returns) (buckets[r.status] || (buckets[r.status] = [])).push(r);

  $('returnTabs').innerHTML = ['pending', 'credited'].map((k) => {
    const s = RETURN_STATUS[k];
    return `<button class="tab ${k === returnStatusTab ? 'active' : ''}" data-rt="${k}">
      ${s.icon} ${esc(s.short)} <span class="tab-count">${(buckets[k] || []).length}</span></button>`;
  }).join('');

  $('returnTabs').onclick = (e) => {
    const b = e.target.closest('[data-rt]');
    if (!b) return;
    returnStatusTab = b.dataset.rt;
    renderReturns();
  };

  const rows = buckets[returnStatusTab] || [];
  if (!rows.length) {
    $('returnsTable').innerHTML = `<div class="empty"><div class="ico">🔄</div>
      ${returnStatusTab === 'pending' ? 'אין חזרות שממתינות לזיכוי 👍' : 'ארכיון החזרות ריק'}</div>`;
    return;
  }

  $('returnsTable').innerHTML = `<div class="table-wrap"><table class="responsive"><thead><tr>
    <th>#</th><th>מחזיר</th><th>תאריך</th><th class="num">יח׳</th>
    <th class="num">פגומים</th><th>סטטוס</th><th></th></tr></thead><tbody>
    ${rows.map((r) => `<tr class="clickable" data-return="${r.id}">
      ${td('חזרה', '#' + r.return_number, 'bold')}
      ${td('מחזיר', esc(r.returner_name || r.customer_name || '—'))}
      ${td('תאריך', fmtDate(r.return_date, false), 'small nowrap')}
      ${td('יחידות', fmtNum(r.total_units), 'num')}
      ${td('פגומים', r.damaged_units > 0 ? `<span class="chip amber">${r.damaged_units}</span>` : '—', 'num')}
      ${td('סטטוס', statusChip(RETURN_STATUS, r.status))}
      ${td('', r.status === 'pending'
        ? `<button class="btn success sm" data-credit="${r.id}">✅ בוצע זיכוי</button>
           <button class="btn danger sm" data-del-return="${r.id}">🗑️</button>`
        : `<button class="btn ghost sm" data-del-return="${r.id}">🗑️</button>`, 'nowrap')}
    </tr>`).join('')}
    </tbody></table></div>`;

  $('returnsTable').onclick = async (e) => {
    const cr = e.target.closest('[data-credit]');
    if (cr) { e.stopPropagation(); await creditReturn(cr.dataset.credit); return; }
    const dl = e.target.closest('[data-del-return]');
    if (dl) { e.stopPropagation(); await removeReturn(dl.dataset.delReturn); return; }
    const row = e.target.closest('[data-return]');
    if (row) openReturn(row.dataset.return);
  };
}

function openReturn(id) {
  const r = db.returns.find((x) => x.id === id);
  if (!r) return;
  const items = returnItemsOf(id);

  $('orderPanelTitle').textContent = `חזרה #${r.return_number}`;
  $('orderPanelBody').onchange = null;
  $('orderPanelBody').innerHTML = `
    <div class="row" style="margin-bottom:.9rem">
      ${statusChip(RETURN_STATUS, r.status)}
      <span class="muted small">${fmtDate(r.return_date, false)}</span>
    </div>

    <div class="card" style="padding:.8rem;margin-bottom:.9rem">
      <div class="grid-2 small">
        <div><span class="muted">מחזיר:</span> <b>${esc(r.returner_name || '—')}</b></div>
        <div><span class="muted">כרטיס לקוח:</span> ${esc(r.customer_name || '—')}</div>
        <div><span class="muted">יחידות:</span> <b>${fmtNum(r.total_units)}</b></div>
        <div><span class="muted">מהן פגומות:</span> <b>${fmtNum(r.damaged_units)}</b></div>
        <div><span class="muted">נקלטה:</span> ${fmtDate(r.created_at)}</div>
        <div><span class="muted">זוכתה:</span> ${r.credited_at ? fmtDate(r.credited_at) : '—'}</div>
      </div>
      ${r.notes ? `<div class="small" style="margin-top:.5rem"><span class="muted">הערה:</span> ${esc(r.notes)}</div>` : ''}
    </div>

    <h4 class="bold" style="margin-bottom:.5rem">פריטים (${items.length})</h4>
    <div class="note small">פריטים תקינים כבר נוספו למלאי בזמן הקליטה. פגומים לא נכנסו.</div>
    <div class="table-wrap">
      <table class="responsive"><thead><tr>
        <th></th><th>דגם</th><th>מידה</th><th class="num">כמות</th><th>מצב</th><th>הערה</th>
      </tr></thead><tbody>
      ${items.map((i) => `<tr>
        ${td('', i.photo_url
          ? `<img class="ret-preview" src="${esc(i.photo_url)}" alt="תמונת הפריט" data-zoom-img="${esc(i.photo_url)}" loading="lazy">`
          : '<span class="faint">—</span>')}
        ${td('דגם', esc(i.model || '—'), 'bold')}
        ${td('מידה', esc(i.size || '—'))}
        ${td('כמות', fmtNum(i.qty), 'num')}
        ${td('מצב', i.is_defective
          ? '<span class="chip amber">פגום</span>'
          : '<span class="chip green">נכנס למלאי</span>')}
        ${td('הערה', esc(i.notes || '—'), 'small muted')}
      </tr>`).join('')}
      </tbody></table>
    </div>`;

  $('orderPanelFoot').innerHTML = `
    <div class="row">
      ${r.status === 'pending'
        ? `<button class="btn success" data-credit-panel="${r.id}">✅ בוצע זיכוי</button>` : ''}
      <span class="grow"></span>
      <button class="btn danger sm" data-del-return-panel="${r.id}">🗑️ מחיקת החזרה</button>
    </div>`;

  $('orderOverlay').classList.add('active');
}

async function creditReturn(id) {
  const r = db.returns.find((x) => x.id === id);
  if (!confirm(`לסמן את חזרה #${r?.return_number} כ"בוצע זיכוי"?\n\nהיא תעבור לארכיון החזרות.`)) return;
  try {
    const { error } = await sb.rpc('credit_return', { p_return_id: id });
    if (error) throw error;
    toast('הזיכוי נרשם — החזרה עברה לארכיון');
    $('orderOverlay').classList.remove('active');
    await loadAll();
  } catch (err) { toast(friendlyError(err), true); }
}

async function removeReturn(id) {
  const r = db.returns.find((x) => x.id === id);
  const back = returnItemsOf(id).filter((i) => !i.is_defective).reduce((a, i) => a + i.qty, 0);
  if (!confirm(`למחוק את חזרה #${r?.return_number}?\n\n`
    + (back ? `${fmtNum(back)} יחידות שנוספו למלאי יוסרו ממנו חזרה.\n` : '')
    + 'הפעולה אינה הפיכה.')) return;
  try {
    const { error } = await sb.rpc('delete_return', { p_return_id: id });
    if (error) throw error;
    toast('החזרה נמחקה');
    $('orderOverlay').classList.remove('active');
    await loadAll();
  } catch (err) { toast(friendlyError(err), true); }
}

// ── טופס קליטת חזרה ─────────────────────────────────────────
// כל שורה מחזיקה photo כ-File דחוס עד השמירה; ההעלאה ל-Storage
// קורית פעם אחת, בשמירה, כדי שביטול הטופס לא ישאיר קבצים יתומים.
let retLines = [];
let retSeq = 0;

// blob URL לכל תצוגה מקדימה נוצר פעם אחת ומשוחרר בהחלפה או בהסרה.
// בלי זה כל רינדור מחדש של הטופס היה מדליף עוד עותק של התמונה.
function setLinePhoto(line, file) {
  if (line.previewUrl) URL.revokeObjectURL(line.previewUrl);
  line.photo = file || null;
  line.previewUrl = file ? URL.createObjectURL(file) : null;
}

function clearRetLines() {
  for (const l of retLines) if (l.previewUrl) URL.revokeObjectURL(l.previewUrl);
  retLines = [];
}

function newReturn() {
  clearRetLines();
  retSeq = 0;

  modal('🔄 קליטת חזרה', `
    <div class="grid-2">
      <div class="field"><label for="rtName">שם המחזיר <span class="req">*</span></label>
        <input type="text" id="rtName" list="rtCustomers" autocomplete="off" placeholder="שם הלקוח או החנות">
        <datalist id="rtCustomers">
          ${db.customers.map((c) => `<option value="${esc(c.business_name || c.name)}">`).join('')}
        </datalist>
        <div class="hint">אם השם תואם לקוח קיים — החזרה תשויך לכרטיס שלו אוטומטית</div>
      </div>
      <div class="field"><label for="rtDate">תאריך <span class="req">*</span></label>
        <input type="date" id="rtDate" value="${todayISO()}"></div>
    </div>

    <div class="field"><label for="rtNotes">הערה (אופציונלי)</label>
      <input type="text" id="rtNotes" placeholder="לדוגמה: הוחזר עם השליח"></div>

    <h4 class="bold" style="margin:.4rem 0 .5rem">פריטים</h4>
    <div class="note small">
      הקלד מספר דגם — תיפתח רשימה של הדגמים הקיימים. הפריטים ייכנסו
      למלאי הכללי ויתווספו לדגם הקיים. פריט שמסומן <b>פגום</b> לא נכנס למלאי,
      ואז אפשר להסתפק בתמונה מהמצלמה במקום מספר דגם.
    </div>
    <div id="rtLines"></div>
    <button class="btn ghost sm" id="rtAdd" style="margin-bottom:1rem">➕ עוד פריט</button>

    <datalist id="rtModels">
      ${db.products.map((p) => `<option value="${esc(p.model)}">${esc(p.collections?.name || '')}</option>`).join('')}
    </datalist>

    <div class="err-msg" id="rtError"></div>
    <div class="row" style="justify-content:space-between">
      <span class="small muted" id="rtSummary"></span>
      <button class="btn lg" id="rtSave">קליטת החזרה</button>
    </div>
  `);

  addRetLine();
  on('rtAdd', 'click', () => addRetLine());
  on('rtSave', 'click', saveReturn);
}

function addRetLine() {
  retLines.push({
    key: ++retSeq, model: '', size: '', qty: 1,
    defective: false, photo: null, previewUrl: null, notes: '',
  });
  renderRetLines();
}

function updateRetSummary() {
  const el = $('rtSummary');
  if (!el) return;
  const units = retLines.reduce((a, l) => a + (Number(l.qty) || 0), 0);
  const bad   = retLines.filter((l) => l.defective).reduce((a, l) => a + (Number(l.qty) || 0), 0);
  el.textContent = `${fmtNum(units)} יחידות · ${fmtNum(units - bad)} למלאי · ${fmtNum(bad)} פגומות`;
}

function renderRetLines() {
  const box = $('rtLines');
  if (!box) return;

  box.innerHTML = retLines.map((l) => `
    <div class="ret-line ${l.defective ? 'defective' : ''}" data-key="${l.key}">
      <div class="ret-top">
        <div class="grow">
          <div class="ret-grid">
            <div class="field">
              <label>דגם ${l.defective ? '' : '<span class="req">*</span>'}</label>
              <input type="text" list="rtModels" data-f="model" value="${esc(l.model)}"
                     autocomplete="off" inputmode="text" placeholder="מספר דגם…">
            </div>
            <div class="field"><label>מידה ${l.defective ? '' : '<span class="req">*</span>'}</label>
              <select data-f="size">
                <option value="">—</option>
                ${SIZES.map((s) => `<option value="${s}" ${l.size === s ? 'selected' : ''}>${s}</option>`).join('')}
              </select>
            </div>
            <div class="field"><label>כמות</label>
              <input type="number" data-f="qty" min="1" value="${l.qty}" inputmode="numeric"
                     style="text-align:center;font-weight:800">
            </div>
          </div>
        </div>
        ${retLines.length > 1
          ? `<button class="btn ghost sm" data-rm-line="${l.key}" aria-label="הסרת השורה" style="margin-top:1.4rem">🗑️</button>`
          : ''}
      </div>

      <div class="ret-flags">
        <label><input type="checkbox" data-f="defective" ${l.defective ? 'checked' : ''}> ⚠️ פגום — לא נכנס למלאי</label>
      </div>

      ${l.defective ? `
        <div class="field" style="margin-top:.5rem">
          <input type="text" data-f="notes" value="${esc(l.notes)}" placeholder="מה הפגם? (אופציונלי)">
        </div>
        <div class="photo-slot">
          ${l.photo
            ? `<img src="${esc(l.previewUrl)}" alt="תצוגה מקדימה">
               <button class="btn ghost sm" data-rm-photo="${l.key}">הסרת התמונה</button>
               <span class="small muted">${Math.round(l.photo.size / 1024)}KB</span>`
            : `<label class="cam-btn">📷 צילום הפריט
                 <input type="file" accept="image/*" capture="environment" data-f="photo">
               </label>
               <span class="small muted">נדחס אוטומטית לפני ההעלאה</span>`}
        </div>` : ''}
    </div>`).join('');

  updateRetSummary();

  // רק שדות טקסט. תיבת "פגום" ובוחר הקובץ יורים גם input, ושם
  // f.value היה כותב את המחרוזת "on" לתוך הדגל הבוליאני.
  const TEXT_FIELDS = ['model', 'notes', 'qty'];

  box.oninput = (e) => {
    const f = e.target.closest('[data-f]');
    if (!f || !TEXT_FIELDS.includes(f.dataset.f)) return;
    const l = retLines.find((x) => x.key === Number(f.closest('[data-key]').dataset.key));
    if (!l) return;
    if (f.dataset.f === 'qty') l.qty = Math.max(1, parseInt(f.value, 10) || 1);
    else l[f.dataset.f] = f.value;
    updateRetSummary();
  };

  box.onchange = async (e) => {
    const key = Number(e.target.closest('[data-key]')?.dataset.key);
    const l = retLines.find((x) => x.key === key);
    if (!l) return;

    const cb = e.target.closest('[data-f="defective"]');
    if (cb) {
      l.defective = cb.checked;
      // דגם תקין חייב זיהוי; פגום יכול להסתפק בתמונה
      if (!l.defective) { setLinePhoto(l, null); l.notes = ''; }
      renderRetLines();
      return;
    }

    const file = e.target.closest('[data-f="photo"]');
    if (file?.files?.[0]) {
      const raw = file.files[0];
      toast('דוחס את התמונה…');
      let out = raw;
      try { out = await compressImage(raw, 1280, 0.72); } catch { out = raw; }
      setLinePhoto(l, out);
      renderRetLines();
      return;
    }

    const sel = e.target.closest('[data-f="size"]');
    if (sel) { l.size = sel.value; return; }
  };

  box.onclick = (e) => {
    const rm = e.target.closest('[data-rm-line]');
    if (rm) {
      const gone = retLines.find((x) => x.key === Number(rm.dataset.rmLine));
      if (gone?.previewUrl) URL.revokeObjectURL(gone.previewUrl);
      retLines = retLines.filter((x) => x.key !== Number(rm.dataset.rmLine));
      renderRetLines();
      return;
    }
    const rp = e.target.closest('[data-rm-photo]');
    if (rp) {
      const l = retLines.find((x) => x.key === Number(rp.dataset.rmPhoto));
      if (l) setLinePhoto(l, null);
      renderRetLines();
    }
  };
}

async function saveReturn() {
  const err  = $('rtError');
  const btn  = $('rtSave');
  const name = $('rtName').value.trim();
  const fail = (msg) => { err.textContent = msg; err.classList.add('show'); };

  err.classList.remove('show');
  if (!name) { fail('חסר שם המחזיר'); return; }

  const lines = retLines.filter((l) => Number(l.qty) > 0);
  if (!lines.length) { fail('לא הוזנו פריטים'); return; }

  const models = new Map(db.products.map((p) => [p.model.trim().toLowerCase(), p.model]));
  for (const l of lines) {
    const key = l.model.trim().toLowerCase();
    if (!l.defective) {
      if (!key)              { fail('פריט תקין חייב מספר דגם. סמן אותו כפגום או בחר דגם קיים'); return; }
      if (!models.has(key))  { fail(`דגם "${l.model}" לא קיים במלאי — בחר מהרשימה או סמן כפגום`); return; }
      if (!l.size)           { fail(`חסרה מידה לדגם ${l.model}`); return; }
    } else if (!key && !l.photo && !l.notes.trim()) {
      fail('פריט פגום צריך לפחות מספר דגם, תמונה או תיאור'); return;
    }
  }

  btn.disabled = true;
  btn.textContent = 'קולט…';

  const uploaded = [];
  try {
    // מעלים תמונות רק עכשיו — ביטול הטופס לא משאיר קבצים באחסון
    const items = [];
    for (const l of lines) {
      let photoUrl = null;
      if (l.photo) {
        const path = `${todayISO()}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`;
        const { error: upErr } = await sb.storage.from('return-photos')
          .upload(path, l.photo, { contentType: 'image/jpeg', upsert: false });
        if (upErr) throw upErr;
        uploaded.push(path);
        photoUrl = sb.storage.from('return-photos').getPublicUrl(path).data.publicUrl;
      }
      items.push({
        model: models.get(l.model.trim().toLowerCase()) || l.model.trim() || null,
        size: l.size || null,
        qty: Number(l.qty),
        is_defective: !!l.defective,
        photo_url: photoUrl,
        notes: l.notes.trim() || null,
      });
    }

    // שם שתואם לקוח קיים משייך את החזרה לכרטיס שלו
    const low = name.toLowerCase();
    const cust = db.customers.find((c) =>
      (c.business_name || '').toLowerCase() === low || c.name.toLowerCase() === low);

    const { data, error } = await sb.rpc('create_return', {
      p_returner_name: name,
      p_return_date: $('rtDate').value || todayISO(),
      p_customer_id: cust?.id || null,
      p_notes: $('rtNotes').value.trim() || null,
      p_items: items,
    });
    if (error) throw error;

    toast(`חזרה #${data.return_number} נקלטה · ${fmtNum(data.restocked)} למלאי · ${fmtNum(data.damaged)} פגומות`);
    closeModal();
    returnStatusTab = 'pending';
    await loadAll();
    if (activeTab !== 'returns') switchTab('returns');
  } catch (e2) {
    // ניקוי התמונות שכבר עלו, כדי שלא יישארו יתומות אחרי כישלון
    if (uploaded.length) await sb.storage.from('return-photos').remove(uploaded).catch(() => {});
    fail(friendlyError(e2));
    btn.disabled = false;
    btn.textContent = 'קליטת החזרה';
  }
}

// ============================================================
// קולקציות
// ============================================================
function renderCollections() {
  const box = $('collectionList');
  if (!db.collections.length) {
    box.innerHTML = '<div class="empty"><div class="ico">🗂️</div>אין קולקציות</div>';
    return;
  }

  box.innerHTML = db.collections.map((c) => {
    const ps = db.products.filter((p) => p.collection_id === c.id);
    return `<div class="sort-row" data-id="${c.id}" draggable="true">
      <span class="drag-handle">⠿</span>
      <span style="font-size:1.3rem">${esc(c.icon || '📦')}</span>
      <div class="grow">
        <div class="bold">${esc(c.name)}</div>
        <div class="small muted">${ps.length} דגמים · ${fmtNum(ps.reduce((a, p) => a + p.total, 0))} יח׳</div>
      </div>
      ${c.is_active ? '<span class="chip green">פעילה</span>' : '<span class="chip gray">מוסתרת</span>'}
      <button class="btn ghost sm" data-edit-col="${c.id}">✏️</button>
    </div>`;
  }).join('');

  makeSortable(box, async (ids) => {
    try {
      const { error } = await sb.rpc('reorder_collections', { p_ids: ids });
      if (error) throw error;
      ids.forEach((id, i) => {
        const c = db.collections.find((x) => x.id === id);
        if (c) c.sort_order = i + 1;
      });
      db.collections.sort((a, b) => a.sort_order - b.sort_order);
      toast('הסדר נשמר');
    } catch (err) {
      toast(friendlyError(err), true);
      renderCollections();
    }
  });

  box.onclick = (e) => {
    const b = e.target.closest('[data-edit-col]');
    if (b) editCollection(b.dataset.editCol);
  };
}

function editCollection(id) {
  const c = id ? db.collections.find((x) => x.id === id) : null;

  modal(c ? `עריכת ${c.name}` : 'קולקציה חדשה', `
    <div class="grid-2">
      <div class="field"><label>שם <span class="req">*</span></label>
        <input type="text" id="cName" value="${esc(c?.name || '')}" placeholder="קולקציית אביב 27"></div>
      <div class="field"><label>מזהה באנגלית <span class="req">*</span></label>
        <input type="text" id="cSlug" value="${esc(c?.slug || '')}" placeholder="spring27"></div>
    </div>
    <div class="grid-2">
      <div class="field"><label>אייקון</label>
        <input type="text" id="cIcon" value="${esc(c?.icon || '📦')}" maxlength="4"></div>
      <div class="field"><label>תגית שופיפיי</label>
        <input type="text" id="cTag" value="${esc(c?.shopify_tag || '')}" placeholder="spring-collection"></div>
    </div>
    <div class="field"><label>פעילה</label>
      <select id="cActive">
        <option value="1" ${c?.is_active !== false ? 'selected' : ''}>כן — מוצגת ללקוחות</option>
        <option value="0" ${c?.is_active === false ? 'selected' : ''}>לא</option>
      </select></div>
    <button class="btn block lg" id="cSave">שמירה</button>
  `);

  on('cSave', 'click', async () => {
    const name = $('cName').value.trim();
    const slug = $('cSlug').value.trim().toLowerCase();
    if (!name || !slug) { toast('חסר שם או מזהה', true); return; }

    const rec = {
      name, slug,
      icon: $('cIcon').value.trim() || '📦',
      shopify_tag: $('cTag').value.trim() || null,
      is_active: $('cActive').value === '1',
    };
    $('cSave').disabled = true;
    try {
      const { error } = c
        ? await sb.from('collections').update(rec).eq('id', c.id)
        : await sb.from('collections').insert({ ...rec, sort_order: db.collections.length });
      if (error) throw error;
      toast(c ? 'הקולקציה עודכנה' : 'הקולקציה נוספה');
      closeModal();
      await loadAll();
    } catch (err) {
      toast(friendlyError(err), true);
      $('cSave').disabled = false;
    }
  });
}

// ============================================================
// לקוחות
// ============================================================
function renderCustomers() {
  const q = $('customerSearch').value.trim().toLowerCase();
  const items = db.customers.filter((c) =>
    !q || c.name.toLowerCase().includes(q)
       || (c.business_name || '').toLowerCase().includes(q)
       || (c.duplicate_candidate_name || '').toLowerCase().includes(q)
       || (c.phone || '').includes(q))
    .sort((a, b) => Number(b.duplicate_status === 'pending') - Number(a.duplicate_status === 'pending')
      || a.name.localeCompare(b.name, 'he'));

  const pendingCount = db.customers.filter((c) => c.duplicate_status === 'pending').length;
  $('customersCount').textContent = pendingCount
    ? `(${fmtNum(items.length)} · ${fmtNum(pendingCount)} לבדיקה)`
    : `(${fmtNum(items.length)})`;

  if (!items.length) {
    $('customersTable').innerHTML = '<div class="empty"><div class="ico">👥</div>אין לקוחות תואמים</div>';
    return;
  }

  $('customersTable').innerHTML = `<div class="table-wrap"><table class="responsive"><thead><tr>
    <th>שם</th><th>עסק</th><th>טלפון</th><th class="num">הזמנות</th>
    <th class="num">יח׳</th><th class="num">מחזור</th><th class="num">חוב</th><th>אחרונה</th><th></th>
    </tr></thead><tbody>
    ${items.map((c) => `<tr class="clickable" data-customer="${c.id}">
      ${td('שם', esc(c.name), 'bold')}
      ${td('עסק', `${esc(c.business_name || '—')}${c.duplicate_status === 'pending'
        ? `<div class="chip amber" style="margin-top:.25rem">חשד לכפול של ${esc(c.duplicate_candidate_business || c.duplicate_candidate_name || 'לקוח קיים')}</div>`
        : c.duplicate_status === 'rejected'
          ? '<div class="chip green" style="margin-top:.25rem">נבדק — לא כפול</div>'
          : ''}`, 'muted small')}
      ${td('טלפון', c.phone ? `<a href="tel:${esc(c.phone)}">${esc(c.phone)}</a>` : '—', 'small nowrap')}
      ${td('הזמנות', fmtNum(c.orders_count), 'num')}
      ${td('יחידות', fmtNum(c.total_units), 'num')}
      ${td('מחזור', c.total_amount > 0 ? fmtMoney(c.total_amount) : '—', 'num')}
      ${td('חוב', c.open_balance > 0 ? `<span class="chip red">${fmtMoney(c.open_balance)}</span>` : '—', 'num')}
      ${td('אחרונה', c.last_order_at ? fmtDate(c.last_order_at, false) : '—', 'small nowrap')}
      ${td('', `${c.duplicate_status === 'pending' ? `
                <button class="btn success sm" data-approve-duplicate="${c.id}" title="אישור ואיחוד">✅</button>
                <button class="btn ghost sm" data-reject-duplicate="${c.id}" title="אינו כפול">✖️</button>` : ''}
                <button class="btn ghost sm" data-edit-cust="${c.id}" title="עריכת לקוח">✏️</button>
                <button class="btn ghost sm" data-merge-cust="${c.id}" title="איחוד לתוך לקוח אחר">🔗</button>
                <button class="btn danger sm" data-delete-cust="${c.id}" title="מחיקת לקוח">🗑️</button>`, 'nowrap')}
    </tr>`).join('')}
    </tbody></table></div>`;

  $('customersTable').onclick = (e) => {
    const approve = e.target.closest('[data-approve-duplicate]');
    if (approve) { e.stopPropagation(); reviewDuplicateCustomer(approve.dataset.approveDuplicate, true); return; }
    const reject = e.target.closest('[data-reject-duplicate]');
    if (reject) { e.stopPropagation(); reviewDuplicateCustomer(reject.dataset.rejectDuplicate, false); return; }
    const del = e.target.closest('[data-delete-cust]');
    if (del) { e.stopPropagation(); deleteCustomer(del.dataset.deleteCust); return; }
    const mg = e.target.closest('[data-merge-cust]');
    if (mg) { e.stopPropagation(); mergeCustomers(mg.dataset.mergeCust); return; }
    const ed = e.target.closest('[data-edit-cust]');
    if (ed) { e.stopPropagation(); editCustomer(ed.dataset.editCust); return; }
    const row = e.target.closest('[data-customer]');
    if (row) openCustomer(row.dataset.customer);
  };
}

async function reviewDuplicateCustomer(id, approve) {
  const c = db.customers.find((x) => x.id === id);
  const target = db.customers.find((x) => x.id === c?.duplicate_candidate_id);
  if (!c || !target) { toast('כרטיס הלקוח המקורי לא נמצא', true); return; }

  const message = approve
    ? `לאשר ש"${c.name}" ו"${target.name}" הם אותו עסק?\n\nכל ההזמנות, החשבוניות וההחזרות יאוחדו. שני חשבונות ההתחברות יישארו פעילים ויראו את אותה היסטוריה.`
    : `לסמן ש"${c.name}" ו"${target.name}" אינם אותו עסק?\n\nשני הכרטיסים יישארו נפרדים ולא תועבר ביניהם היסטוריה.`;
  if (!confirm(message)) return;

  try {
    const { data, error } = await sb.rpc('review_duplicate_customer', {
      p_customer_id: id,
      p_approve: approve,
    });
    if (error) throw error;
    toast(approve
      ? `הלקוחות אוחדו. ${fmtNum(data?.users)} חשבונות התחברות הועברו לכרטיס המשותף`
      : 'הלקוחות נשארו נפרדים');
    $('customerOverlay').classList.remove('active');
    await loadAll();
  } catch (err) {
    toast(friendlyError(err), true);
  }
}

async function deleteCustomer(id) {
  const c = db.customers.find((x) => x.id === id);
  if (!c) return;

  const linkedUsers = db.users.filter((u) => u.customer_id === id).length;
  const userNote = linkedUsers
    ? `\n${fmtNum(linkedUsers)} משתמשים מקושרים ינותקו מהכרטיס ויידרשו להשלים פרטים מחדש.`
    : '';

  if (!confirm(`למחוק לצמיתות את הלקוח "${c.name}"?\n\n`
    + 'המחיקה תתבצע רק אם אין ללקוח הזמנות, חשבוניות או החזרות. אם קיימת היסטוריה, יש להשתמש באיחוד לקוחות.'
    + userNote + '\n\nהפעולה אינה הפיכה.')) return;

  try {
    const { data, error } = await sb.rpc('delete_customer', { p_customer_id: id });
    if (error) throw error;
    toast(data?.detached_users
      ? `הלקוח נמחק ו-${fmtNum(data.detached_users)} משתמשים נותקו מהכרטיס`
      : 'הלקוח נמחק');
    $('customerOverlay').classList.remove('active');
    await loadAll();
  } catch (err) {
    toast(friendlyError(err), true);
  }
}

// ── איחוד לקוחות ────────────────────────────────────────────
// אותו עסק נרשם לפעמים פעמיים (בעל החנות והעובד, או שם שנכתב
// אחרת). האיחוד מעביר את כל ההיסטוריה לכרטיס אחד ומוחק את הכפול.
function mergeCustomers(sourceId = '') {
  const opts = (sel) => db.customers.map((c) =>
    `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>${esc(c.name)}${
      c.business_name ? ` — ${esc(c.business_name)}` : ''} (${c.orders_count} הזמנות)</option>`).join('');

  modal('🔗 איחוד לקוחות', `
    <div class="note small">
      כל ההזמנות, החשבוניות, החזרות והמשתמשים של <b>הכרטיס הכפול</b> יעברו
      אל <b>הכרטיס שנשאר</b>, והכפול יימחק. פרטים שחסרים בכרטיס שנשאר
      יושלמו מהכפול. הפעולה אינה הפיכה.
    </div>
    <div class="field"><label>הכרטיס הכפול (יימחק) <span class="req">*</span></label>
      <select id="mgSource"><option value="">— בחר —</option>${opts(sourceId)}</select></div>
    <div class="field"><label>הכרטיס שנשאר <span class="req">*</span></label>
      <select id="mgTarget"><option value="">— בחר —</option>${opts('')}</select></div>
    <div id="mgPreview" class="note small" style="display:none"></div>
    <div class="err-msg" id="mgError"></div>
    <button class="btn block lg danger" id="mgSave">איחוד</button>
  `);

  const preview = () => {
    const s = db.customers.find((c) => c.id === $('mgSource').value);
    const t = db.customers.find((c) => c.id === $('mgTarget').value);
    const box = $('mgPreview');
    if (!s || !t || s.id === t.id) { box.style.display = 'none'; return; }
    box.innerHTML = `אחרי האיחוד ל<b>${esc(t.name)}</b> יהיו
      <b>${fmtNum(Number(s.orders_count) + Number(t.orders_count))}</b> הזמנות ו-
      <b>${fmtNum(Number(s.total_units) + Number(t.total_units))}</b> יחידות.
      הכרטיס <b>${esc(s.name)}</b> יימחק.`;
    box.style.display = 'block';
  };
  on('mgSource', 'change', preview);
  on('mgTarget', 'change', preview);
  preview();

  on('mgSave', 'click', async () => {
    const src = $('mgSource').value;
    const tgt = $('mgTarget').value;
    const err = $('mgError');
    err.classList.remove('show');

    if (!src || !tgt)  { err.textContent = 'יש לבחור שני כרטיסים'; err.classList.add('show'); return; }
    if (src === tgt)   { err.textContent = 'אלה אותו כרטיס'; err.classList.add('show'); return; }

    const s = db.customers.find((c) => c.id === src);
    const t = db.customers.find((c) => c.id === tgt);
    if (!confirm(`לאחד את "${s?.name}" לתוך "${t?.name}"?\n\nהכרטיס "${s?.name}" יימחק. הפעולה אינה הפיכה.`)) return;

    $('mgSave').disabled = true;
    try {
      const { data, error } = await sb.rpc('merge_customers', { p_source: src, p_target: tgt });
      if (error) throw error;
      toast(`אוחד — ${fmtNum(data.orders)} הזמנות, ${fmtNum(data.invoices)} חשבוניות, ${fmtNum(data.users)} משתמשים`);
      closeModal();
      $('customerOverlay').classList.remove('active');
      await loadAll();
    } catch (e2) {
      err.textContent = friendlyError(e2);
      err.classList.add('show');
      $('mgSave').disabled = false;
    }
  });
}

function openCustomer(id) {
  const c = db.customers.find((x) => x.id === id);
  if (!c) return;

  const orders = db.orders.filter((o) => o.customer_id === id);
  const invs   = db.invoices.filter((v) => v.customer_id === id);
  const users  = db.users.filter((u) => u.customer_id === id);

  const byM = new Map();
  for (const o of orders) {
    if (o.status === 'cancelled') continue;
    for (const it of o.order_items || []) byM.set(it.model, (byM.get(it.model) || 0) + it.qty);
  }
  const topModels = [...byM.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);

  $('customerPanelTitle').textContent = c.name;
  $('customerPanelBody').innerHTML = `
    ${c.duplicate_status === 'pending' ? `<div class="note warn small">
      <b>חשד לכפילות:</b> שם העסק זהה ל-${esc(c.duplicate_candidate_business || c.duplicate_candidate_name || 'לקוח קיים')}.
      שום מידע לא יועבר לפני אישור.
      <div class="row" style="margin-top:.65rem">
        <button class="btn success sm" data-approve-duplicate="${c.id}">✅ אישור ואיחוד</button>
        <button class="btn ghost sm" data-reject-duplicate="${c.id}">✖️ אינם אותו עסק</button>
      </div>
    </div>` : c.duplicate_status === 'rejected'
      ? '<div class="note small">ההתאמה נבדקה וסומנה כשני עסקים נפרדים.</div>' : ''}

    <div class="kpis" style="grid-template-columns:repeat(2,1fr)">
      <div class="kpi accent"><div class="label">הזמנות</div><div class="value">${fmtNum(c.orders_count)}</div></div>
      <div class="kpi accent"><div class="label">יחידות</div><div class="value">${fmtNum(c.total_units)}</div></div>
      <div class="kpi green"><div class="label">מחזור</div><div class="value sm">${fmtMoney(c.total_amount)}</div></div>
      <div class="kpi ${c.open_balance > 0 ? 'red' : 'green'}">
        <div class="label">חוב פתוח</div><div class="value sm">${fmtMoney(c.open_balance)}</div></div>
    </div>

    <div class="card" style="padding:.8rem">
      <div class="grid-2 small">
        <div><span class="muted">עסק:</span> ${esc(c.business_name || '—')}</div>
        <div><span class="muted">טלפון:</span> ${c.phone ? `<a href="tel:${esc(c.phone)}">${esc(c.phone)}</a>` : '—'}</div>
        <div><span class="muted">מייל:</span> ${esc(c.email || '—')}</div>
        <div><span class="muted">עיר:</span> ${esc(c.city || '—')}</div>
      </div>
      <div class="small" style="margin-top:.5rem">
        <span class="muted">משתמשים:</span>
        ${users.length ? users.map((u) => esc(u.email)).join(', ')
                       : '<span class="chip amber">אין — הלקוח לא יכול להתחבר</span>'}
      </div>
    </div>

    <h4 class="bold" style="margin:.9rem 0 .5rem">דגמים מובילים</h4>
    ${topModels.length
      ? `<div class="lines-wrap">${topModels.map(([m, q]) => `<span class="tag">${esc(m)}: ${fmtNum(q)}</span>`).join('')}</div>`
      : '<div class="small muted">אין הזמנות</div>'}

    <h4 class="bold" style="margin:1rem 0 .5rem">הזמנות (${orders.length})</h4>
    ${orders.length ? `<div class="table-wrap"><table class="responsive"><thead><tr>
      <th>#</th><th>תאריך</th><th class="num">יח׳</th><th class="num">סכום</th><th>סטטוס</th></tr></thead><tbody>
      ${orders.slice(0, 50).map((o) => `<tr>
        ${td('הזמנה', '#' + o.order_number, 'bold')}
        ${td('תאריך', fmtDate(o.created_at, false), 'small nowrap')}
        ${td('יחידות', fmtNum(o.total_units), 'num')}
        ${td('סכום', o.total_amount > 0 ? fmtMoney(o.total_amount) : '—', 'num')}
        ${td('סטטוס', statusChip(ORDER_STATUS, o.status))}
      </tr>`).join('')}</tbody></table></div>` : '<div class="small muted">אין הזמנות</div>'}

    <h4 class="bold" style="margin:1rem 0 .5rem">חשבוניות (${invs.length})</h4>
    ${invs.length ? `<div class="table-wrap"><table class="responsive"><thead><tr>
      <th>מס׳</th><th>תאריך</th><th class="num">סכום</th><th>סטטוס</th><th></th></tr></thead><tbody>
      ${invs.map((v) => `<tr>
        ${td('מס׳', esc(v.invoice_number || '—'), 'bold')}
        ${td('תאריך', fmtDate(v.issued_at, false), 'small nowrap')}
        ${td('סכום', v.amount != null ? fmtMoney(v.amount) : '—', 'num')}
        ${td('סטטוס', statusChip(INVOICE_STATUS, v.status))}
        ${td('', `<button class="btn ghost sm" data-dl="${esc(v.file_path)}"
              data-name="${esc(v.file_name || 'invoice.pdf')}">⬇️</button>`)}
      </tr>`).join('')}</tbody></table></div>` : '<div class="small muted">אין חשבוניות</div>'}

    <div class="row" style="margin-top:1rem">
      <button class="btn sm" data-upload-inv-cust="${c.id}">⬆️ חשבונית</button>
      <button class="btn ghost sm" data-edit-cust="${c.id}">✏️ עריכה</button>
      <button class="btn ghost sm" data-merge-cust="${c.id}">🔗 איחוד</button>
      <button class="btn ghost sm" data-export-cust="${c.id}">⬇️ ייצוא</button>
      <button class="btn danger sm" data-delete-cust="${c.id}">🗑️ מחיקת לקוח</button>
    </div>`;

  $('customerOverlay').classList.add('active');
}

function editCustomer(id) {
  const c = id ? db.customers.find((x) => x.id === id) : null;

  modal(c ? `עריכת ${c.name}` : 'לקוח חדש', `
    <div class="grid-2">
      <div class="field"><label>שם <span class="req">*</span></label>
        <input type="text" id="uName" value="${esc(c?.name || '')}"></div>
      <div class="field"><label>שם עסק</label>
        <input type="text" id="uBiz" value="${esc(c?.business_name || '')}"></div>
    </div>
    <div class="grid-2">
      <div class="field"><label>טלפון</label>
        <input type="tel" id="uPhone" inputmode="tel" value="${esc(c?.phone || '')}"></div>
      <div class="field"><label>אימייל</label>
        <input type="email" id="uEmail" inputmode="email" value="${esc(c?.email || '')}"></div>
    </div>
    <div class="grid-2">
      <div class="field"><label>עיר</label><input type="text" id="uCity" value="${esc(c?.city || '')}"></div>
      <div class="field"><label>ח.פ / ע.מ</label><input type="text" id="uTax" value="${esc(c?.tax_id || '')}"></div>
    </div>
    <div class="grid-2">
      <div class="field"><label>כתובת</label><input type="text" id="uAddr" value="${esc(c?.address || '')}"></div>
      <div class="field"><label>הנחה קבועה (%)</label>
        <input type="number" id="uDisc" min="0" max="100" step="0.5" inputmode="decimal" value="${c?.discount_pct ?? 0}"></div>
    </div>
    <div class="field"><label>הערות</label><textarea id="uNotes" rows="2">${esc(c?.notes || '')}</textarea></div>
    <button class="btn block lg" id="uSave">שמירה</button>
  `);

  on('uSave', 'click', async () => {
    const name = $('uName').value.trim();
    if (!name) { toast('חסר שם לקוח', true); return; }
    const rec = {
      name,
      business_name: $('uBiz').value.trim()   || null,
      phone:         $('uPhone').value.trim() || null,
      email:         $('uEmail').value.trim() || null,
      city:          $('uCity').value.trim()  || null,
      tax_id:        $('uTax').value.trim()   || null,
      address:       $('uAddr').value.trim()  || null,
      discount_pct:  Number($('uDisc').value) || 0,
      notes:         $('uNotes').value.trim() || null,
    };
    if (c && (rec.business_name || '').toLowerCase() !== (c.business_name || '').toLowerCase()) {
      rec.duplicate_candidate_id = null;
      rec.duplicate_status = null;
    }
    $('uSave').disabled = true;
    try {
      const { error } = c
        ? await sb.from('customers').update(rec).eq('id', c.id)
        : await sb.from('customers').insert(rec);
      if (error) throw error;
      toast(c ? 'הלקוח עודכן' : 'הלקוח נוסף');
      closeModal();
      $('customerOverlay').classList.remove('active');
      await loadAll();
    } catch (err) {
      toast(friendlyError(err), true);
      $('uSave').disabled = false;
    }
  });
}

// ============================================================
// חשבוניות
// ============================================================
function filteredInvoices() {
  const cust = $('invCustomer').value;
  const st   = $('invStatus').value;
  return db.invoices.filter((v) => (!cust || v.customer_id === cust) && (!st || v.status === st));
}

function renderInvoices() {
  const items = filteredInvoices();
  $('invoicesCount').textContent = `(${fmtNum(items.length)})`;

  if (!items.length) {
    $('invoicesTable').innerHTML = '<div class="empty"><div class="ico">🧾</div>אין חשבוניות</div>';
    return;
  }

  $('invoicesTable').innerHTML = `<div class="table-wrap"><table class="responsive"><thead><tr>
    <th>מס׳</th><th>לקוח</th><th>הזמנה</th><th>תאריך</th>
    <th class="num">סכום</th><th>סטטוס</th><th></th></tr></thead><tbody>
    ${items.map((v) => `<tr>
      ${td('מס׳', esc(v.invoice_number || '—'), 'bold')}
      ${td('לקוח', esc(v.customers?.name || '—'))}
      ${td('הזמנה', v.orders?.order_number ? '#' + v.orders.order_number : '—')}
      ${td('תאריך', fmtDate(v.issued_at, false), 'small nowrap')}
      ${td('סכום', v.amount != null ? fmtMoney(v.amount) : '—', 'num')}
      ${td('סטטוס', `<select data-inv-status="${v.id}" style="min-height:38px;padding:.2rem .4rem;font-size:.85rem">
          ${Object.entries(INVOICE_STATUS).map(([k, s]) =>
            `<option value="${k}" ${v.status === k ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}
        </select>`)}
      ${td('', `<button class="btn ghost sm" data-dl="${esc(v.file_path)}"
                data-name="${esc(v.file_name || 'invoice.pdf')}">⬇️</button>
                <button class="btn ghost sm" data-del-inv="${v.id}">🗑️</button>`, 'nowrap')}
    </tr>`).join('')}
    </tbody></table></div>`;

  $('invoicesTable').onchange = async (e) => {
    const s = e.target.closest('[data-inv-status]');
    if (!s) return;
    try {
      const patch = { status: s.value };
      if (s.value === 'paid') patch.paid_at = new Date().toISOString().slice(0, 10);
      const { error } = await sb.from('invoices').update(patch).eq('id', s.dataset.invStatus);
      if (error) throw error;
      const v = db.invoices.find((x) => x.id === s.dataset.invStatus);
      if (v) v.status = s.value;
      toast('הסטטוס עודכן');
    } catch (err) {
      toast(friendlyError(err), true);
    }
  };

  $('invoicesTable').onclick = async (e) => {
    const del = e.target.closest('[data-del-inv]');
    if (del) { await deleteInvoice(del.dataset.delInv); return; }
    const dl = e.target.closest('[data-dl]');
    if (dl) await downloadInvoice(dl);
  };
}

async function downloadInvoice(btn) {
  btn.disabled = true;
  try {
    const { data, error } = await sb.storage
      .from('invoices').createSignedUrl(btn.dataset.dl, 3600, { download: btn.dataset.name });
    if (error) throw error;
    window.open(data.signedUrl, '_blank', 'noopener');
  } catch (err) {
    toast(friendlyError(err), true);
  } finally {
    btn.disabled = false;
  }
}

async function deleteInvoice(id) {
  const v = db.invoices.find((x) => x.id === id);
  if (!v) return;
  if (!confirm(`למחוק את החשבונית ${v.invoice_number || v.file_name}?\nהקובץ יימחק גם מהאחסון.`)) return;
  try {
    const { error } = await sb.from('invoices').delete().eq('id', id);
    if (error) throw error;
    await sb.storage.from('invoices').remove([v.file_path]);
    toast('החשבונית נמחקה');
    await loadAll();
  } catch (err) {
    toast(friendlyError(err), true);
  }
}

function uploadInvoice(presetOrderId = null, presetCustomerId = null) {
  const order = presetOrderId ? db.orders.find((o) => o.id === presetOrderId) : null;
  const custId = presetCustomerId || order?.customer_id || '';

  modal('העלאת חשבונית', `
    <div class="field"><label>לקוח <span class="req">*</span></label>
      <select id="ivCustomer"><option value="">— בחר לקוח —</option>
        ${db.customers.map((c) => `<option value="${c.id}" ${c.id === custId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
      </select></div>
    <div class="field"><label>שיוך להזמנה</label>
      <select id="ivOrder"><option value="">— ללא —</option></select>
      <div class="hint">חשבונית משויכת תופיע ללקוח בתוך ההזמנה עצמה</div></div>
    <div class="grid-2">
      <div class="field"><label>מספר חשבונית</label><input type="text" id="ivNumber" placeholder="2026-0142"></div>
      <div class="field"><label>סכום (₪)</label>
        <input type="number" id="ivAmount" min="0" step="0.01" inputmode="decimal" value="${order?.total_amount || ''}"></div>
    </div>
    <div class="grid-2">
      <div class="field"><label>תאריך</label>
        <input type="date" id="ivDate" value="${new Date().toISOString().slice(0, 10)}"></div>
      <div class="field"><label>סטטוס</label>
        <select id="ivStatusNew"><option value="unpaid">לא שולמה</option><option value="paid">שולמה</option></select></div>
    </div>
    <div class="field"><label>קובץ PDF <span class="req">*</span></label>
      <input type="file" id="ivFile" accept="application/pdf,image/*"></div>
    <div class="err-msg" id="ivError"></div>
    <button class="btn block lg" id="ivSave">העלאה</button>
  `);

  const fillOrders = () => {
    const cid = $('ivCustomer').value;
    $('ivOrder').innerHTML = '<option value="">— ללא —</option>' +
      db.orders.filter((o) => o.customer_id === cid).map((o) =>
        `<option value="${o.id}" ${o.id === presetOrderId ? 'selected' : ''}>#${o.order_number} · ${fmtDate(o.created_at, false)} · ${fmtNum(o.total_units)} יח׳</option>`).join('');
  };
  fillOrders();
  on('ivCustomer', 'change', fillOrders);

  on('ivSave', 'click', async () => {
    const cid  = $('ivCustomer').value;
    const file = $('ivFile').files[0];
    const err  = $('ivError');
    err.classList.remove('show');

    if (!cid)  { err.textContent = 'יש לבחור לקוח'; err.classList.add('show'); return; }
    if (!file) { err.textContent = 'יש לבחור קובץ'; err.classList.add('show'); return; }
    if (file.size > 20 * 1024 * 1024) { err.textContent = 'הקובץ גדול מ-20MB'; err.classList.add('show'); return; }

    const btn = $('ivSave');
    btn.disabled = true;
    btn.textContent = 'מעלה…';

    try {
      const safe = file.name.replace(/[^\w.\-]/g, '_');
      const path = `${cid}/${Date.now()}_${safe}`;

      const { error: upErr } = await sb.storage.from('invoices')
        .upload(path, file, { contentType: file.type || 'application/pdf', upsert: false });
      if (upErr) throw upErr;

      const { error: insErr } = await sb.from('invoices').insert({
        customer_id: cid,
        order_id: $('ivOrder').value || null,
        invoice_number: $('ivNumber').value.trim() || null,
        amount: $('ivAmount').value ? Number($('ivAmount').value) : null,
        issued_at: $('ivDate').value || new Date().toISOString().slice(0, 10),
        status: $('ivStatusNew').value,
        file_path: path, file_name: file.name,
        uploaded_by: state.user.id,
      });
      if (insErr) { await sb.storage.from('invoices').remove([path]); throw insErr; }

      toast('החשבונית הועלתה');
      closeModal();
      $('customerOverlay').classList.remove('active');
      $('orderOverlay').classList.remove('active');
      await loadAll();
    } catch (e2) {
      err.textContent = friendlyError(e2);
      err.classList.add('show');
      btn.disabled = false;
      btn.textContent = 'העלאה';
    }
  });
}

// ============================================================
// הגדרות
// ============================================================
function renderSettings() {
  // ── מיילים ──
  $('emailsTable').innerHTML = db.emails.length
    ? `<div class="table-wrap"><table class="responsive"><thead><tr>
        <th>כתובת</th><th>תיאור</th><th>הזמנה חדשה</th><th>שגיאת סנכרון</th><th></th></tr></thead><tbody>
      ${db.emails.map((m) => `<tr>
        ${td('כתובת', esc(m.email), 'bold')}
        ${td('תיאור', esc(m.label || '—'), 'muted small')}
        ${td('הזמנה חדשה', `<input type="checkbox" ${m.on_new_order ? 'checked' : ''}
              data-mail="${m.id}|on_new_order" aria-label="התראה על הזמנה חדשה ל-${esc(m.email)}">`)}
        ${td('שגיאת סנכרון', `<input type="checkbox" ${m.on_sync_error ? 'checked' : ''}
              data-mail="${m.id}|on_sync_error" aria-label="התראה על שגיאת סנכרון ל-${esc(m.email)}">`)}
        ${td('', `<button class="btn danger sm" data-del-mail="${m.id}">🗑️</button>`)}
      </tr>`).join('')}</tbody></table></div>`
    : '<div class="empty">אין כתובות — אף אחד לא יקבל התראה על הזמנות חדשות</div>';

  $('emailsTable').onchange = async (e) => {
    const cb = e.target.closest('[data-mail]');
    if (!cb) return;
    const [id, field] = cb.dataset.mail.split('|');
    try {
      const { error } = await sb.from('notification_emails').update({ [field]: cb.checked }).eq('id', id);
      if (error) throw error;
      const m = db.emails.find((x) => String(x.id) === id);
      if (m) m[field] = cb.checked;
      toast('נשמר');
    } catch (err) {
      toast(friendlyError(err), true);
      cb.checked = !cb.checked;
    }
  };

  $('emailsTable').onclick = async (e) => {
    const b = e.target.closest('[data-del-mail]');
    if (!b) return;
    const m = db.emails.find((x) => String(x.id) === b.dataset.delMail);
    if (!confirm(`להסיר את ${m?.email} מרשימת ההתראות?`)) return;
    try {
      const { error } = await sb.from('notification_emails').delete().eq('id', b.dataset.delMail);
      if (error) throw error;
      toast('הוסר');
      await loadAll();
    } catch (err) { toast(friendlyError(err), true); }
  };

  // ── משתמשים ──
  $('usersCount').textContent = `(${fmtNum(db.users.length)})`;
  const small = 'min-height:38px;padding:.2rem .4rem;font-size:.85rem';
  $('usersTable').innerHTML = db.users.length
    ? `<div class="table-wrap"><table class="responsive"><thead><tr>
        <th>שם</th><th>אימייל</th><th>תפקיד</th><th>לקוח</th><th>נרשם</th><th></th></tr></thead><tbody>
      ${db.users.map((u) => {
        const me = u.id === state.user?.id;
        return `<tr>
        ${td('שם', esc(u.full_name || '—') + (me ? ' <span class="chip blue">אני</span>' : ''), 'bold')}
        ${td('אימייל', esc(u.email || '—'), 'small')}
        ${td('תפקיד', me
          ? '<span class="chip blue">מנהל</span>'
          : `<select data-role="${u.id}" style="${small}">
               <option value="customer" ${u.role !== 'admin' ? 'selected' : ''}>לקוח</option>
               <option value="admin"    ${u.role === 'admin' ? 'selected' : ''}>מנהל</option>
             </select>`)}
        ${td('לקוח', u.role === 'admin' ? '<span class="faint small">—</span>' :
          `<select data-assign="${u.id}" style="${small}">
             <option value="">— ללא —</option>
             ${db.customers.map((c) => `<option value="${c.id}" ${u.customer_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
           </select>`)}
        ${td('נרשם', fmtDate(u.created_at, false), 'small nowrap')}
        ${td('', me ? '<span class="faint small">—</span>'
          : `<button class="btn danger sm" data-delete-user="${u.id}" title="מחיקת חשבון התחברות">🗑️ מחיקה</button>`, 'nowrap')}
      </tr>`; }).join('')}</tbody></table></div>`
    : '<div class="empty">אין משתמשים</div>';

  $('usersTable').onchange = async (e) => {
    const r = e.target.closest('[data-role]');
    if (r) {
      const u = db.users.find((x) => x.id === r.dataset.role);
      const label = r.value === 'admin' ? 'מנהל' : 'לקוח';
      if (!confirm(`להגדיר את ${u?.full_name || u?.email} כ${label}?`
        + (r.value === 'admin' ? '\n\nמנהל רואה את כל ההזמנות, המחירים והרווחיות.' : ''))) {
        r.value = u?.role || 'customer';
        return;
      }
      try {
        const { error } = await sb.rpc('set_user_role', { p_user_id: r.dataset.role, p_role: r.value });
        if (error) throw error;
        toast(`${u?.full_name || 'המשתמש'} מוגדר כעת כ${label}`);
        await loadAll();
      } catch (err) {
        toast(friendlyError(err), true);
        r.value = u?.role || 'customer';
      }
      return;
    }

    const s = e.target.closest('[data-assign]');
    if (!s) return;
    try {
      const { error } = await sb.rpc('assign_user_to_customer', {
        p_user_id: s.dataset.assign, p_customer_id: s.value || null, p_approve: true,
      });
      if (error) throw error;
      toast(s.value ? 'המשתמש שויך' : 'השיוך הוסר');
      await loadAll();
    } catch (err) { toast(friendlyError(err), true); }
  };

  $('usersTable').onclick = async (e) => {
    const button = e.target.closest('[data-delete-user]');
    if (!button) return;
    const user = db.users.find((u) => u.id === button.dataset.deleteUser);
    if (!user) { toast('המשתמש לא נמצא', true); return; }

    const display = user.full_name || user.email || 'המשתמש';
    if (!confirm(`למחוק את חשבון ההתחברות של ${display}?\n\n`
      + 'המשתמש לא יוכל להתחבר יותר. כרטיס הלקוח, ההזמנות, החשבוניות וכל ההיסטוריה יישמרו.\n\n'
      + 'הפעולה אינה ניתנת לביטול.')) return;

    button.disabled = true;
    button.textContent = 'מוחק…';
    try {
      const { error } = await sb.rpc('delete_user_account', { p_user_id: user.id });
      if (error) throw error;
      toast(`חשבון ההתחברות של ${display} נמחק`);
      await loadAll();
    } catch (err) {
      toast(friendlyError(err), true);
      button.disabled = false;
      button.textContent = '🗑️ מחיקה';
    }
  };

  // ── כללי ──
  const S = db.settings;
  $('settingsForm').innerHTML = `
    <div class="grid-2">
      <div class="field"><label>שם העסק</label>
        <input type="text" id="setBrand" value="${esc(S.brand_name || '')}"></div>
      <div class="field"><label>טלפון ליצירת קשר</label>
        <input type="tel" id="setPhone" value="${esc(S.brand_phone || '')}"></div>
    </div>
    <div class="field"><label>מייל השולח / ליצירת קשר</label>
      <input type="email" id="setEmail" value="${esc(S.brand_email || '')}"></div>
    <button class="btn" id="setSave">שמירה</button>`;

  on('setSave', 'click', async () => {
    const vals = {
      brand_name:  $('setBrand').value.trim(),
      brand_phone: $('setPhone').value.trim(),
      brand_email: $('setEmail').value.trim(),
    };
    $('setSave').disabled = true;
    try {
      for (const [key, value] of Object.entries(vals)) {
        const { error } = await sb.from('app_settings')
          .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
        if (error) throw error;
      }
      db.settings = { ...db.settings, ...vals };
      toast('ההגדרות נשמרו');
    } catch (err) { toast(friendlyError(err), true); }
    finally { $('setSave').disabled = false; }
  });
}

function addEmail() {
  modal('הוספת כתובת להתראות', `
    <div class="field"><label>אימייל <span class="req">*</span></label>
      <input type="email" id="meEmail" inputmode="email" placeholder="name@example.com"></div>
    <div class="field"><label>תיאור</label>
      <input type="text" id="meLabel" placeholder="לדוגמה: מחסן"></div>
    <label class="row small" style="gap:.5rem;min-height:44px">
      <input type="checkbox" id="meNew" checked> התראה על הזמנה חדשה</label>
    <label class="row small" style="gap:.5rem;min-height:44px;margin-bottom:.8rem">
      <input type="checkbox" id="meSync"> התראה על שגיאת סנכרון לשופיפיי</label>
    <button class="btn block lg" id="meSave">הוספה</button>`);

  on('meSave', 'click', async () => {
    const email = $('meEmail').value.trim();
    if (!email || !email.includes('@')) { toast('כתובת לא תקינה', true); return; }
    $('meSave').disabled = true;
    try {
      const { error } = await sb.from('notification_emails').insert({
        email, label: $('meLabel').value.trim() || null,
        on_new_order: $('meNew').checked, on_sync_error: $('meSync').checked,
      });
      if (error) throw error;
      toast('הכתובת נוספה');
      closeModal();
      await loadAll();
    } catch (err) {
      toast(friendlyError(err), true);
      $('meSave').disabled = false;
    }
  });
}

// ============================================================
// בדיקת שליחת מייל
// ============================================================
async function sendTestMail() {
  const to  = $('testMailTo').value.trim();
  const btn = $('testMailBtn');
  const out = $('testMailResult');

  if (!to || !to.includes('@')) { toast('יש להזין כתובת מייל תקינה', true); return; }

  btn.disabled = true;
  btn.textContent = '📤 שולח…';
  out.innerHTML = '<div class="loading"><div class="spinner"></div>מתחבר לשרת המייל…</div>';

  try {
    const { data, error } = await sb.functions.invoke('order-email', {
      body: { event: 'test', to },
    });
    if (error) throw error;
    if (data?.ok === false) throw new Error(data.error || 'השליחה נכשלה');

    out.innerHTML = `<div class="note">✅ מייל בדיקה נשלח אל <b>${esc(to)}</b>.
      אם הוא לא הגיע תוך דקה — בדוק בתיקיית הספאם.</div>`;
    toast('מייל הבדיקה נשלח');
  } catch (err) {
    const msg = String(err?.message || err);
    // התרגום של השגיאות הנפוצות חוסך חיטוט בלוגים של הפונקציה
    const hint = /535|Username and Password/i.test(msg)
        ? 'קוד האפליקציה שגוי, או שהאימות הדו-שלבי בג׳ימייל כבוי. הפק קוד חדש והרץ שוב <code>supabase secrets set SMTP_PASS=…</code>'
      : /SMTP_USER|SMTP_PASS/i.test(msg)
        ? 'הסודות עדיין לא הוגדרו. ראה שלב 9.5 בהוראות ההתקנה.'
      : /Failed to send a request|FunctionsFetchError/i.test(msg)
        ? 'הפונקציה לא פרוסה. הרץ <code>supabase functions deploy order-email</code>'
        : '';
    out.innerHTML = `<div class="note danger">❌ ${esc(friendlyError(err))}${hint ? `<br><br>${hint}` : ''}</div>`;
    toast('השליחה נכשלה', true);
  } finally {
    btn.disabled = false;
    btn.textContent = '📤 שלח מייל בדיקה';
  }
}

// ============================================================
// סנכרון שופיפיי
// ============================================================
async function syncShopify() {
  const btn = $('syncShopifyBtn');
  const out = $('syncResult');
  if (!confirm('לסנכרן את המלאי והמחירים לשופיפיי?\n\nזה עשוי לקחת דקה או שתיים.')) return;

  btn.disabled = true;
  btn.textContent = '⏳ מסנכרן…';
  out.innerHTML = '<div class="loading"><div class="spinner"></div>מסנכרן מול שופיפיי…</div>';

  try {
    const { data, error } = await sb.functions.invoke('shopify-sync', { body: {} });
    if (error) throw error;

    if (data?.ok === false) throw new Error(data.error || 'הסנכרון נכשל');

    out.innerHTML = `<div class="note ${data.errors?.length ? 'warn' : ''}">
      ✅ הסנכרון הושלם ב-${data.seconds || '?'} שניות<br>
      נוצרו: <b>${data.created ?? 0}</b> · עודכנו: <b>${data.updated ?? 0}</b> · ללא שינוי: <b>${data.unchanged ?? 0}</b>
      ${data.errors?.length ? `<br><br><b>שגיאות (${data.errors.length}):</b><br>
        ${data.errors.slice(0, 10).map((x) => esc(x)).join('<br>')}` : ''}
    </div>`;
    toast('הסנכרון הושלם');
  } catch (err) {
    out.innerHTML = `<div class="note danger">
      ❌ ${esc(friendlyError(err))}
      <br><br>אם הפונקציה עוד לא נפרסה, הרץ:
      <br><code>supabase functions deploy shopify-sync</code>
      <br>וודא שהוגדרו הסודות <code>SHOPIFY_CLIENT_ID</code> ו-<code>SHOPIFY_CLIENT_SECRET</code>.
    </div>`;
    toast(friendlyError(err), true);
  } finally {
    btn.disabled = false;
    btn.textContent = '🔄 סנכרן לשופיפיי עכשיו';
  }
}

// ============================================================
// ייצוא
// ============================================================
function orderRowsFlat() {
  const q = filters.model.trim().toLowerCase();
  const rows = [];
  for (const o of filteredOrders()) {
    for (const it of o.order_items || []) {
      if (q && !it.model.toLowerCase().includes(q)) continue;
      if (filters.collection && productCollection(it.model) !== filters.collection) continue;
      const p = productByModel(it.model);
      rows.push({
        'מס׳ הזמנה': o.order_number,
        'תאריך': fmtDate(o.created_at, false),
        'לקוח': o.customers?.name || o.contact_name || '',
        'עסק': o.customers?.business_name || '',
        'טלפון': o.phone || '',
        'סטטוס': ORDER_STATUS[o.status]?.label || o.status,
        'קולקציה': p?.collections?.name || '',
        'דגם': it.model,
        'מידה': it.size,
        'הוזמן': it.qty_ordered ?? it.qty,
        'כמות': it.qty,
        'מחיר סיטונאי': Number(it.unit_price || 0),
        'סה״כ שורה': +(it.qty * (it.unit_price || 0)).toFixed(2),
        'אחרי הנחה': +lineNet({ ...it, order: o }).toFixed(2),
        'עלות ליח׳': Number(p?.cost_price || 0),
        'רווח שורה': +(lineNet({ ...it, order: o }) - it.qty * (p?.cost_price || 0)).toFixed(2),
        'הערות': o.notes || '',
        'הערת מנהל': db.orderNotes[o.id] || '',
      });
    }
  }
  return rows;
}

function orderRowsSummary() {
  return filteredOrders().map((o) => ({
    'מס׳ הזמנה': o.order_number,
    'תאריך': fmtDate(o.created_at, false),
    'לקוח': o.customers?.name || o.contact_name || '',
    'עסק': o.customers?.business_name || '',
    'טלפון': o.phone || '',
    'מייל': o.email || '',
    'סטטוס': ORDER_STATUS[o.status]?.label || o.status,
    'שורות': (o.order_items || []).length,
    'יחידות': o.total_units,
    'לפני הנחה': Number(o.subtotal_amount || o.total_amount || 0),
    'הנחה': Number(o.discount_amount || 0),
    'סכום': Number(o.total_amount || 0),
    'מוכנה': o.ready_at ? fmtDate(o.ready_at, false) : '',
    'נשלחה': o.shipped_at ? fmtDate(o.shipped_at, false) : '',
    'שולמה': o.paid_at ? fmtDate(o.paid_at, false) : '',
    'ארכיון': o.archived_at ? fmtDate(o.archived_at, false) : '',
    'הערות': o.notes || '',
    'הערת מנהל': db.orderNotes[o.id] || '',
  }));
}

function demandRows(source = null) {
  const rows = source || demandMatrix();
  const cols = usedSizes(rows);
  return rows.map((r) => {
    const o = { 'דגם': r.model, 'קולקציה': r.collection };
    for (const s of cols) o[s] = r.sizes[s] || 0;
    o['סה״כ'] = r.total;
    o['הזמנות'] = r.orders.size;
    o['עלות'] = r.cost;
    o['סיטונאי'] = r.wholesale;
    o['קמעונאי'] = r.retail;
    o['מחזור'] = +r.amount.toFixed(2);
    o['רווח'] = +r.profit.toFixed(2);
    return o;
  });
}

// שורה לכל צירוף דגם×לקוח, כדי שבאקסל יהיה ברור מי הזמין מה.
// אותן עמודות מידה לכל השורות — כך אפשר לסנן ולסכם בגיליון.
function demandByCustomerRows(onlyModel = null) {
  const matrix = demandMatrix();
  const cols = usedSizes(matrix);
  const out = [];

  for (const m of matrix) {
    if (onlyModel && m.model !== onlyModel) continue;

    const byCust = new Map();
    for (const r of demandBreakdown(m.model)) {
      let e = byCust.get(r.customer);
      if (!e) { e = { customer: r.customer, orders: [], sizes: {}, total: 0, amount: 0 }; byCust.set(r.customer, e); }
      e.orders.push(r.order_number);
      for (const [s, q] of Object.entries(r.sizes)) e.sizes[s] = (e.sizes[s] || 0) + q;
      e.total  += r.total;
      e.amount += r.amount;
    }

    for (const c of [...byCust.values()].sort((a, b) => b.total - a.total)) {
      const row = {
        'דגם': m.model,
        'קולקציה': m.collection,
        'לקוח': c.customer,
        'מס׳ הזמנות': c.orders.length,
        'הזמנות': c.orders.map((n) => '#' + n).join(', '),
      };
      for (const s of cols) row[s] = c.sizes[s] || 0;
      row['סה״כ יח׳'] = c.total;
      row['שווי'] = +c.amount.toFixed(2);
      out.push(row);
    }
  }
  return out;
}

function stockRows() {
  return stockProducts().map((p) => {
    const o = { 'דגם': p.model, 'קולקציה': p.collections?.name || '', 'תיאור': p.description || '' };
    for (const s of SIZES) o[s] = p.stock[s] ?? 0;
    o['סה״כ'] = p.total;
    o['עלות'] = Number(p.cost_price || 0);
    o['סיטונאי'] = Number(p.wholesale_price || 0);
    o['קמעונאי'] = Number(p.retail_price || 0);
    o['מוצג'] = p.is_active ? 'כן' : 'לא';
    o['תמונה'] = p.image_url || '';
    return o;
  });
}

async function exportOrdersFlat() {
  const rows = orderRowsFlat();
  if (!rows.length) { toast('אין נתונים לייצוא', true); return; }
  await exportXlsx('הזמנות_מפורט', [
    { name: 'שורות הזמנה', rows },
    { name: 'סיכום הזמנות', rows: orderRowsSummary() },
    { name: 'ריכוז לפי דגם', rows: demandRows() },
  ]);
  toast(`יוצאו ${fmtNum(rows.length)} שורות`);
}

// ההזמנות ההיסטוריות שיובאו מהגיליון הישן אין להן מחירי עלות אמיתיים.
// התאריך הזה מוציא אותן מהחישוב — והזזה אחורה מכניסה אותן בחזרה.
async function saveProfitStart(value) {
  const btn = $('profitStartSave');
  btn.disabled = true;
  try {
    const { error } = await sb.from('app_settings')
      .upsert({ key: 'profit_start_date', value, updated_at: new Date().toISOString() },
              { onConflict: 'key' });
    if (error) throw error;
    db.settings.profit_start_date = value;
    toast(value ? `החישוב מתחיל מ-${fmtDate(new Date(value + 'T00:00:00'), false)}` : 'כל ההיסטוריה נכללת');
    renderActiveTab();
  } catch (err) { toast(friendlyError(err), true); }
  finally { btn.disabled = false; }
}

async function exportReturns() {
  const rows = [];
  for (const r of db.returns) {
    for (const i of returnItemsOf(r.id)) {
      rows.push({
        'מס׳ חזרה': r.return_number,
        'תאריך': fmtDate(r.return_date, false),
        'מחזיר': r.returner_name || '',
        'לקוח': r.customer_name || '',
        'דגם': i.model || '',
        'מידה': i.size || '',
        'כמות': i.qty,
        'פגום': i.is_defective ? 'כן' : 'לא',
        'נכנס למלאי': i.is_defective ? 'לא' : 'כן',
        'הערת פריט': i.notes || '',
        'סטטוס': RETURN_STATUS[r.status]?.label || r.status,
        'תאריך זיכוי': r.credited_at ? fmtDate(r.credited_at, false) : '',
        'תמונה': i.photo_url || '',
      });
    }
  }
  if (!rows.length) { toast('אין חזרות לייצוא', true); return; }
  await exportXlsx('חזרות', [{ name: 'חזרות', rows }]);
  toast(`יוצאו ${fmtNum(rows.length)} שורות`);
}

async function exportProfit() {
  const items = profitItems();
  if (!items.length) { toast('אין נתונים לייצוא בטווח החישוב הנוכחי', true); return; }

  const byMonth = new Map();
  for (const it of items) {
    const d = new Date(it.order.created_at);
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const e = byMonth.get(k) || { 'חודש': k, 'יחידות': 0, 'מחזור': 0, 'עלות': 0 };
    e['יחידות'] += it.qty;
    e['מחזור']  += lineNet(it);
    e['עלות']   += lineCost(it);
    byMonth.set(k, e);
  }
  const months = [...byMonth.values()].sort((a, b) => b['חודש'].localeCompare(a['חודש']))
    .map((m) => ({
      ...m,
      'מחזור': +m['מחזור'].toFixed(2),
      'עלות': +m['עלות'].toFixed(2),
      'רווח': +(m['מחזור'] - m['עלות']).toFixed(2),
      'מרווח %': m['מחזור'] > 0 ? +((m['מחזור'] - m['עלות']) / m['מחזור'] * 100).toFixed(1) : 0,
    }));

  await exportXlsx('רווחיות', [
    { name: 'חודשי', rows: months },
    { name: 'לפי דגם', rows: demandRows(demandMatrix(items)) },
  ]);
  toast('הקובץ יורד…');
}

async function exportDemandSupplier() {
  const rows = demandMatrix();
  if (!rows.length) { toast('אין נתונים לייצוא', true); return; }
  const cols = usedSizes(rows);
  const out = rows.map((r) => {
    const o = { 'דגם': r.model };
    for (const s of cols) o[s] = r.sizes[s] || 0;
    o['סה״כ'] = r.total;
    return o;
  });
  const totals = { 'דגם': 'סה״כ' };
  for (const s of cols) totals[s] = rows.reduce((a, r) => a + (r.sizes[s] || 0), 0);
  totals['סה״כ'] = rows.reduce((a, r) => a + r.total, 0);
  out.push(totals);
  await exportXlsx('הזמנה_לספק', [{ name: 'הזמנה לספק', rows: out }]);
  toast('טופס ההזמנה לספק מוכן');
}

async function exportSingleOrder(id) {
  const o = db.orders.find((x) => x.id === id);
  if (!o) return;
  await exportXlsx(`הזמנה_${o.order_number}`, [{
    name: `הזמנה ${o.order_number}`,
    rows: (o.order_items || []).map((l) => ({
      'דגם': l.model, 'מידה': l.size, 'כמות': l.qty,
      'מחיר': Number(l.unit_price || 0),
      'סה״כ': +(l.qty * (l.unit_price || 0)).toFixed(2),
    })),
  }]);
}

async function exportCustomerHistory(id) {
  const c = db.customers.find((x) => x.id === id);
  const rows = [];
  for (const o of db.orders.filter((x) => x.customer_id === id)) {
    for (const l of o.order_items || []) {
      rows.push({
        'מס׳ הזמנה': o.order_number, 'תאריך': fmtDate(o.created_at, false),
        'סטטוס': ORDER_STATUS[o.status]?.label || o.status,
        'דגם': l.model, 'מידה': l.size, 'כמות': l.qty, 'מחיר': Number(l.unit_price || 0),
      });
    }
  }
  const invs = db.invoices.filter((v) => v.customer_id === id).map((v) => ({
    'מס׳ חשבונית': v.invoice_number || '', 'תאריך': fmtDate(v.issued_at, false),
    'סכום': Number(v.amount || 0), 'סטטוס': INVOICE_STATUS[v.status]?.label || v.status,
  }));
  await exportXlsx(`לקוח_${(c?.name || '').replace(/\s+/g, '_')}`, [
    { name: 'הזמנות', rows }, { name: 'חשבוניות', rows: invs },
  ]);
}

// ============================================================
// מודאל
// ============================================================
function modal(title, html) {
  $('modalTitle').textContent = title;
  $('modalBody').innerHTML = html;
  $('modal').classList.add('active');
}
function closeModal() {
  $('modal').classList.remove('active');
  $('modalBody').innerHTML = '';
  clearRetLines();     // משחרר תצוגות מקדימות של תמונות חזרה
}

// ============================================================
// לשוניות
// ============================================================
const TABS = ['dash', 'orders', 'demand', 'stock', 'returns', 'profit',
              'collections', 'customers', 'invoices', 'settings'];

function renderActiveTab() {
  ({
    dash: renderDash, orders: renderOrders, demand: renderDemand, stock: renderStock,
    returns: renderReturns, profit: renderProfit, collections: renderCollections,
    customers: renderCustomers, invoices: renderInvoices, settings: renderSettings,
  })[activeTab]?.();
}

function switchTab(tab) {
  activeTab = tab;
  $$('#adminTabs .tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  TABS.forEach((t) => $(`tab-${t}`)?.classList.toggle('active', t === tab));
  renderActiveTab();
  window.scrollTo(0, 0);
}

// ============================================================
// חיווט
// ============================================================
function wire() {
  $('adminTabs').onclick = (e) => {
    const b = e.target.closest('[data-tab]');
    if (b) switchTab(b.dataset.tab);
  };

  on('refreshBtn', 'click', loadAll);
  on('goOrders', 'click', () => switchTab('orders'));
  on('accountBtn', 'click', (e) => { e.stopPropagation(); $('accountMenu').classList.toggle('open'); });
  document.addEventListener('click', () => $('accountMenu')?.classList.remove('open'));
  on('navApp', 'click', () => {
    setCustomerPreview(true);
    const previewUrl = new URL('index.html', window.location.href);
    previewUrl.searchParams.set('view', 'customer');
    window.location.assign(previewUrl.href);
  });
  on('navSignout', 'click', async () => { await sb.auth.signOut(); window.location.href = 'index.html'; });
  on('denySignout', 'click', async () => { await sb.auth.signOut(); window.location.href = 'index.html'; });

  on('stockSearch', 'input', debounce(renderStock, 200));
  on('stockCollection', 'change', renderStock);
  on('stockSortMode', 'change', (e) => { stockSortMode = e.target.checked; renderStock(); });
  on('addProductBtn', 'click', () => editProduct(null));
  on('bulkPrices', 'click', bulkPrices);
  on('bulkClear', 'click', () => { picked.clear(); renderStock(); });
  on('pickAllBtn', 'click', () => {
    const items = stockProducts();
    const all = items.length > 0 && items.every((p) => picked.has(p.id));
    for (const p of items) { if (all) picked.delete(p.id); else picked.add(p.id); }
    renderStock();
  });

  on('newReturnBtn', 'click', newReturn);
  on('newReturnStock', 'click', newReturn);
  on('exportReturns', 'click', exportReturns);

  on('profitStartSave', 'click', () => saveProfitStart($('profitStart').value || null));
  on('profitStartClear', 'click', () => {
    if (confirm('לכלול את כל ההיסטוריה בחישוב הרווח?\n\nכולל ההזמנות שיובאו מהגיליון הישן, שאין להן מחירי עלות.')) {
      saveProfitStart(null);
    }
  });

  on('addCollectionBtn', 'click', () => editCollection(null));
  on('addCustomerBtn', 'click', () => editCustomer(null));
  on('mergeCustomersBtn', 'click', () => mergeCustomers());
  on('customerSearch', 'input', debounce(renderCustomers, 200));
  on('uploadInvoiceBtn', 'click', () => uploadInvoice());
  on('invCustomer', 'change', renderInvoices);
  on('invStatus', 'change', renderInvoices);
  on('addEmailBtn', 'click', addEmail);
  on('testMailBtn', 'click', sendTestMail);
  on('testMailTo', 'keydown', (e) => { if (e.key === 'Enter') sendTestMail(); });
  on('syncShopifyBtn', 'click', syncShopify);

  on('exportOrdersFlat', 'click', exportOrdersFlat);
  on('newOrderBtn', 'click', openNewOrder);
  on('newOrderClear', 'click', openNewOrder);
  $('newOrderCustomerMode').onclick = (e) => {
    const button = e.target.closest('[data-new-order-mode]');
    if (!button) return;
    newOrderCustomerMode = button.dataset.newOrderMode;
    renderNewOrderCustomerMode();
  };
  on('newOrderCustomerSearch', 'focus', () => renderNewOrderCustomerOptions(true));
  on('newOrderCustomerSearch', 'input', () => {
    $('newOrderCustomer').value = '';
    renderNewOrderCustomerOptions(true);
  });
  on('newOrderCustomerSearch', 'blur', () => {
    setTimeout(() => closeNewOrderCustomerOptions(), 100);
  });
  on('newOrderCustomerSearch', 'keydown', (e) => {
    const list = $('newOrderCustomerList');
    const options = $$('#newOrderCustomerList [data-new-order-customer]');

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!list.classList.contains('open')) {
        renderNewOrderCustomerOptions(true);
        return;
      }
      if (!options.length) return;
      const direction = e.key === 'ArrowDown' ? 1 : -1;
      newOrderCustomerHighlight = newOrderCustomerHighlight < 0
        ? (direction > 0 ? 0 : options.length - 1)
        : (newOrderCustomerHighlight + direction + options.length) % options.length;
      updateNewOrderCustomerHighlight();
      return;
    }

    if (e.key === 'Enter' && list.classList.contains('open')) {
      const option = options[newOrderCustomerHighlight] || options[0];
      if (option) {
        e.preventDefault();
        selectNewOrderCustomer(option.dataset.newOrderCustomer);
      }
      return;
    }

    if (e.key === 'Escape') {
      e.stopPropagation();
      closeNewOrderCustomerOptions();
    }
  });
  $('newOrderCustomerList').onpointerdown = (e) => e.preventDefault();
  $('newOrderCustomerList').onclick = (e) => {
    const option = e.target.closest('[data-new-order-customer]');
    if (option) selectNewOrderCustomer(option.dataset.newOrderCustomer);
  };
  $('newOrderCollectionTabs').onclick = (e) => {
    const button = e.target.closest('[data-new-order-col]');
    if (!button) return;
    newOrderCollection = button.dataset.newOrderCol;
    $('newOrderProductSearch').value = '';
    renderNewOrderCollections();
    renderNewOrderProducts();
  };
  on('newOrderProductSearch', 'input', debounce(renderNewOrderProducts, 180));
  $('newOrderProductList').oninput = (e) => {
    const input = e.target.closest('[data-new-order-qty]');
    if (input) setNewOrderQty(input);
  };
  $('newOrderProductList').onclick = (e) => {
    const series = e.target.closest('[data-new-order-series]');
    if (series) {
      addNewOrderSeries(series.dataset.newOrderSeries);
      return;
    }

    const zoom = e.target.closest('[data-new-order-zoom]');
    if (!zoom) return;
    const product = db.products.find((p) => p.model === zoom.dataset.newOrderZoom);
    if (product?.image_url) {
      modal(`דגם ${product.model}`, imgTag(product.image_url, `דגם ${product.model}`, 900));
    }
  };
  on('newOrderSubmit', 'click', submitNewOrder);
  on('exportOrdersSum', 'click', async () => {
    const rows = orderRowsSummary();
    if (!rows.length) { toast('אין נתונים לייצוא', true); return; }
    await exportXlsx('הזמנות_מסכם', [{ name: 'הזמנות', rows }]);
    toast(`יוצאו ${fmtNum(rows.length)} הזמנות`);
  });
  on('exportDemandMatrix', 'click', async () => {
    const rows = demandRows();
    if (!rows.length) { toast('אין נתונים לייצוא', true); return; }
    await exportXlsx('ריכוז_לפי_דגם', [
      { name: 'ריכוז לפי דגם', rows },
      { name: 'פירוט לפי לקוח', rows: demandByCustomerRows() },
    ]);
    toast('הקובץ יורד — שני גיליונות');
  });

  // סינון מקומי בלשונית הריכוז
  const applyDm = () => {
    dmFilters.collection = $('dmCollection').value;
    dmFilters.model      = $('dmModel').value;
    dmFilters.status     = $('dmStatus').value;
    renderDemand();
  };
  on('dmCollection', 'change', applyDm);
  on('dmStatus', 'change', applyDm);
  on('dmModel', 'input', debounce(applyDm, 250));
  on('exportDemandSupplier', 'click', exportDemandSupplier);
  on('exportProfit', 'click', exportProfit);
  on('exportStock', 'click', async () => {
    const rows = stockRows();
    if (!rows.length) { toast('אין נתונים לייצוא', true); return; }
    await exportXlsx('מלאי', [{ name: 'מלאי', rows }]);
    toast(`יוצאו ${fmtNum(rows.length)} דגמים`);
  });
  on('exportCustomers', 'click', async () => {
    await exportXlsx('לקוחות', [{ name: 'לקוחות', rows: db.customers.map((c) => ({
      'שם': c.name, 'עסק': c.business_name || '', 'טלפון': c.phone || '', 'מייל': c.email || '',
      'עיר': c.city || '', 'הזמנות': c.orders_count, 'יחידות': c.total_units,
      'מחזור': Number(c.total_amount || 0), 'חוב פתוח': Number(c.open_balance || 0),
      'הזמנה אחרונה': c.last_order_at ? fmtDate(c.last_order_at, false) : '',
    })) }]);
    toast('הקובץ יורד…');
  });
  on('exportInvoices', 'click', async () => {
    const rows = filteredInvoices().map((v) => ({
      'מס׳ חשבונית': v.invoice_number || '', 'לקוח': v.customers?.name || '',
      'הזמנה': v.orders?.order_number || '', 'תאריך': fmtDate(v.issued_at, false),
      'סכום': Number(v.amount || 0), 'סטטוס': INVOICE_STATUS[v.status]?.label || v.status,
    }));
    if (!rows.length) { toast('אין חשבוניות לייצוא', true); return; }
    await exportXlsx('חשבוניות', [{ name: 'חשבוניות', rows }]);
    toast('הקובץ יורד…');
  });
  on('exportTop', 'click', () => exportCsv('דגמים_מובילים', demandRows()));

  // ── האזנה מרוכזת ──
  document.addEventListener('click', async (e) => {
    const close = e.target.closest('[data-close]');
    if (close) { $(close.dataset.close).classList.remove('active'); return; }
    if (e.target.closest('[data-close-modal]') || e.target.id === 'modal') { closeModal(); return; }
    if (e.target.id === 'newOrderOverlay' || e.target.id === 'orderOverlay' || e.target.id === 'customerOverlay') {
      e.target.classList.remove('active'); return;
    }

    const adv = e.target.closest('[data-adv-panel]');
    if (adv) {
      const [id, st] = adv.dataset.advPanel.split('|');
      await advanceOrder(id, st);
      return;
    }
    const delItem = e.target.closest('[data-del-item]');
    if (delItem) {
      const orderId = db.orders.find((o) => (o.order_items || [])
        .some((i) => String(i.id) === delItem.dataset.delItem))?.id;
      if (confirm('למחוק את השורה מההזמנה?')) await editItem(delItem.dataset.delItem, 0, orderId);
      return;
    }
    const em = e.target.closest('[data-export-model]');
    if (em) {
      const model = em.dataset.exportModel;
      await exportXlsx(`דגם_${model}_מי_הזמין`, [
        { name: 'פירוט לפי לקוח', rows: demandByCustomerRows(model) },
      ]);
      toast('הקובץ יורד…');
      return;
    }
    const eo = e.target.closest('[data-export-order]');
    if (eo) { await exportSingleOrder(eo.dataset.exportOrder); return; }
    const ec = e.target.closest('[data-export-cust]');
    if (ec) { await exportCustomerHistory(ec.dataset.exportCust); return; }
    const ui = e.target.closest('[data-upload-inv]');
    if (ui) { uploadInvoice(ui.dataset.uploadInv); return; }
    const uic = e.target.closest('[data-upload-inv-cust]');
    if (uic) { uploadInvoice(null, uic.dataset.uploadInvCust); return; }

    // ── פעולות מתוך פאנל ההזמנה ──
    const ap = e.target.closest('[data-archive-panel]');
    if (ap) { await setArchived(ap.dataset.archivePanel, true); return; }
    const up = e.target.closest('[data-unarchive-panel]');
    if (up) { await setArchived(up.dataset.unarchivePanel, false); return; }
    const rp = e.target.closest('[data-restore-panel]');
    if (rp) { await restoreOrder(rp.dataset.restorePanel); return; }
    const dp = e.target.closest('[data-del-order-panel]');
    if (dp) { await deleteOrder(dp.dataset.delOrderPanel); return; }

    // ── פעולות מתוך פאנל החזרה ──
    const cp = e.target.closest('[data-credit-panel]');
    if (cp) { await creditReturn(cp.dataset.creditPanel); return; }
    const drp = e.target.closest('[data-del-return-panel]');
    if (drp) { await removeReturn(drp.dataset.delReturnPanel); return; }
    const zi = e.target.closest('[data-zoom-img]');
    if (zi) {
      modal('תמונת הפריט',
        `<img src="${esc(zi.dataset.zoomImg)}" alt="תמונת הפריט שהוחזר" style="width:100%;border-radius:12px">`);
      return;
    }

    const ecst = e.target.closest('[data-edit-cust]');
    if (ecst && ecst.closest('#customerPanelBody')) { editCustomer(ecst.dataset.editCust); return; }
    const adup = e.target.closest('[data-approve-duplicate]');
    if (adup && adup.closest('#customerPanelBody')) { await reviewDuplicateCustomer(adup.dataset.approveDuplicate, true); return; }
    const rdup = e.target.closest('[data-reject-duplicate]');
    if (rdup && rdup.closest('#customerPanelBody')) { await reviewDuplicateCustomer(rdup.dataset.rejectDuplicate, false); return; }
    const mcst = e.target.closest('[data-merge-cust]');
    if (mcst && mcst.closest('#customerPanelBody')) { mergeCustomers(mcst.dataset.mergeCust); return; }
    const dcst = e.target.closest('[data-delete-cust]');
    if (dcst && dcst.closest('#customerPanelBody')) { await deleteCustomer(dcst.dataset.deleteCust); return; }
    const dl = e.target.closest('[data-dl]');
    if (dl && dl.closest('#customerPanelBody')) await downloadInvoice(dl);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    closeModal();
    $('newOrderOverlay')?.classList.remove('active');
    $('orderOverlay')?.classList.remove('active');
    $('customerOverlay')?.classList.remove('active');
  });
}

init();
