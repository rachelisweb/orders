// ============================================================
// ממשק ניהול
// ============================================================
import {
  sb, state, IS_CONFIGURED, SIZES,
  $, $$, on, esc, img, imgTag, toast, showError, fmtDate, fmtMoney, fmtNum, td, todayISO,
  friendlyError, loadProfile, sortSizes, statusChip, debounce, compressImage,
  makeSortable, exportXlsx, exportCsv, setCustomerPreview,
  ORDER_STATUS, STATUS_FLOW, RETURN_STATUS,
} from './lib.js';

const db = {
  collections: [], products: [], orders: [], customers: [],
  invoices: [], users: [], emails: [], settings: {},
  returns: [], returnItems: [], orderNotes: {}, futureCollections: [],
  demandCustomerOrders: {},
};

const filters = { from: '', to: '', collection: '', customer: '', status: '', model: '' };

let activeTab = 'dash';
let orderStatusTab = 'pending';
let archiveSearch = '';
let archiveVisible = 10;
let returnStatusTab = 'pending';
let stockSortMode = false;
const picked = new Set();     // דגמים מסומנים לעדכון מחירים מרובה
let newOrderCustomerMode = 'existing';
let newOrderCustomerHighlight = -1;
let newOrderCollection = null;
let newOrderCart = {};
let newOrderSubmitting = false;
let flexibleInvoiceRequestId = null;
let flexibleInvoicePreviewPayload = null;
const LOCAL_REVIEW = new URLSearchParams(location.search).get('review') === '1';
const MOCK_REVIEW = LOCAL_REVIEW
  && ['localhost', '127.0.0.1'].includes(location.hostname)
  && new URLSearchParams(location.search).get('mock') === '1';

// ============================================================
// אתחול
// ============================================================
async function init() {
  if (MOCK_REVIEW) {
    state.user = { id: '00000000-0000-0000-0000-000000000001', email: 'review@local.test' };
    state.profile = { full_name: 'בדיקה מקומית', email: 'review@local.test', role: 'admin' };
    state.isAdmin = true;
    $('whoName').textContent = 'בדיקה מקומית';
    $('whoMail').textContent = 'נתוני דמה בלבד';
    show('adminScreen');
    $('localReviewBanner').hidden = false;
    wire();
    loadReviewFixtures();
    return;
  }
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
  if (LOCAL_REVIEW) $('localReviewBanner').hidden = false;

  wire();
  await loadAll();
}

function loadReviewFixtures() {
  const customerA = {
    id: '10000000-0000-0000-0000-000000000001', name: 'שמואל רובניץ', business_name: 'גן וורשא',
    phone: '0528883053', email: 'customer@example.com',
    email_recipients: ['customer@example.com', 'office@example.com'], city: 'ירושלים', address: 'רחוב הדוגמה 12',
    tax_id: '515555555', discount_pct: 10, price_at_cost: false, is_active: true,
    orders_count: 16, total_units: 284, total_amount: 42860, open_balance: 1723.74,
  };
  const customerB = {
    id: '10000000-0000-0000-0000-000000000002', name: 'יעל אסייג', business_name: 'בוטיק יעל',
    phone: '0501234567', email: '', city: 'בני ברק', address: 'רבי עקיבא 10', tax_id: '204444444',
    discount_pct: 0, price_at_cost: true, is_active: true,
    orders_count: 8, total_units: 91, total_amount: 15320, open_balance: 0,
  };
  db.collections = [
    { id: '20000000-0000-0000-0000-000000000001', name: 'קולקציית קיץ', slug: 'summer', icon: '☀️', is_active: true, sort_order: 1 },
    { id: '20000000-0000-0000-0000-000000000002', name: 'קולקציית חורף', slug: 'winter', icon: '❄️', is_active: true, sort_order: 2 },
  ];
  db.products = [
    { id: '30000000-0000-0000-0000-000000000001', model: '2413B', description: 'חולצת פסים', image_url: '', collection_id: db.collections[0].id, collections: db.collections[0], wholesale_price: 200, cost_price: 118, retail_price: 399, is_active: true, stock: { S: 4, M: 6, L: 8, XL: 5, XXL: 3 }, total: 26 },
    { id: '30000000-0000-0000-0000-000000000002', model: '2420-1', description: 'שמלת מקסי מודפסת', image_url: '', collection_id: db.collections[1].id, collections: db.collections[1], wholesale_price: 260, cost_price: 145, retail_price: 520, is_active: true, stock: { S: 3, M: 5, L: 4, XL: 2, XXL: 1 }, total: 15 },
    { id: '30000000-0000-0000-0000-000000000003', model: '4036A', description: 'סריג דק', image_url: '', collection_id: db.collections[1].id, collections: db.collections[1], wholesale_price: 213, cost_price: 126, retail_price: 426, is_active: true, stock: { M: 4, L: 6, XL: 3 }, total: 13 },
  ];
  db.products.forEach((product) => { product.availableStock = { ...product.stock }; });
  const mkItems = (orderId, rows) => rows.map((r, index) => ({
    id: Number(`${String(orderId).slice(-3)}${index + 1}`), order_id: orderId,
    product_id: db.products.find((p) => p.model === r[0])?.id, model: r[0], size: r[1],
    qty: r[2], qty_ordered: r[3] ?? r[2], unit_price: r[4],
  }));
  const mkOrder = (number, status, customer, rows, daysAgo, extra = {}) => {
    const id = `40000000-0000-0000-0000-${String(number).padStart(12, '0')}`;
    const items = mkItems(id, rows);
    const subtotal = items.reduce((sum, x) => sum + x.qty * x.unit_price, 0);
    const discountValue = Number(extra.discount_value || 0);
    const discountAmount = extra.discount_type === 'pct' ? roundMoney(subtotal * discountValue / 100)
      : extra.discount_type === 'amt' ? discountValue : 0;
    return {
      id, order_number: number, customer_id: customer.id, customers: customer,
      contact_name: customer.name, phone: customer.phone, email: customer.email,
      status, created_at: new Date(Date.now() - daysAgo * 86400000).toISOString(),
      total_units: items.reduce((sum, x) => sum + x.qty, 0), subtotal_amount: subtotal,
      discount_type: extra.discount_type || null, discount_value: discountValue,
      discount_amount: discountAmount, total_amount: subtotal - discountAmount,
      stock_applied: status !== 'pending', order_items: items, notes: extra.notes || '',
      archived_at: extra.archived ? new Date(Date.now() - Math.max(daysAgo - 1, 0) * 86400000).toISOString() : null,
      future_order_at: extra.future ? new Date().toISOString() : null,
      future_order_source: extra.future ? 'manual' : null,
      pending_position: number,
      ...extra,
    };
  };
  db.orders = [
    mkOrder(121, 'pending', customerA, [['2413B', 'L', 1, 1, 200], ['2413B', 'XXL', 2, 2, 200], ['2420-1', 'M', 1, 1, 260]], 0, { checked_models: ['2413B', '2420-1'] }),
    mkOrder(120, 'ready', customerA, [['2413B', 'M', 2, 2, 200], ['2420-1', 'S', 1, 1, 260], ['4036A', 'L', 3, 3, 213]], 1, { discount_type: 'pct', discount_value: 10 }),
    mkOrder(119, 'pending', customerB, [['2420-1', 'L', 2, 2, 145], ['4036A', 'XL', 1, 1, 126]], 2, { future: true, pricing_mode: 'cost' }),
    mkOrder(118, 'shipped', customerA, [['2413B', 'S', 3, 3, 200]], 3, { archived: true }),
    mkOrder(117, 'cancelled', customerB, [['4036A', 'M', 1, 1, 126]], 4),
  ];
  for (let i = 0; i < 23; i++) {
    db.orders.push(mkOrder(116 - i, i % 2 ? 'ready' : 'shipped', i % 3 ? customerA : customerB,
      [['2413B', i % 2 ? 'M' : 'L', 1 + (i % 3), 1 + (i % 3), i % 3 ? 200 : 118]], 5 + i,
      { archived: true, pricing_mode: i % 3 ? 'wholesale' : 'cost' }));
  }
  db.customers = [customerA, customerB];
  db.invoices = [{
    id: '50000000-0000-0000-0000-000000000001', customer_id: customerA.id,
    order_id: db.orders.find((o) => o.order_number === 118).id, invoice_number: '4214',
    amount: 708, issued_at: '2026-08-05', status: 'active', source: 'icount',
    file_path: 'review/invoice-4214.pdf', file_name: 'RACHELI S invoice 4214.pdf',
    customers: { name: customerA.name },
    orders: {
      order_number: 118,
      total_amount: db.orders.find((o) => o.order_number === 118).total_amount,
    },
  }, {
    id: '50000000-0000-0000-0000-000000000002', customer_id: customerA.id,
    order_id: db.orders.find((o) => o.order_number === 120).id, invoice_number: '4215',
    amount: db.orders.find((o) => o.order_number === 120).total_amount,
    issued_at: '2026-08-08', status: 'active', source: 'icount',
    file_path: 'review/invoice-4215.pdf', file_name: 'RACHELI S invoice 4215.pdf',
    customers: { name: customerA.name },
    orders: {
      order_number: 120,
      total_amount: db.orders.find((o) => o.order_number === 120).total_amount,
    },
  }];
  db.users = [{ id: '60000000-0000-0000-0000-000000000001', customer_id: customerA.id, email: customerA.email }];
  db.emails = [];
  db.settings = { profit_start_date: '2026-08-01', brand_name: 'רחליס' };
  db.returns = [];
  db.returnItems = [];
  db.orderNotes = {};
  db.futureCollections = [{ collection_id: db.collections[1].id }];
  db.demandCustomerOrders = {};
  fillFilterOptions();
  const pending = db.orders.filter((o) => o.status === 'pending' && !o.future_order_at).length;
  $('cntOrders').textContent = pending;
  $('cntReturns').textContent = '0';
  $('headerSub').textContent = `${fmtNum(db.orders.length)} הזמנות דמה · ${pending} ממתינות · ${fmtNum(db.products.length)} דגמים`;
  renderActiveTab();
}

const roundMoney = (value) => Math.round(Number(value || 0) * 100) / 100;

function deny(msg) { $('denyMsg').textContent = msg; show('denyScreen'); }
function show(id) { ['denyScreen', 'adminScreen'].forEach((s) => $(s)?.classList.toggle('active', s === id)); }

// ============================================================
// טעינה
// ============================================================
async function loadAll() {
  $('headerSub').textContent = 'טוען…';
  try {
    const [cols, prods, available, orders, customers, customerDetails, invoices, users, emails, settings, rets, retItems, notes, futureCols, demandOrders] =
      await Promise.all([
        sb.from('collections').select('*').order('sort_order'),
        sb.from('products').select('*, inventory(size, qty), collections(name, slug, icon)').order('sort_order'),
        sb.rpc('get_available_inventory'),
        sb.from('orders')
          .select('*, order_items(id, model, size, qty, qty_ordered, unit_price, product_id), customers(name, business_name, phone, email, email_recipients)')
          .order('created_at', { ascending: false }).limit(3000),
        sb.from('v_customer_stats').select('*').order('name'),
        sb.from('customers').select('*').order('name'),
        sb.from('invoices').select('*, customers(name), orders(order_number, total_amount)').order('issued_at', { ascending: false }),
        sb.from('profiles').select('*, customers(name)').order('created_at', { ascending: false }),
        sb.from('notification_emails').select('*').order('email'),
        sb.from('app_settings').select('*'),
        sb.from('v_returns').select('*').order('return_date', { ascending: false }),
        sb.from('return_items').select('*'),
        sb.from('order_admin_notes').select('*'),
        sb.from('future_order_collections').select('*'),
        sb.from('demand_customer_orders').select('model, customer_keys'),
      ]);

    for (const r of [cols, prods, available, orders, customers, customerDetails, invoices, users, emails, settings, rets, retItems, notes, futureCols, demandOrders]) {
      if (r.error) throw r.error;
    }

    db.collections = cols.data || [];
    const availableByProduct = new Map();
    for (const row of available.data || []) {
      if (!availableByProduct.has(row.product_id)) availableByProduct.set(row.product_id, {});
      availableByProduct.get(row.product_id)[row.size] = Number(row.qty || 0);
    }
    db.products = (prods.data || []).map((p) => ({
      ...p,
      stock: Object.fromEntries((p.inventory || []).map((i) => [i.size, i.qty])),
      availableStock: availableByProduct.get(p.id) || {},
      total: (p.inventory || []).reduce((a, i) => a + i.qty, 0),
    }));
    db.orders    = orders.data || [];
    const customerStats = new Map((customers.data || []).map((c) => [c.id, c]));
    db.customers = (customerDetails.data || []).map((c) => ({ ...customerStats.get(c.id), ...c }));
    db.invoices  = invoices.data || [];
    db.users     = users.data || [];
    db.emails    = emails.data || [];
    db.settings  = Object.fromEntries((settings.data || []).map((s) => [s.key, s.value]));
    db.returns   = rets.data || [];
    db.returnItems = retItems.data || [];
    db.orderNotes  = Object.fromEntries((notes.data || []).map((n) => [n.order_id, n.notes || '']));
    db.futureCollections = futureCols.data || [];
    db.demandCustomerOrders = Object.fromEntries(
      (demandOrders.data || []).map((row) => [row.model, row.customer_keys || []]),
    );

    fillFilterOptions();

    const pending    = db.orders.filter((o) => o.status === 'pending' && !o.future_order_at).length;
    const openReturn = db.returns.filter((r) => r.status === 'pending').length;
    $('cntOrders').textContent = pending;
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
  const pending = live
    .filter((o) => o.status === 'pending' && !o.future_order_at)
    .sort((a, b) => Number(b.pending_position || 0) - Number(a.pending_position || 0));
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
            ? `<span class="row" style="gap:.35rem">
                 ${o.status === 'ready' && !hasInvoice(o.id)
                   ? `<button class="btn sm" data-generate-invoice="${o.id}">🧾 הפקה</button>` : ''}
                 <button class="btn ghost sm" data-upload-inv="${o.id}">⬆️ חשבונית</button>
                 ${o.status === 'ready' ? `<button class="btn violet sm" data-adv="${o.id}|shipped">🚚 נשלחה</button>` : ''}
               </span>`
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
    if (e.target.closest('[data-upload-inv], [data-generate-invoice]')) return;   // מטופל בהאזנה הכללית

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
  const pending = orders.filter((o) => o.status === 'pending' && !o.future_order_at && !isArchived(o)).length;
  const waitingForInvoice = db.orders.filter(isWaitingForInvoice).length;

  $('kpis').innerHTML = [
    ['הזמנות ממתינות',          fmtNum(pending),           'ממתינות לאישור',                   pending ? 'warn' : 'green'],
    ['ממתינות להעלאת חשבונית',  fmtNum(waitingForInvoice), 'מוכנות או נשלחו, ללא ארכיון',      waitingForInvoice ? 'violet' : 'green'],
    ['מחזור',                   fmtMoney(revenue),         moneyFoot,                           'green'],
    ['רווח',                    fmtMoney(revenue - cost),  cost > 0 ? moneyFoot : 'חסרים מחירי עלות', cost > 0 ? 'green' : 'warn'],
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
const latestInvoice = (orderId) => db.invoices
  .filter((v) => v.order_id === orderId && v.status !== 'cancelled')
  .sort((a, b) => new Date(b.issued_at || b.created_at) - new Date(a.issued_at || a.created_at))[0] || null;
const invoiceButton = (orderId, label = '⬇️ הורדת חשבונית') => {
  const inv = latestInvoice(orderId);
  return inv
    ? `<button class="btn ghost sm" data-dl="${esc(inv.file_path)}"
         data-name="${esc(inv.file_name || `invoice-${inv.invoice_number || orderId}.pdf`)}">${label}</button>`
    : `<button class="btn ghost sm" data-upload-inv="${orderId}">⬆️ העלאת חשבונית</button>`;
};
const isArchived = (o) => !!o.archived_at;
const canArchive = (o) => !o.archived_at && o.status !== 'pending';

// עונה הבאה יושבת לצד הארכיון, ולא לצד המשימות הממתינות.
const ORDER_BUCKETS = ['pending', ...STATUS_FLOW.slice(1), 'archive', 'future', 'cancelled'];
const BUCKET_META = {
  future:  { label: 'הזמנות לעונה הבאה', short: 'עונה הבאה', icon: '📅', color: 'blue' },
  archive: { label: 'ארכיון', short: 'ארכיון', icon: '🗄️', color: 'gray' },
};
const bucketMeta = (k) => ORDER_STATUS[k] || BUCKET_META[k];

// ── יצירת הזמנה ידנית — אותה בחירת דגמים ומידות כמו אצל לקוח ──
const orderableStock = (product) => product.availableStock ?? product.stock ?? {};
const newOrderProducts = () => db.products.filter((p) =>
  p.is_active && Object.values(orderableStock(p)).some((qty) => Number(qty) > 0));

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

const customerEmailList = (customer) => [...new Set([
  ...(Array.isArray(customer?.email_recipients) ? customer.email_recipients : []),
  customer?.email,
].map((email) => String(email || '').trim().toLowerCase()).filter(Boolean))];

function parseCustomerEmails(value) {
  const emails = [...new Set(String(value || '').split(/[\s,;]+/)
    .map((email) => email.trim().toLowerCase()).filter(Boolean))];
  const invalid = emails.filter((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
  return { emails, invalid };
}

const newOrderCustomerLabel = (customer) => customer.business_name || customer.name;

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
      || customerEmailList(c).some((email) => email.includes(q)))
    .sort((a, b) => (a.business_name || a.name).localeCompare(b.business_name || b.name, 'he'));

  const list = $('newOrderCustomerList');
  list.innerHTML = customers.length ? customers.map((c, index) => {
    const details = [c.phone, customerEmailList(c).join(', '), c.city].filter(Boolean).join(' · ');
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
    const stock = orderableStock(p);
    const sizes = Object.entries(stock)
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
              <input type="number" inputmode="numeric" pattern="[0-9]*" min="0" max="${stock[size]}"
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
  for (const [size, available] of Object.entries(orderableStock(product))) {
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

  for (const id of ['newOrderCustomerSearch', 'newOrderBusiness',
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
  const newBusinessName = newOrderCustomerMode === 'new' ? $('newOrderBusiness').value.trim() : '';
  const customer = newOrderCustomerMode === 'new' ? {
    name: newBusinessName,
    business_name: newBusinessName,
    phone: $('newOrderPhone').value.trim() || null,
    email: $('newOrderEmail').value.trim() || null,
    city: $('newOrderCity').value.trim() || null,
  } : null;

  if (newOrderCustomerMode === 'existing' && !customerId) {
    showError('newOrderError', 'יש לבחור לקוח');
    return;
  }
  if (newOrderCustomerMode === 'new' && !customer.business_name) {
    showError('newOrderError', 'יש להזין שם עסק ללקוח החדש');
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
  if (bucket === 'future') return o.status === 'pending' && !!o.future_order_at;
  if (bucket === 'pending') return o.status === 'pending' && !o.future_order_at;
  return o.status === bucket;
}

function futureFolderSettings(orderCount) {
  const selected = new Set(db.futureCollections.map((x) => x.collection_id));
  const collections = db.collections.filter((c) => c.is_active !== false);
  return `
    <div class="card" style="padding:1rem;margin-bottom:1rem">
      <div class="row" style="align-items:flex-start">
        <div class="grow">
          <div class="bold">📅 הגדרה אוטומטית לפי קולקציות</div>
          <div class="small muted" style="margin-top:.25rem">
            הזמנה ממתינה שכל הפריטים בה שייכים לקולקציות המסומנות תועבר לכאן אוטומטית.
            הזמנה מעורבת תישאר ברשימת הממתינות.
          </div>
        </div>
        <button class="btn success sm" id="releaseFutureOrders" ${orderCount ? '' : 'disabled'}>
          החזרת כל ההזמנות לממתינות
        </button>
      </div>
      <div id="futureCollectionsBox" class="row" style="flex-wrap:wrap;gap:.8rem 1.2rem;margin:.9rem 0">
        ${collections.length ? collections.map((c) => `
          <label class="row small" style="gap:.4rem;cursor:pointer">
            <input type="checkbox" data-future-collection="${c.id}" ${selected.has(c.id) ? 'checked' : ''}>
            <span>${esc(c.icon || '')} ${esc(c.name)}</span>
          </label>`).join('') : '<span class="small muted">אין קולקציות פעילות לבחירה.</span>'}
      </div>
      <div class="row">
        <button class="btn sm" id="futureCollectionsSave">שמירת הקולקציות</button>
        <span class="small muted">החזרת כל ההזמנות גם מנקה את בחירת הקולקציות, כדי שהן לא יועברו שוב אוטומטית.</span>
      </div>
    </div>`;
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
    archiveSearch = '';
    archiveVisible = 10;
    renderOrders();
  };

  let orders = all.filter((o) => inBucket(o, orderStatusTab));
  if (orderStatusTab === 'pending') {
    orders = orders.sort((a, b) =>
      Number(b.pending_position || 0) - Number(a.pending_position || 0)
      || new Date(b.created_at) - new Date(a.created_at));
  } else if (orderStatusTab === 'future') {
    orders = orders.sort((a, b) => new Date(b.future_order_at || b.created_at) - new Date(a.future_order_at || a.created_at));
  } else if (orderStatusTab === 'archive') {
    orders = orders.sort((a, b) => new Date(b.archived_at || b.created_at) - new Date(a.archived_at || a.created_at));
  }

  const meta = bucketMeta(orderStatusTab);
  const futureView = orderStatusTab === 'future';
  if (!orders.length && !futureView && orderStatusTab !== 'archive') {
    $('ordersTable').innerHTML =
      `<div class="empty"><div class="ico">${meta.icon}</div>
       אין הזמנות ב"${esc(meta.label)}"</div>`;
    return;
  }

  const archiveView   = orderStatusTab === 'archive';
  const cancelledView = orderStatusTab === 'cancelled';
  const pendingView   = orderStatusTab === 'pending';
  const archivable    = orders.filter(canArchive);

  if (archiveView && archiveSearch) {
    const q = archiveSearch.trim().toLowerCase();
    orders = orders.filter((o) => {
      const iso = String(o.created_at || '').slice(0, 10);
      const dmy = iso ? iso.split('-').reverse().join('.') : '';
      return [o.order_number, o.contact_name, o.customers?.name, o.customers?.business_name, iso, dmy]
        .some((v) => String(v || '').toLowerCase().includes(q));
    });
  }
  const archiveTotal = orders.length;
  const visibleOrders = archiveView ? orders.slice(0, archiveVisible) : orders.slice(0, 400);

  const rowActions = (o, next, nInv) => {
    if (cancelledView) {
      return `<button class="btn ghost sm" data-restore="${o.id}">↩️ שחזור</button>
              <button class="btn danger sm" data-del-order="${o.id}">🗑️ מחיקה</button>`;
    }
    if (archiveView) {
      return `${invoiceButton(o.id)}
              ${o.status === 'shipped' ? `<button class="btn ghost sm" data-resend-shipped="${o.id}">✉️ שליחה מחדש</button>` : ''}
              <button class="btn ghost sm" data-unarchive="${o.id}">↩️ מהארכיון</button>`;
    }
    if (futureView) {
      return `<button class="btn ghost sm" data-future-order="${o.id}|false">↩️ החזרה לממתינות</button>`;
    }
    const parts = [];
    if (pendingView) {
      parts.push(`<button class="btn ghost sm" data-move-pending="${o.id}|up" title="הזזה למעלה">↑</button>`);
      parts.push(`<button class="btn ghost sm" data-move-pending="${o.id}|down" title="הזזה למטה">↓</button>`);
    }
    if (next) {
      parts.push(`<button class="btn ${next === 'ready' ? 'success' : next === 'shipped' ? 'violet' : ''} sm"
        data-adv="${o.id}|${next}">${ORDER_STATUS[next].icon} ${esc(ORDER_STATUS[next].label)}</button>`);
    }
    if (pendingView) {
      parts.push(`<button class="btn ghost sm future-order-btn" data-future-order="${o.id}|true">📅 לעונה הבאה</button>`);
    }
    if (o.status === 'ready' && !nInv) {
      parts.push(`<button class="btn ghost sm" data-generate-invoice="${o.id}">🧾 הפקת חשבונית</button>`);
    }
    if (['ready', 'shipped'].includes(o.status)) {
      parts.push(invoiceButton(o.id, nInv ? '⬇️ חשבונית' : '⬆️ חשבונית'));
    }
    if (canArchive(o)) {
      parts.push(`<button class="btn ghost sm" data-archive="${o.id}" title="העברה לארכיון">🗄️</button>`);
    }
    return parts.length ? `<span class="row" style="gap:.3rem">${parts.join(' ')}</span>` : '';
  };

  $('ordersTable').innerHTML = `
    ${futureView ? futureFolderSettings(orders.length) : ''}
    ${archiveView ? `<div class="archive-tools">
       <div class="note small">ההזמנות שסיימו טיפול. ניתן לפתוח ולהוריד חשבוניות גם מכאן.</div>
       <input type="search" id="archiveSearch" value="${esc(archiveSearch)}"
         placeholder="🔍 חיפוש לפי מספר הזמנה, שם לקוח או תאריך" aria-label="חיפוש בארכיון">
     </div>` : ''}
    ${cancelledView ? `<div class="note small">
       <b>שחזור</b> מחזיר את ההזמנה למצב "ממתינה". <b>מחיקה</b> היא לצמיתות —
       החשבוניות יישמרו אבל יאבדו את השיוך להזמנה.</div>` : ''}
    ${archivable.length && !archiveView && !cancelledView ? `<div class="row" style="margin-bottom:.7rem">
       <button class="btn ghost sm" id="archiveBucket">🗄️ העבר את כל ${fmtNum(archivable.length)} ההזמנות בלשונית לארכיון</button>
     </div>` : ''}
    ${!orders.length ? `<div class="empty"><div class="ico">${meta.icon}</div>
       ${archiveSearch ? 'לא נמצאו הזמנות התואמות לחיפוש' : `אין הזמנות ב"${esc(meta.label)}"`}</div>` : `<div class="table-wrap"><table class="responsive"><thead><tr>
      <th>#</th><th>לקוח</th><th>תאריך</th><th class="num">יח׳</th>
      <th class="num">סכום</th>${archiveView ? '<th>סטטוס</th>' : ''}<th class="num">🧾</th><th></th>
    </tr></thead><tbody>
    ${visibleOrders.map((o) => {
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
    </tbody></table></div>`}
    ${archiveView && archiveVisible < archiveTotal ? `<div class="center" style="margin-top:.8rem">
      <button class="btn ghost sm" id="archiveMore">הצגת 10 הזמנות ישנות יותר</button>
      <div class="small faint" style="margin-top:.35rem">מוצגות ${fmtNum(visibleOrders.length)} מתוך ${fmtNum(archiveTotal)}</div>
    </div>` : ''}
    ${!archiveView && orders.length > 400 ? `<div class="small faint center" style="margin-top:.7rem">
      מוצגות 400 מתוך ${fmtNum(orders.length)} — צמצם את הסינון או ייצא</div>` : ''}`;

  on('archiveSearch', 'input', debounce((e) => {
    archiveSearch = e.target.value;
    archiveVisible = 10;
    renderOrders();
    $('archiveSearch')?.focus();
  }, 180));
  on('archiveMore', 'click', () => { archiveVisible += 10; renderOrders(); });

  on('archiveBucket', 'click', async () => {
    if (!confirm(`להעביר ${archivable.length} הזמנות לארכיון?\n\nאפשר להחזיר אותן משם בכל רגע.`)) return;
    try {
      const { data, error } = await sb.rpc('archive_orders', { p_ids: archivable.map((o) => o.id) });
      if (error) throw error;
      toast(`${fmtNum(data?.archived ?? 0)} הזמנות הועברו לארכיון`);
      await loadAll();
    } catch (err) { toast(friendlyError(err), true); }
  });

  on('futureCollectionsSave', 'click', saveFutureCollections);
  on('releaseFutureOrders', 'click', releaseFutureOrders);

  $('ordersTable').onclick = async (e) => {
    const future = e.target.closest('[data-future-order]');
    if (future) {
      e.stopPropagation();
      const [id, enabled] = future.dataset.futureOrder.split('|');
      await setOrderFuture(id, enabled === 'true');
      return;
    }
    const move = e.target.closest('[data-move-pending]');
    if (move) {
      e.stopPropagation();
      const [id, direction] = move.dataset.movePending.split('|');
      await movePendingOrder(id, direction);
      return;
    }
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
    const invDl = e.target.closest('[data-dl]');
    if (invDl) { e.stopPropagation(); await downloadInvoice(invDl); return; }
    const gen = e.target.closest('[data-generate-invoice]');
    if (gen) { e.stopPropagation(); openIcountInvoicePreview(gen.dataset.generateInvoice); return; }
    const resend = e.target.closest('[data-resend-shipped]');
    if (resend) { e.stopPropagation(); await resendShipmentEmail(resend.dataset.resendShipped); return; }
    if (e.target.closest('[data-upload-inv]')) return;    // מטופל בהאזנה הכללית

    const row = e.target.closest('[data-order]');
    if (row) openOrder(row.dataset.order);
  };
}

async function saveFutureCollections() {
  const button = $('futureCollectionsSave');
  const ids = $$('#futureCollectionsBox [data-future-collection]:checked')
    .map((input) => input.dataset.futureCollection);
  if (button) button.disabled = true;
  try {
    const { data, error } = await sb.rpc('set_future_order_collections', { p_collection_ids: ids });
    if (error) throw error;
    toast(`נשמרו ${fmtNum(data?.collections ?? ids.length)} קולקציות · ${fmtNum(data?.future_orders ?? 0)} הזמנות בתיקייה`);
    orderStatusTab = 'future';
    await loadAll();
  } catch (err) {
    toast(friendlyError(err), true);
    if (button) button.disabled = false;
  }
}

async function releaseFutureOrders() {
  const count = db.orders.filter((o) => o.status === 'pending' && o.future_order_at && !isArchived(o)).length;
  if (!count) return;
  if (!confirm(`להחזיר את כל ${count} ההזמנות לרשימת הממתינות?\n\nגם בחירת הקולקציות האוטומטית תנוקה.`)) return;
  try {
    const { data, error } = await sb.rpc('release_future_orders');
    if (error) throw error;
    toast(`${fmtNum(data?.released ?? count)} הזמנות חזרו לממתינות`);
    orderStatusTab = 'pending';
    await loadAll();
  } catch (err) { toast(friendlyError(err), true); }
}

async function setOrderFuture(id, future) {
  const order = db.orders.find((o) => o.id === id);
  if (future && !confirm(`להעביר את הזמנה #${order?.order_number} לתיקיית "הזמנות לעונה הבאה"?`)) return;
  try {
    const { error } = await sb.rpc('set_order_future', { p_order_id: id, p_future: future });
    if (error) throw error;
    toast(future
      ? `הזמנה #${order?.order_number} הועברה לעונה הבאה`
      : `הזמנה #${order?.order_number} חזרה לממתינות`);
    $('orderOverlay').classList.remove('active');
    orderStatusTab = future ? 'future' : 'pending';
    await loadAll();
  } catch (err) { toast(friendlyError(err), true); }
}

async function movePendingOrder(id, direction) {
  try {
    const { data, error } = await sb.rpc('move_pending_order', { p_order_id: id, p_direction: direction });
    if (error) throw error;
    if (!data?.moved) toast(direction === 'up' ? 'ההזמנה כבר בראש הרשימה' : 'ההזמנה כבר בסוף הרשימה');
    await loadAll();
  } catch (err) { toast(friendlyError(err), true); }
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
      const models = [...new Set((o?.order_items || []).map((item) => item.model))];
      const checked = new Set(o?.checked_models || []);
      const missingChecks = models.filter((model) => !checked.has(model));
      if (missingChecks.length) {
        if (!confirm(`לא סימנת את כל הדגמים בווי.\n\nהאם שמת את כל הדגמים?\n\nאישור = כן · ביטול = לא`)) return;
      } else if (!confirm(`לסמן הזמנה #${o?.order_number} כ"${label}"?\n\nהמלאי יירד ב-${fmtNum(o?.total_units)} יחידות.`)) return;
    } else if (!confirm(`לסמן הזמנה #${o?.order_number} כ"${label}"?`)) return;
  }

  try {
    const { data, error } = await sb.rpc('set_order_status', { p_order_id: id, p_status: status });
    if (error) throw error;

    if (data?.missing?.length) toast(`עודכן, אך ${data.missing.length} שורות לא נמצאו במלאי`, true);
    else toast(status === 'shipped' ? 'ההזמנה סומנה כנשלחה והועברה לארכיון' : `ההזמנה סומנה כ"${label}"`);

    if (status === 'shipped') {
      const mail = await notifyOrder(id, 'shipped');
      if (mail?.error) toast(`ההזמנה נשמרה בארכיון, אך המייל לא נשלח: ${mail.error}`, true);
      else if (mail?.warnings?.length) toast(mail.warnings.join(' · '), true);
      else if (mail?.sent?.length) toast('מייל המשלוח נשלח ללקוח');
    }
    $('orderOverlay').classList.remove('active');
    await loadAll();
  } catch (err) {
    toast(friendlyError(err), true);
  }
}

async function notifyOrder(orderId, event) {
  try {
    const { data, error } = await sb.functions.invoke('order-email', { body: { order_id: orderId, event } });
    if (error) throw error;
    if (data?.ok === false) throw new Error(data.error || 'שליחת המייל נכשלה');
    return data || { ok: true };
  } catch (err) {
    console.warn('order-email failed', err);
    return { ok: false, error: friendlyError(err) };
  }
}

async function resendShipmentEmail(orderId) {
  const order = db.orders.find((o) => o.id === orderId);
  if (!confirm(`לשלוח מחדש את מייל המשלוח להזמנה #${order?.order_number}?\n\nאם קיימת חשבונית היא תצורף למייל.`)) return;
  const result = await notifyOrder(orderId, 'shipped');
  if (result?.error) toast(`המייל לא נשלח: ${result.error}`, true);
  else if (result?.warnings?.length && !result?.sent?.length) toast(result.warnings.join(' · '), true);
  else toast(`מייל המשלוח נשלח${result?.warnings?.length ? ` · ${result.warnings.join(' · ')}` : ''}`);
}

function groupOrderItemsByModel(lines) {
  const groups = new Map();
  for (const line of lines) {
    if (!groups.has(line.model)) groups.set(line.model, { model: line.model, lines: [] });
    groups.get(line.model).lines.push(line);
  }
  return [...groups.values()];
}

function renderAdminOrderItems(groups, editable, anyShort, checkedModels = [], orderId = '') {
  const checked = new Set(checkedModels || []);
  return `<div class="admin-order-models">
    ${groups.map((group) => {
      const product = productByModel(group.model);
      const units = group.lines.reduce((sum, line) => sum + Number(line.qty || 0), 0);
      const isChecked = checked.has(group.model);
      return `<div class="admin-order-model ${isChecked ? 'model-checked' : ''}">
        ${editable ? `<button class="model-check ${isChecked ? 'checked' : ''}"
          data-model-check="${orderId}|${esc(group.model)}" aria-pressed="${isChecked}"
          aria-label="${isChecked ? 'בטל סימון' : 'סמן'} דגם ${esc(group.model)}">${isChecked ? '✓' : ''}</button>` : ''}
        <div class="admin-order-model-image">
          ${product?.image_url
            ? `<img src="${esc(img(product.image_url, 180))}" alt="דגם ${esc(group.model)}" loading="lazy" decoding="async">`
            : '<div class="img-ph">📷</div>'}
        </div>
        <div class="admin-order-model-name">
          <div class="bold">${esc(group.model)}</div>
          <div class="small muted">${fmtNum(units)} יח׳</div>
        </div>
        <div class="admin-order-sizes">
          ${group.lines.map((line) => {
            const ordered = line.qty_ordered ?? line.qty;
            const short = ordered !== line.qty;
            return `<div class="admin-order-size ${short ? 'short' : ''}">
              <span class="admin-order-size-label">${esc(line.size)}</span>
              <div class="admin-order-size-qty">
                ${anyShort ? `<span class="small ${short ? 'qty-diff' : 'muted'}">הוזמן ${fmtNum(ordered)}</span>` : ''}
                ${editable
                  ? `<input type="number" min="0" value="${line.qty}" data-item="${line.id}"
                       aria-label="כמות דגם ${esc(line.model)} מידה ${esc(line.size)}">`
                  : `<b>${anyShort ? 'סופק ' : '×'}${fmtNum(line.qty)}</b>`}
              </div>
            </div>`;
          }).join('')}
        </div>
      </div>`;
    }).join('')}
  </div>`;
}

function openOrder(id) {
  const o = db.orders.find((x) => x.id === id);
  if (!o) return;

  const lines = (o.order_items || []).slice()
    .sort((a, b) => a.model.localeCompare(b.model, 'he') || sortSizes(a.size, b.size));
  const itemGroups = groupOrderItemsByModel(lines);
  const invs = db.invoices.filter((v) => v.order_id === o.id);
  const editable = o.status === 'pending' && !o.stock_applied;
  const isFuture = o.status === 'pending' && !!o.future_order_at;
  // ההנחה נקבעת רק כשידוע מה באמת יוצא ללקוח
  const canDiscount = ['ready', 'shipped'].includes(o.status);
  // הוזמן מול סופק — רלוונטי רק אם המנהל שינה כמויות לפני השליחה
  const anyShort = lines.some((l) => (l.qty_ordered ?? l.qty) !== l.qty);
  const sub = Number(o.subtotal_amount || o.total_amount || 0);

  $('orderPanelTitle').textContent = `הזמנה #${o.order_number}`;
  $('orderPanelBody').innerHTML = `
    <div class="row" style="margin-bottom:.9rem">
      ${statusChip(ORDER_STATUS, o.status)}
      ${isFuture ? `<span class="chip blue">📅 עונה הבאה${o.future_order_source === 'automatic' ? ' · אוטומטי' : ''}</span>` : ''}
      ${isArchived(o) ? '<span class="chip gray">🗄️ בארכיון</span>' : ''}
      <span class="muted small">${fmtDate(o.created_at)}</span>
    </div>

    <div class="card" style="padding:.8rem;margin-bottom:.9rem">
      <div class="grid-2 small">
        <div><span class="muted">שם העסק:</span> <b>${esc(o.customers?.business_name || o.customers?.name || o.contact_name || '—')}</b></div>
        <div><span class="muted">טלפון:</span> ${(o.phone || o.customers?.phone) ? `<a href="tel:${esc(o.phone || o.customers.phone)}">${esc(o.phone || o.customers.phone)}</a>` : '—'}</div>
        <div><span class="muted">מיילים:</span> ${customerEmailList(o.customers).length
          ? customerEmailList(o.customers).map((email) => `<a href="mailto:${esc(email)}">${esc(email)}</a>`).join(' · ')
          : (o.email ? `<a href="mailto:${esc(o.email)}">${esc(o.email)}</a>` : '—')}</div>
        <div><span class="muted">יחידות:</span> <b>${fmtNum(o.total_units)}</b></div>
        <div class="order-payment-summary">
          <div><span class="muted">לתשלום:</span>
            ${o.status === 'ready'
              ? `<span class="inline-payable"><input type="number" id="payableTotal" min="0" max="${sub}" step="0.01"
                    inputmode="decimal" value="${Number(o.total_amount || 0).toFixed(2)}" aria-label="סכום לתשלום">
                   <button class="btn sm" id="payableSave">שמירה</button></span>`
              : `<b>${o.total_amount > 0 ? fmtMoney(o.total_amount) : '—'}</b>`}
          </div>
          <div><span class="muted">סה״כ כולל מע״מ:</span> <b>${fmtMoney(Number(o.total_amount || 0) * 1.18)}</b></div>
        </div>
      </div>
      ${o.discount_amount > 0 ? `<div class="small" style="margin-top:.5rem">
        <span class="muted">לפני הנחה:</span> ${fmtMoney(sub)} ·
        <span class="muted">הנחה:</span> <b style="color:var(--success)">−${fmtMoney(o.discount_amount)}</b>
        ${o.discount_type === 'pct' ? ` <span class="chip green">${o.discount_value}%</span>` : ''}
      </div>` : ''}
      ${o.notes ? `<div class="small" style="margin-top:.5rem"><span class="muted">הערת לקוח:</span> ${esc(o.notes)}</div>` : ''}
    </div>

    <div class="order-invoice-actions row">
      ${o.status === 'ready' && !invs.length
        ? `<button class="btn sm" data-generate-invoice="${o.id}">🧾 הפקת חשבונית</button>` : ''}
      ${invoiceButton(o.id)}
    </div>

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
    : ''}

    <h4 class="bold" style="margin-bottom:.5rem">📝 הערת מנהל</h4>
    <div class="note small">גלויה למנהלים בלבד. הלקוח לא רואה אותה.</div>
    <div class="field">
      <textarea id="admNotes" rows="2"
        placeholder="לדוגמה: תיאמנו איסוף ליום ג׳, חסר דגם 2420 במידה L…">${esc(db.orderNotes[o.id] || '')}</textarea>
    </div>
    <button class="btn ghost sm" id="admNotesSave" style="margin-bottom:1.1rem">שמירת ההערה</button>

    <h4 class="bold" style="margin-bottom:.5rem">פריטים (${itemGroups.length} דגמים · ${lines.length} מידות)</h4>
    ${!editable ? '<div class="note small">🔒 ההזמנה נעולה לעריכה — המלאי כבר עודכן.</div>' : ''}
    ${anyShort ? '<div class="note warn small">⚠️ בשורות המסומנות הכמות שסופקה שונה ממה שהלקוח הזמין. הלקוח רואה את שתי הכמויות באזור האישי.</div>' : ''}

    ${renderAdminOrderItems(itemGroups, editable, anyShort, o.checked_models, o.id)}

    ${editable ? `<button class="btn ghost block add-order-model-btn" data-add-order-model="${o.id}">➕ הוספת דגם להזמנה</button>` : ''}

    <h4 class="bold" style="margin-bottom:.5rem">חשבוניות (${invs.length})</h4>
    ${invs.length
      ? invs.map((v) => `<div class="row small" style="padding:.4rem 0;border-bottom:1px solid var(--border)">
          <button class="invoice-file-link" data-dl="${esc(v.file_path)}"
            data-name="${esc(v.file_name || `invoice-${v.invoice_number || o.order_number}.pdf`)}">
            ${esc(v.invoice_number || v.file_name || '—')}</button>
          <span class="grow"></span>
          <span>${v.amount != null ? fmtMoney(v.amount) : ''}</span>
        </div>`).join('')
      : '<div class="small muted">טרם הועלתה חשבונית</div>'}
  `;

  const next = ORDER_STATUS[o.status].next;
  $('orderPanelFoot').innerHTML = `
    <div class="row">
      ${next && !isFuture ? `<button class="btn ${next === 'ready' ? 'success' : next === 'shipped' ? 'violet' : ''}"
        data-adv-panel="${o.id}|${next}">${ORDER_STATUS[next].icon} ${esc(ORDER_STATUS[next].label)}</button>` : ''}
      ${o.status === 'pending' ? (isFuture
        ? `<button class="btn ghost sm" data-future-panel="${o.id}|false">↩️ החזרה לממתינות</button>`
        : `<button class="btn ghost sm" data-future-panel="${o.id}|true">📅 לעונה הבאה</button>`) : ''}
      ${canArchive(o) ? `<button class="btn ghost sm" data-archive-panel="${o.id}">🗄️ לארכיון</button>` : ''}
      ${isArchived(o) ? `<button class="btn ghost sm" data-unarchive-panel="${o.id}">↩️ מהארכיון</button>` : ''}
      <button class="btn ghost sm" data-export-order="${o.id}">⬇️ ייצוא</button>
      <span class="grow"></span>
      ${o.status === 'cancelled'
        ? `<button class="btn ghost sm" data-restore-panel="${o.id}">↩️ שחזור</button>
           <button class="btn danger sm" data-del-order-panel="${o.id}">🗑️ מחיקה</button>`
        : (!isArchived(o) && ['pending', 'ready'].includes(o.status)
          ? `<button class="btn danger sm" data-adv-panel="${o.id}|cancelled">ביטול</button>` : '')}
      ${o.status === 'shipped' ? `<button class="btn ghost sm" data-resend-shipped="${o.id}">✉️ שליחת מייל מחדש</button>` : ''}
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

  on('payableSave', 'click', async () => {
    const desired = Number($('payableTotal').value);
    if (!Number.isFinite(desired) || desired < 0 || desired > sub) {
      toast(`הסכום חייב להיות בין 0 ל-${fmtMoney(sub)}`, true); return;
    }
    const btn = $('payableSave');
    btn.disabled = true;
    try {
      const discount = Math.round((sub - desired) * 100) / 100;
      const { data, error } = await sb.rpc('set_order_discount', {
        p_order_id: o.id, p_type: discount > 0 ? 'amt' : null, p_value: discount,
      });
      if (error) throw error;
      toast(`הסכום לתשלום נשמר: ${fmtMoney(data.total)}`);
      await loadAll();
      openOrder(o.id);
    } catch (err) { toast(friendlyError(err), true); btn.disabled = false; }
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
    toast(qty > 0 ? 'הכמות עודכנה' : 'הכמות נשמרה כ־0');

    await loadAll();
    if (data?.lines_left > 0) openOrder(orderId);
    else { $('orderOverlay').classList.remove('active'); toast('ההזמנה נותרה ללא פריטים', true); }
  } catch (err) {
    toast(friendlyError(err), true);
    openOrder(orderId);
  }
}

async function toggleOrderModelCheck(orderId, model, checked) {
  try {
    const { error } = await sb.rpc('set_order_model_checked', {
      p_order_id: orderId, p_model: model, p_checked: checked,
    });
    if (error) throw error;
    const order = db.orders.find((item) => item.id === orderId);
    if (order) {
      const values = new Set(order.checked_models || []);
      if (checked) values.add(model); else values.delete(model);
      order.checked_models = [...values];
    }
    openOrder(orderId);
  } catch (error) {
    toast(friendlyError(error), true);
  }
}

function openAddOrderModel(orderId) {
  const order = db.orders.find((item) => item.id === orderId);
  if (!order || order.status !== 'pending' || order.stock_applied) {
    toast('ניתן להוסיף דגמים רק להזמנה ממתינה', true);
    return;
  }

  modal(`הוספת דגם להזמנה #${order.order_number}`, `
    <div class="note small">הקלד מספר דגם, בחר כמויות ולחץ על הוספה. הכמות מתווספת לכמות שכבר קיימת בהזמנה.</div>
    <div class="field"><label for="addOrderModelSearch">חיפוש דגם</label>
      <input type="search" id="addOrderModelSearch" autocomplete="off" placeholder="לדוגמה: 2420"></div>
    <div id="addOrderModelResults"><div class="empty"><div class="ico">🔍</div>הקלד מספר דגם לחיפוש</div></div>
    <div class="err-msg" id="addOrderModelError"></div>
    <button class="btn block lg" id="addOrderModelSave" disabled>הוספה להזמנה</button>
  `, true);

  const render = () => {
    const q = $('addOrderModelSearch').value.trim().toLowerCase();
    const products = q ? db.products.filter((product) => product.is_active !== false
      && (product.model.toLowerCase().includes(q) || (product.description || '').toLowerCase().includes(q)))
      .slice(0, 20) : [];
    $('addOrderModelResults').innerHTML = products.length ? products.map((product) => {
      const sizes = Object.entries(orderableStock(product)).filter(([, qty]) => Number(qty) > 0)
        .sort(([a], [b]) => sortSizes(a, b));
      if (!sizes.length) return '';
      return `<div class="product add-order-product">
        <div class="product-img">${imgTag(product.image_url, `דגם ${product.model}`, 240)}</div>
        <div class="product-body">
          <div class="product-title">דגם ${esc(product.model)}</div>
          ${product.description ? `<div class="product-desc">${esc(product.description)}</div>` : ''}
          <div class="sizes">${sizes.map(([size, available]) => `<label class="size">
            <span class="lbl">${esc(size)}</span>
            <input type="number" min="0" max="${available}" inputmode="numeric" placeholder="0"
              data-add-order-qty="${esc(product.model)}|${esc(size)}" aria-label="דגם ${esc(product.model)} מידה ${esc(size)}">
          </label>`).join('')}</div>
        </div>
      </div>`;
    }).join('') : q
      ? '<div class="empty"><div class="ico">🔍</div>לא נמצאו דגמים זמינים</div>'
      : '<div class="empty"><div class="ico">🔍</div>הקלד מספר דגם לחיפוש</div>';
    $('addOrderModelSave').disabled = true;
  };

  $('addOrderModelSearch').oninput = debounce(render, 150);
  $('addOrderModelResults').oninput = (event) => {
    const input = event.target.closest('[data-add-order-qty]');
    if (!input) return;
    const max = Number(input.max) || 0;
    let qty = parseInt(input.value, 10);
    if (!Number.isFinite(qty) || qty < 0) qty = 0;
    if (qty > max) qty = max;
    input.value = qty || '';
    input.classList.toggle('on', qty > 0);
    $('addOrderModelSave').disabled = !$$('#addOrderModelResults [data-add-order-qty]')
      .some((item) => Number(item.value) > 0);
  };
  on('addOrderModelSave', 'click', async () => {
    const items = $$('#addOrderModelResults [data-add-order-qty]').map((input) => {
      const [model, size] = input.dataset.addOrderQty.split('|');
      return { model, size, qty: Number(input.value) || 0 };
    }).filter((item) => item.qty > 0);
    if (!items.length) return;
    const button = $('addOrderModelSave');
    button.disabled = true;
    button.textContent = 'מוסיף להזמנה…';
    try {
      const { data, error } = await sb.rpc('admin_add_order_items', { p_order_id: orderId, p_items: items });
      if (error) throw error;
      closeModal();
      toast(`נוספו ${fmtNum(data.added_units)} יחידות להזמנה`);
      await loadAll();
      openOrder(orderId);
    } catch (error) {
      showError('addOrderModelError', friendlyError(error));
      button.disabled = false;
      button.textContent = 'הוספה להזמנה';
    }
  });
  requestAnimationFrame(() => $('addOrderModelSearch').focus());
}

// ============================================================
// ריכוז לפי דגם
// ============================================================
// סינון ייעודי ללשונית הריכוז
const dmFilters = { collection: '', model: '', status: '', includeArchived: false };

function demandItems() {
  const q = dmFilters.model.trim().toLowerCase();
  return filteredItems().filter((it) => {
    if (!dmFilters.includeArchived && isArchived(it.order)) return false;
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

// גרירה בהחזקה קצרה. לפני ההפעלה תנועת אצבע רגילה עדיין גוללת את הפאנל;
// אחרי ההחזקה התנועה מסדרת את השורות ומונעת גלילה מקרית.
function makeLongPressSortable(container, onDrop, delay = 320) {
  if (!container) return;

  let pressed = null;
  let active = false;
  let timer = null;
  let startX = 0;
  let startY = 0;
  let orderBefore = '';
  let lastTouchAt = 0;

  const directRows = () => $$('[data-sort-key]', container)
    .filter((row) => row.parentElement === container);
  const ids = () => directRows().map((row) => row.dataset.sortKey);
  const rowAt = (target) => {
    const row = target?.closest?.('[data-sort-key]');
    return row?.parentElement === container ? row : null;
  };
  const clearTimer = () => { if (timer) clearTimeout(timer); timer = null; };

  const begin = () => {
    if (!pressed) return;
    active = true;
    orderBefore = ids().join('\n');
    pressed.classList.add('dragging');
    container.classList.add('longpress-sort-active');
    if (navigator.vibrate) navigator.vibrate(15);
    toast('מצב סידור פעיל — גרור את השורה למקום הרצוי');
  };

  const start = (row, x, y, immediate = false) => {
    clearTimer();
    pressed = row;
    active = false;
    startX = x;
    startY = y;
    if (immediate) begin();
    else timer = setTimeout(begin, delay);
  };

  const cancelBeforeActivation = () => {
    clearTimer();
    pressed = null;
  };

  const move = (x, y, event) => {
    if (!pressed) return;
    if (!active) {
      if (Math.hypot(x - startX, y - startY) > 10) cancelBeforeActivation();
      return;
    }

    event.preventDefault();
    const over = rowAt(document.elementFromPoint(x, y));
    if (over && over !== pressed) {
      const rect = over.getBoundingClientRect();
      const after = y > rect.top + rect.height / 2;
      container.insertBefore(pressed, after ? over.nextSibling : over);
    }

    const scroller = container.closest('.panel-body');
    if (scroller) {
      const rect = scroller.getBoundingClientRect();
      if (y < rect.top + 54) scroller.scrollTop -= 14;
      else if (y > rect.bottom - 54) scroller.scrollTop += 14;
    }
  };

  const finish = async () => {
    clearTimer();
    if (!pressed) return;
    const dragged = pressed;
    const changed = active && ids().join('\n') !== orderBefore;
    pressed = null;
    active = false;
    dragged.classList.remove('dragging');
    container.classList.remove('longpress-sort-active');
    if (changed) await onDrop(ids());
  };

  container.addEventListener('touchstart', (event) => {
    if (event.touches.length !== 1) return;
    const row = rowAt(event.target);
    if (!row) return;
    lastTouchAt = Date.now();
    const touch = event.touches[0];
    start(row, touch.clientX, touch.clientY, Boolean(event.target.closest('.demand-row-grip')));
  }, { passive: true });
  container.addEventListener('touchmove', (event) => {
    if (event.touches.length !== 1) return;
    const touch = event.touches[0];
    move(touch.clientX, touch.clientY, event);
  }, { passive: false });
  container.addEventListener('touchend', finish);
  container.addEventListener('touchcancel', finish);

  const mouseMove = (event) => move(event.clientX, event.clientY, event);
  const mouseUp = async () => {
    window.removeEventListener('mousemove', mouseMove);
    window.removeEventListener('mouseup', mouseUp);
    await finish();
  };
  container.addEventListener('mousedown', (event) => {
    if (event.button !== 0 || Date.now() - lastTouchAt < 700) return;
    const row = rowAt(event.target);
    if (!row) return;
    start(row, event.clientX, event.clientY, Boolean(event.target.closest('.demand-row-grip')));
    window.addEventListener('mousemove', mouseMove, { passive: false });
    window.addEventListener('mouseup', mouseUp);
  });
  container.addEventListener('contextmenu', (event) => {
    if (active) event.preventDefault();
  });
}

function sortDemandCustomerRows(model, rows) {
  const saved = db.demandCustomerOrders[model] || [];
  const positions = new Map(saved.map((key, index) => [key, index]));
  return [...rows].sort((a, b) => {
    const aPos = positions.get(a.customer_key);
    const bPos = positions.get(b.customer_key);
    if (aPos !== undefined || bPos !== undefined) {
      if (aPos === undefined) return 1;
      if (bPos === undefined) return -1;
      return aPos - bPos;
    }
    return b.total - a.total || a.customer.localeCompare(b.customer, 'he');
  });
}

async function saveDemandCustomerOrder(model, customerKeys) {
  const previous = db.demandCustomerOrders[model] || [];
  db.demandCustomerOrders[model] = [...customerKeys];
  try {
    if (!MOCK_REVIEW) {
      const { error } = await sb.rpc('set_demand_customer_order', {
        p_model: model,
        p_customer_keys: customerKeys,
      });
      if (error) throw error;
    }
    toast('סדר הלקוחות נשמר');
  } catch (err) {
    db.demandCustomerOrders[model] = previous;
    toast(friendlyError(err), true);
    openDemandDetail(model);
  }
}

async function toggleDemandModelChecks(model, orderIds, checked) {
  const orders = orderIds.map((id) => db.orders.find((order) => order.id === id)).filter(Boolean);
  if (!orders.length) {
    toast('לא נמצאו הזמנות ממתינות לסימון', true);
    return;
  }

  try {
    const { data, error } = await sb.rpc('set_orders_model_checked', {
      p_order_ids: orders.map((order) => order.id),
      p_model: model,
      p_checked: checked,
    });
    if (error) throw error;

    for (const order of orders) {
      const values = new Set(order.checked_models || []);
      if (checked) values.add(model); else values.delete(model);
      order.checked_models = [...values];
    }

    toast(`${checked ? 'הדגם סומן' : 'הסימון הוסר'} ב-${fmtNum(data?.updated || orders.length)} הזמנות`);
    openDemandDetail(model);
  } catch (err) {
    toast(friendlyError(err), true);
    openDemandDetail(model);
  }
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
        order_id: o.id,
        order_number: o.order_number,
        customer_key: o.customer_id || `name:${o.customers?.business_name || o.customers?.name || o.contact_name || '—'}`,
        customer: o.customers?.business_name || o.customers?.name || o.contact_name || '—',
        date: o.created_at,
        status: o.status,
        model_checkable: o.status === 'pending' && !o.stock_applied,
        model_checked: (o.checked_models || []).includes(model),
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
    let e = byCust.get(r.customer_key);
    if (!e) {
      e = {
        customer_key: r.customer_key, customer: r.customer, orders: 0,
        sizes: {}, total: 0, amount: 0, checkable_order_ids: [], checked_order_ids: [],
      };
      byCust.set(r.customer_key, e);
    }
    e.orders++;
    if (r.model_checkable) {
      e.checkable_order_ids.push(r.order_id);
      if (r.model_checked) e.checked_order_ids.push(r.order_id);
    }
    for (const [s, q] of Object.entries(r.sizes)) e.sizes[s] = (e.sizes[s] || 0) + q;
    e.total += r.total;
    e.amount += r.amount;
  }
  const custRows = sortDemandCustomerRows(model, [...byCust.values()]);

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

    <div class="row" style="justify-content:space-between;margin-bottom:.5rem">
      <h4 class="bold">לפי לקוח (${custRows.length})</h4>
      <span class="small muted demand-sort-hint">⠿ לחיצה ארוכה וגרירה לשינוי הסדר</span>
    </div>
    <div class="table-wrap" style="margin-bottom:1.2rem">
      <table class="responsive demand-customer-table"><thead><tr>
        <th>לקוח</th><th class="num">הזמנות</th>
        ${cols.map((s) => `<th class="num">${esc(s)}</th>`).join('')}
        <th class="num">סה״כ</th><th class="num">שווי</th>
      </tr></thead><tbody id="demandCustomerRows">
      ${custRows.map((r) => {
        const allChecked = r.checkable_order_ids.length > 0
          && r.checked_order_ids.length === r.checkable_order_ids.length;
        const partlyChecked = r.checked_order_ids.length > 0 && !allChecked;
        const checkLabel = allChecked ? 'הסר סימון דגם' : 'סמן דגם';
        const check = r.checkable_order_ids.length ? `<button type="button"
          class="demand-model-check ${allChecked ? 'checked' : ''} ${partlyChecked ? 'partial' : ''}"
          data-demand-model-check="${esc(model)}"
          data-order-ids="${r.checkable_order_ids.join(',')}"
          data-next-checked="${!allChecked}"
          role="checkbox" aria-checked="${partlyChecked ? 'mixed' : allChecked}"
          aria-label="${checkLabel} ${esc(model)} בהזמנות של ${esc(r.customer)}"
          title="${checkLabel} בתוך ${r.checkable_order_ids.length === 1 ? 'ההזמנה' : `${r.checkable_order_ids.length} ההזמנות`}">${allChecked ? '✓' : partlyChecked ? '—' : ''}</button>` : '';
        return `<tr class="${allChecked ? 'models-checked' : partlyChecked ? 'models-partial' : ''}"
          data-sort-key="${esc(r.customer_key)}" title="לחיצה ארוכה וגרירה לשינוי הסדר">
        ${td('לקוח', `<span class="demand-customer-main"><span class="demand-row-grip" aria-hidden="true">⠿</span>${check}<span>${esc(r.customer)}</span></span>`, 'bold')}
        ${td('הזמנות', r.orders, 'num')}
        ${cols.map((s) => td(s, r.sizes[s] || '<span class="faint">·</span>', 'num')).join('')}
        ${td('סה״כ', fmtNum(r.total), 'num bold')}
        ${td('שווי', r.amount > 0 ? fmtMoney(r.amount) : '—', 'num')}
      </tr>`; }).join('')}
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
  makeLongPressSortable($('demandCustomerRows'), (customerKeys) => saveDemandCustomerOrder(model, customerKeys));
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

  $('demandTable').innerHTML = `
    <div class="demand-mobile-summary">
      <span><b>${fmtNum(rows.length)}</b> דגמים</span>
      <span><b>${fmtNum(grand)}</b> יחידות</span>
      <span><b>${fmtMoney(rows.reduce((a, r) => a + r.amount, 0))}</b></span>
    </div>
    <div class="table-wrap demand-matrix-wrap"><table class="demand-matrix"><thead><tr>
      <th></th><th>דגם</th><th>קולקציה</th>
      ${cols.map((s) => `<th class="num">${esc(s)}</th>`).join('')}
      <th class="num">סה״כ</th><th class="num">לקוחות</th><th class="num">שווי</th><th></th>
    </tr></thead><tbody>
    ${rows.map((r) => `<tr class="clickable" data-dm="${esc(r.model)}">
      <td class="dm-image">${r.image ? `<img class="thumb" style="width:32px;height:32px" src="${esc(img(r.image, 80))}" alt="" loading="lazy" decoding="async">` : ''}</td>
      <td class="bold dm-model">${esc(r.model)}</td>
      <td class="muted small dm-collection">${esc(r.collection)}</td>
      ${cols.map((s) => `<td class="num dm-size" data-size="${esc(s)}">${r.sizes[s] || '<span class="faint">·</span>'}</td>`).join('')}
      <td class="num bold dm-total">${fmtNum(r.total)}</td>
      <td class="num dm-customers" data-label="הזמנות">${r.orders.size}</td>
      <td class="num dm-value" data-label="שווי">${r.amount > 0 ? fmtMoney(r.amount) : '—'}</td>
      <td class="num dm-open"><span class="faint">👁️ <span class="dm-open-label">פירוט</span></span></td>
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
  const cost    = items.reduce((a, i) => a + lineCost(i), 0);
  const profit  = revenue - cost;
  const margin  = revenue > 0 ? (profit / revenue * 100) : 0;
  const units   = items.reduce((a, i) => a + i.qty, 0);

  $('profitKpis').innerHTML = [
    ['מחזור', fmtMoney(revenue), '', 'accent'],
    ['עלות',  fmtMoney(cost),    noCost ? 'חלקי' : 'מלא', 'warn'],
    ['רווח',  fmtMoney(profit),  `${margin.toFixed(1)}% מרווח`, profit > 0 ? 'green' : 'red'],
    ['יחידות', fmtNum(units),    '', 'accent'],
  ].map(([l, v, f, c]) => `<div class="kpi ${c}">
      <div class="label">${esc(l)}</div>
      <div class="value ${String(v).length > 8 ? 'sm' : ''}">${esc(v)}</div>
      ${f ? `<div class="foot">${esc(f)}</div>` : ''}</div>`).join('');

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
          ${td('חודש', `<button class="table-link" data-profit-month="${esc(m.month)}">${esc(monthName(m.month))}</button>`, 'bold nowrap')}
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

  $('profitMonthly').onclick = (e) => {
    const month = e.target.closest('[data-profit-month]');
    if (month) openProfitMonth(month.dataset.profitMonth, monthName(month.dataset.profitMonth));
  };

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

function openProfitMonth(monthKey, title) {
  const groups = new Map();
  for (const it of profitItems()) {
    const d = new Date(it.order.created_at);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (key !== monthKey) continue;

    const customerId = it.order.customer_id || '';
    const groupKey = customerId || `unlinked:${it.order.contact_name || it.order.id}`;
    const customer = db.customers.find((c) => c.id === customerId);
    const row = groups.get(groupKey) || {
      customerId,
      name: customer?.business_name || customer?.name || it.order.contact_name || 'ללא שם',
      orders: new Set(), units: 0, revenue: 0,
    };
    row.orders.add(it.order.id);
    row.units += Number(it.qty || 0);
    row.revenue += lineNet(it);
    groups.set(groupKey, row);
  }

  const rows = [...groups.values()].sort((a, b) => b.revenue - a.revenue || a.name.localeCompare(b.name, 'he'));
  modal(`לקוחות שהזמינו ב${title}`, rows.length
    ? `<div class="note small">לחיצה על לקוח תפתח את הכרטיס שלו ואת פירוט ההזמנות.</div>
       <div class="table-wrap"><table class="responsive"><thead><tr>
         <th>שם העסק</th><th class="num">הזמנות</th><th class="num">יחידות</th><th class="num">מחזור</th>
       </tr></thead><tbody>
       ${rows.map((r) => `<tr ${r.customerId ? `class="clickable" data-month-customer="${r.customerId}"` : ''}>
         ${td('שם העסק', r.customerId
           ? `<button class="table-link" data-month-customer="${r.customerId}">${esc(r.name)}</button>`
           : esc(r.name), 'bold')}
         ${td('הזמנות', fmtNum(r.orders.size), 'num')}
         ${td('יחידות', fmtNum(r.units), 'num')}
         ${td('מחזור', fmtMoney(r.revenue), 'num')}
       </tr>`).join('')}
       </tbody></table></div>`
    : '<div class="empty">אין לקוחות בחודש זה</div>', true);

  $('modalBody').onclick = (e) => {
    const customer = e.target.closest('[data-month-customer]');
    if (!customer) return;
    closeModal();
    openCustomer(customer.dataset.monthCustomer);
  };
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

function renderStockCollectionTabs() {
  const box = $('stockCollectionTabs');
  if (!box) return;
  const selected = $('stockCollection').value;
  const tabs = [
    { id: '', name: 'כל הקולקציות', icon: '🗂️', count: db.products.length },
    ...db.collections.map((c) => ({
      id: c.id, name: c.name, icon: c.icon || '📁',
      count: db.products.filter((p) => p.collection_id === c.id).length,
    })),
  ];
  box.innerHTML = tabs.map((tab) => `
    <button class="tab ${tab.id === selected ? 'active' : ''}" data-stock-collection="${tab.id}">
      ${esc(tab.icon)} ${esc(tab.name)} <span class="tab-count">${fmtNum(tab.count)}</span>
    </button>`).join('');
  box.onclick = (e) => {
    const button = e.target.closest('[data-stock-collection]');
    if (!button) return;
    $('stockCollection').value = button.dataset.stockCollection;
    renderStock();
  };
}

function renderStock() {
  const items = stockProducts();
  const box = $('stockList');
  $('sortHint').style.display = stockSortMode ? 'block' : 'none';
  renderStockCollectionTabs();

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

  box.className = 'stock-cards';
  const allPicked = items.length > 0 && items.every((p) => picked.has(p.id));
  $('pickAllBtn').textContent = allPicked ? '☐ ניקוי הבחירה' : '☑️ בחר את כל המוצגים';
  box.innerHTML = items.map((p) => `
    <div class="product stock-product" data-product="${p.id}">
      <div class="product-img" data-stock-zoom="${p.id}">
        ${imgTag(p.image_url, 'דגם ' + p.model, 320)}
        ${p.image_url ? '<span class="zoom" aria-hidden="true">🔍</span>' : ''}
      </div>
      <div class="product-body">
        <div class="product-top stock-product-top">
          <div>
            <div class="product-title">דגם ${esc(p.model)}</div>
            <div class="small muted">${esc(p.collections?.name || '')} · <b data-stock-total="${p.id}">${fmtNum(p.total)}</b> יח׳</div>
          </div>
          <div class="row stock-product-actions">
            <label class="row small stock-pick" title="בחירת הדגם לעדכון מחירים">
              <input type="checkbox" data-pick="${p.id}" ${picked.has(p.id) ? 'checked' : ''}
                aria-label="בחירת דגם ${esc(p.model)}"> בחירה
            </label>
            <button class="btn ghost sm" data-edit="${p.id}">✏️ עריכה</button>
          </div>
        </div>
        ${p.description ? `<div class="product-desc">${esc(p.description)}</div>` : ''}
        <div class="sizes stock-sizes">
          ${SIZES.map((s) => {
            const qty = Number(p.stock[s] || 0);
            return `<label class="size">
              <span class="lbl">${esc(s)}</span>
              <input type="number" inputmode="numeric" min="0" value="${qty}"
                class="${qty > 0 ? 'on' : ''}" data-stock="${p.id}|${s}"
                aria-label="דגם ${esc(p.model)} מידה ${esc(s)}">
            </label>`;
          }).join('')}
        </div>
        <div class="stock-product-meta">
          <span><span class="muted">עלות:</span> ${p.cost_price > 0 ? fmtMoney(p.cost_price) : '<span class="chip amber">חסר</span>'}</span>
          <span><span class="muted">סיטונאי:</span> ${p.wholesale_price > 0 ? fmtMoney(p.wholesale_price) : '—'}</span>
          <span><span class="muted">קמעונאי:</span> ${p.retail_price > 0 ? fmtMoney(p.retail_price) : '—'}</span>
          <label class="row small stock-active"><input type="checkbox" ${p.is_active ? 'checked' : ''}
            data-active="${p.id}" aria-label="הצג דגם ${esc(p.model)}"> מוצג בקטלוג</label>
        </div>
      </div>
    </div>`).join('');

  box.onchange = async (e) => {
    const pk = e.target.closest('[data-pick]');
    if (pk) {
      if (pk.checked) picked.add(pk.dataset.pick); else picked.delete(pk.dataset.pick);
      updateBulkBar();
      return;
    }
    const st = e.target.closest('[data-stock]');
    if (st) { await saveStock(st); return; }
    const ac = e.target.closest('[data-active]');
    if (ac) await saveActive(ac);
  };
  box.onclick = (e) => {
    const zoom = e.target.closest('[data-stock-zoom]');
    if (zoom) {
      const product = db.products.find((p) => p.id === zoom.dataset.stockZoom);
      if (product?.image_url) modal(`דגם ${product.model}`, imgTag(product.image_url, `דגם ${product.model}`, 900));
      return;
    }
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
      inp.classList.toggle('on', qty > 0);
      const total = document.querySelector(`[data-stock-total="${pid}"]`);
      if (total) total.textContent = fmtNum(p.total);
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
    <th>שם העסק</th><th>טלפון</th><th class="num">הזמנות</th>
    <th class="num">יח׳</th><th class="num">מחזור</th><th>אחרונה</th><th></th>
    </tr></thead><tbody>
    ${items.map((c) => `<tr class="clickable" data-customer="${c.id}">
      ${td('שם העסק', `${esc(c.business_name || c.name)}${c.duplicate_status === 'pending'
        ? `<div class="chip amber" style="margin-top:.25rem">חשד לכפול של ${esc(c.duplicate_candidate_business || c.duplicate_candidate_name || 'לקוח קיים')}</div>`
        : c.duplicate_status === 'rejected'
          ? '<div class="chip green" style="margin-top:.25rem">נבדק — לא כפול</div>'
          : ''}`, 'bold')}
      ${td('טלפון', c.phone ? `<a href="tel:${esc(c.phone)}">${esc(c.phone)}</a>` : '—', 'small nowrap')}
      ${td('הזמנות', fmtNum(c.orders_count), 'num')}
      ${td('יחידות', fmtNum(c.total_units), 'num')}
      ${td('מחזור', c.total_amount > 0 ? fmtMoney(c.total_amount) : '—', 'num')}
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

  $('customerPanelTitle').textContent = c.business_name || c.name;
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

    <div class="kpis" style="grid-template-columns:repeat(3,1fr)">
      <div class="kpi accent"><div class="label">הזמנות</div><div class="value">${fmtNum(c.orders_count)}</div></div>
      <div class="kpi accent"><div class="label">יחידות</div><div class="value">${fmtNum(c.total_units)}</div></div>
      <div class="kpi green"><div class="label">מחזור</div><div class="value sm">${fmtMoney(c.total_amount)}</div></div>
    </div>

    <div class="card" style="padding:.8rem">
      <div class="grid-2 small">
        <div><span class="muted">שם העסק:</span> <b>${esc(c.business_name || c.name)}</b></div>
        <div><span class="muted">טלפון:</span> ${c.phone ? `<a href="tel:${esc(c.phone)}">${esc(c.phone)}</a>` : '—'}</div>
        <div><span class="muted">מיילים:</span> ${esc(customerEmailList(c).join(', ') || '—')}</div>
        <div><span class="muted">עיר:</span> ${esc(c.city || '—')}</div>
      </div>
      <div class="small" style="margin-top:.5rem">
        <span class="muted">משתמשים:</span>
        ${users.length ? users.map((u) => esc(u.email)).join(', ')
                       : '<span class="chip amber">אין — הלקוח לא יכול להתחבר</span>'}
      </div>
      <div class="customer-settings-summary">
        <span class="bold">⚙️ הגדרות לקוח</span>
        ${c.price_at_cost
          ? '<span class="chip violet">מחיר עלות · ללא הנחה קבועה</span>'
          : c.discount_pct > 0
            ? `<span class="chip green">הנחה קבועה ${fmtNum(c.discount_pct)}%</span>`
            : '<span class="chip gray">מחיר סיטונאי רגיל</span>'}
        <button class="btn ghost sm" data-edit-cust="${c.id}">עריכת הגדרות</button>
      </div>
    </div>

    <h4 class="bold" style="margin:.9rem 0 .5rem">דגמים מובילים</h4>
    ${topModels.length
      ? `<div class="lines-wrap">${topModels.map(([m, q]) => `<span class="tag">${esc(m)}: ${fmtNum(q)}</span>`).join('')}</div>`
      : '<div class="small muted">אין הזמנות</div>'}

    <h4 class="bold" style="margin:1rem 0 .5rem">הזמנות (${orders.length})</h4>
    ${orders.length ? `<div class="table-wrap"><table class="responsive"><thead><tr>
      <th>#</th><th>תאריך</th><th class="num">יח׳</th><th class="num">סכום</th><th>סטטוס</th></tr></thead><tbody>
      ${orders.slice(0, 50).map((o) => `<tr class="clickable" data-customer-order="${o.id}">
        ${td('הזמנה', '#' + o.order_number, 'bold')}
        ${td('תאריך', fmtDate(o.created_at, false), 'small nowrap')}
        ${td('יחידות', fmtNum(o.total_units), 'num')}
        ${td('סכום', o.total_amount > 0 ? fmtMoney(o.total_amount) : '—', 'num')}
        ${td('סטטוס', statusChip(ORDER_STATUS, o.status))}
      </tr>`).join('')}</tbody></table></div>` : '<div class="small muted">אין הזמנות</div>'}

    <h4 class="bold" style="margin:1rem 0 .5rem">חשבוניות (${invs.length})</h4>
    ${invs.length ? `<div class="table-wrap"><table class="responsive"><thead><tr>
      <th>מס׳</th><th>תאריך</th><th class="num">סכום</th><th></th></tr></thead><tbody>
      ${invs.map((v) => `<tr>
        ${td('מס׳', esc(v.invoice_number || '—'), 'bold')}
        ${td('תאריך', fmtDate(v.issued_at, false), 'small nowrap')}
        ${td('סכום', v.amount != null ? fmtMoney(v.amount) : '—', 'num')}
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
  const currentEmails = customerEmailList(c);

  modal(c ? `עריכת ${c.business_name || c.name}` : 'לקוח חדש', `
    <div class="field"><label>שם העסק <span class="req">*</span></label>
      <input type="text" id="uBiz" autocomplete="organization" value="${esc(c?.business_name || c?.name || '')}"></div>
    <div class="grid-2">
      <div class="field"><label>טלפון</label>
        <input type="tel" id="uPhone" inputmode="tel" value="${esc(c?.phone || '')}"></div>
      <div class="field"><label>כתובות מייל להתראות וחשבוניות</label>
        <textarea id="uEmails" rows="2" inputmode="email" placeholder="mail@example.com, office@example.com">${esc(currentEmails.join('\n'))}</textarea>
        <div class="hint">אפשר להזין כמה כתובות, כל אחת בשורה נפרדת או מופרדת בפסיק.</div></div>
    </div>
    <div class="grid-2">
      <div class="field"><label>עיר</label><input type="text" id="uCity" value="${esc(c?.city || '')}"></div>
      <div class="field"><label>ח.פ / ע.מ</label><input type="text" id="uTax" value="${esc(c?.tax_id || '')}"></div>
    </div>
    <div class="grid-2">
      <div class="field"><label>כתובת</label><input type="text" id="uAddr" value="${esc(c?.address || '')}"></div>
      <div class="field"><label>הנחה קבועה (%)</label>
        <input type="number" id="uDisc" min="0" max="100" step="0.5" inputmode="decimal" value="${c?.discount_pct ?? 0}"
          ${c?.price_at_cost ? 'disabled' : ''}></div>
    </div>
    <label class="setting-check">
      <input type="checkbox" id="uPriceAtCost" ${c?.price_at_cost ? 'checked' : ''}>
      <span><b>מחיר עלות</b><small>מחיר הלקוח יהיה מחיר העלות של הדגם, ללא ההנחה הקבועה.</small></span>
    </label>
    <div class="field"><label>הערות</label><textarea id="uNotes" rows="2">${esc(c?.notes || '')}</textarea></div>
    <button class="btn block lg" id="uSave">שמירה</button>
  `);

  on('uPriceAtCost', 'change', () => {
    const enabled = $('uPriceAtCost').checked;
    $('uDisc').disabled = enabled;
    if (enabled) $('uDisc').value = '0';
  });

  on('uSave', 'click', async () => {
    const businessName = $('uBiz').value.trim();
    if (!businessName) { toast('חסר שם עסק', true); return; }
    const { emails, invalid } = parseCustomerEmails($('uEmails').value);
    if (invalid.length) { toast(`כתובת מייל לא תקינה: ${invalid[0]}`, true); return; }
    const rec = {
      name:           businessName,
      business_name:  businessName,
      phone:         $('uPhone').value.trim() || null,
      email:          emails[0] || null,
      email_recipients: emails,
      city:          $('uCity').value.trim()  || null,
      tax_id:        $('uTax').value.trim()   || null,
      address:       $('uAddr').value.trim()  || null,
      price_at_cost: $('uPriceAtCost').checked,
      discount_pct:  $('uPriceAtCost').checked ? 0 : (Number($('uDisc').value) || 0),
      notes:         $('uNotes').value.trim() || null,
    };
    if (c && (rec.business_name || '').toLowerCase() !== (c.business_name || '').toLowerCase()) {
      rec.duplicate_candidate_id = null;
      rec.duplicate_status = null;
    }
    $('uSave').disabled = true;
    try {
      const { data, error } = c
        ? await sb.rpc('admin_update_customer', { p_customer_id: c.id, p_data: rec })
        : await sb.from('customers').insert(rec);
      if (error) throw error;
      const repriced = Number(data?.repriced_orders || 0);
      toast(c
        ? `הלקוח עודכן${repriced ? ` · התמחור עודכן ב-${fmtNum(repriced)} הזמנות פתוחות` : ''}`
        : 'הלקוח נוסף');
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
// הפקת חשבונית iCount — תצוגה מקדימה מקומית ואישור מפורש
// המחירים במערכת הם לפני מע"מ; iCount מוסיף 18%.
// ============================================================
function endOfMonthISO(date = new Date()) {
  const last = new Date(date.getFullYear(), date.getMonth() + 1, 0);
  return `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, '0')}-${String(last.getDate()).padStart(2, '0')}`;
}

function buildInvoicePreview(order) {
  const grouped = new Map();
  for (const item of order.order_items || []) {
    if (Number(item.qty || 0) <= 0) continue;
    // מחיר הוא חלק מהמפתח כדי ששתי שורות מאותו דגם במחירים שונים לא יאוחדו בטעות.
    const key = `${item.model}\u0000${Number(item.unit_price || 0).toFixed(2)}`;
    const product = productByModel(item.model);
    if (!grouped.has(key)) grouped.set(key, {
      model: item.model,
      description: product?.description || '',
      quantity: 0,
      unit_price: Number(item.unit_price || 0),
    });
    grouped.get(key).quantity += Number(item.qty || 0);
  }
  const items = [...grouped.values()];
  const subtotal = Math.round(items.reduce((sum, x) => sum + x.quantity * x.unit_price, 0) * 100) / 100;
  const discount = Math.min(Math.max(Number(order.discount_amount || 0), 0), subtotal);
  const beforeVat = Math.round((subtotal - discount) * 100) / 100;
  const vat = Math.round(beforeVat * 18) / 100;
  return { items, subtotal, discount, beforeVat, vat, total: Math.round((beforeVat + vat) * 100) / 100 };
}

function openIcountInvoicePreview(orderId) {
  const order = db.orders.find((o) => o.id === orderId);
  if (!order) return;
  if (order.status !== 'ready') { toast('ניתן להפיק חשבונית רק להזמנה שמוכנה לאיסוף', true); return; }
  if (latestInvoice(order.id)) { toast('כבר קיימת חשבונית להזמנה — ניתן להוריד אותה', true); return; }

  const customer = db.customers.find((c) => c.id === order.customer_id);
  const p = buildInvoicePreview(order);
  const clientName = customer?.business_name || customer?.name || order.contact_name || '';
  const date = todayISO();
  const paydate = endOfMonthISO(new Date(`${date}T12:00:00`));
  const blockers = [];
  const warnings = [];
  if (!clientName) blockers.push('חסר שם לקוח לחשבונית');
  if (!p.items.length) blockers.push('אין פריטים שניתן לחייב');
  if (p.items.some((x) => x.unit_price <= 0)) blockers.push('יש דגם שמחירו 0 — יש לתקן לפני ההפקה');
  if (!customer?.tax_id) warnings.push('לא הוזן ח.פ / ע.מ בכרטיס הלקוח');
  if (!customer?.address) warnings.push('לא הוזנה כתובת בכרטיס הלקוח');

  modal(`תצוגה מקדימה — חשבונית להזמנה #${order.order_number}`, `
    <div class="invoice-preview">
      <div class="invoice-preview-head">
        <div><span class="muted small">לקוח</span><b>${esc(clientName || '—')}</b></div>
        <div><span class="muted small">ח.פ / ע.מ</span><b>${esc(customer?.tax_id || '—')}</b></div>
        <div><span class="muted small">תאריך הפקה</span><b>${fmtDate(date, false)}</b></div>
        <div><span class="muted small">לתשלום עד</span><b>${fmtDate(paydate, false)} · סוף החודש</b></div>
      </div>
      ${blockers.length ? `<div class="note danger-note small"><b>לא ניתן להפיק:</b> ${blockers.map(esc).join(' · ')}</div>` : ''}
      ${warnings.length ? `<div class="note warn small"><b>יש לבדוק:</b> ${warnings.map(esc).join(' · ')}</div>` : ''}
      <div class="table-wrap"><table><thead><tr>
        <th>דגם ופירוט</th><th class="num">כמות</th><th class="num">מחיר לפני מע״מ</th><th class="num">סה״כ</th>
      </tr></thead><tbody>
        ${p.items.map((x) => `<tr>
          <td><b>${esc(x.model)}</b>${x.description ? `<div class="small muted">${esc(x.description)}</div>` : ''}</td>
          <td class="num">${fmtNum(x.quantity)}</td>
          <td class="num">${fmtMoney(x.unit_price)}</td>
          <td class="num">${fmtMoney(x.quantity * x.unit_price)}</td>
        </tr>`).join('')}
      </tbody></table></div>
      <div class="invoice-totals">
        <span>סה״כ לפני הנחה</span><b>${fmtMoney(p.subtotal)}</b>
        ${p.discount > 0 ? `<span>הנחה</span><b>−${fmtMoney(p.discount)}</b>` : ''}
        <span>לפני מע״מ</span><b>${fmtMoney(p.beforeVat)}</b>
        <span>מע״מ 18%</span><b>${fmtMoney(p.vat)}</b>
        <span class="invoice-grand">סה״כ כולל מע״מ</span><b class="invoice-grand">${fmtMoney(p.total)}</b>
      </div>
      <div class="note small">iCount לא ישלח מייל. החשבונית תישמר בהזמנה ותצורף אוטומטית למייל כאשר ההזמנה תסומן כנשלחה.</div>
      ${location.hostname === 'localhost' || location.hostname === '127.0.0.1'
        ? '<div class="note small">🧪 תצוגה מקומית: לא תופק חשבונית בלי פונקציית השרת והמפתח הסודי.</div>' : ''}
      <label class="setting-check invoice-confirm">
        <input type="checkbox" id="icountConfirm" ${blockers.length ? 'disabled' : ''}>
        <span><b>בדקתי את הלקוח, הפריטים והסכומים</b><small>לאחר האישור תופק חשבונית מקור ב-iCount. לא ניתן למחוק אותה כאילו לא הופקה.</small></span>
      </label>
      <div class="err-msg" id="icountError"></div>
      <button class="btn block lg" id="icountCreate" disabled>אישור והפקת חשבונית</button>
    </div>
  `, true);

  on('icountConfirm', 'change', () => { $('icountCreate').disabled = !$('icountConfirm').checked || blockers.length > 0; });
  on('icountCreate', 'click', async () => {
    if (!$('icountConfirm').checked) return;
    const btn = $('icountCreate');
    const errorBox = $('icountError');
    btn.disabled = true;
    btn.textContent = 'מפיק ושומר… אין לסגור';
    errorBox.classList.remove('show');
    try {
      const { data, error } = await sb.functions.invoke('icount-invoice', {
        body: { action: 'create', order_id: order.id, doc_date: date, paydate },
      });
      if (error) throw error;
      if (!data?.ok) throw new Error(data?.error || 'הפקת החשבונית נכשלה');
      toast(`חשבונית ${data.invoice_number || ''} הופקה ונשמרה בהזמנה`);
      closeModal();
      await loadAll();
      openOrder(order.id);
    } catch (err) {
      errorBox.textContent = friendlyError(err);
      errorBox.classList.add('show');
      btn.disabled = false;
      btn.textContent = 'ניסיון חוזר';
    }
  });
}

// ============================================================
// חשבוניות
// ============================================================
const flexibleInvoiceCustomerLabel = (customer) => customer.business_name || customer.name;

function renderFlexibleInvoiceCustomers(open = true) {
  const search = $('flexInvoiceCustomerSearch');
  const list = $('flexInvoiceCustomerList');
  if (!search || !list) return;
  const q = search.value.trim().toLowerCase();
  const selected = $('flexInvoiceCustomerId').value;
  const customers = db.customers
    .filter((c) => c.is_active !== false)
    .filter((c) => !q
      || flexibleInvoiceCustomerLabel(c).toLowerCase().includes(q)
      || (c.phone || '').includes(q)
      || (c.email || '').toLowerCase().includes(q)
      || (c.tax_id || '').includes(q))
    .sort((a, b) => flexibleInvoiceCustomerLabel(a).localeCompare(flexibleInvoiceCustomerLabel(b), 'he'));
  list.innerHTML = customers.length ? customers.map((customer) => `
    <button type="button" class="customer-option ${customer.id === selected ? 'selected' : ''}"
            role="option" data-flex-invoice-customer="${customer.id}">
      <span class="customer-option-title">${esc(flexibleInvoiceCustomerLabel(customer))}</span>
      <span class="customer-option-details">${esc([customer.phone, customer.email, customer.tax_id].filter(Boolean).join(' · '))}</span>
    </button>`).join('') : '<div class="customer-option-empty">לא נמצאו לקוחות מתאימים</div>';
  list.classList.toggle('open', open);
  search.setAttribute('aria-expanded', String(open));
}

function selectFlexibleInvoiceCustomer(customerId) {
  const customer = db.customers.find((c) => c.id === customerId);
  if (!customer) return;
  $('flexInvoiceCustomerId').value = customer.id;
  $('flexInvoiceCustomerSearch').value = flexibleInvoiceCustomerLabel(customer);
  $('flexInvoiceClientName').value = customer.business_name || customer.name || '';
  $('flexInvoiceTaxId').value = customer.tax_id || '';
  $('flexInvoiceEmail').value = customer.email || '';
  $('flexInvoiceAddress').value = [customer.address, customer.city].filter(Boolean).join(', ');
  $('flexInvoiceCustomerList').classList.remove('open');
  $('flexInvoiceCustomerSearch').setAttribute('aria-expanded', 'false');
  invalidateFlexibleInvoicePreview();
}

function flexibleInvoiceLineHtml(seed = {}) {
  return `<div class="flex-invoice-line">
    <div class="field flex-model-field"><label>דגם / מק״ט</label>
      <input type="text" data-flex-model list="flexInvoiceModels" value="${esc(seed.sku || '')}" placeholder="לדוגמה 2420-1">
    </div>
    <div class="field flex-description-field"><label>פירוט הפריט</label>
      <input type="text" data-flex-description value="${esc(seed.description || '')}" placeholder="תיאור שיופיע בחשבונית">
    </div>
    <div class="field"><label>כמות</label>
      <input type="number" data-flex-quantity min="0.01" step="0.01" inputmode="decimal" value="${seed.quantity || 1}">
    </div>
    <div class="field"><label>מחיר ליחידה לפני מע״מ</label>
      <input type="number" data-flex-unit-price min="0.01" step="0.01" inputmode="decimal" value="${seed.unitprice || ''}" placeholder="0.00">
    </div>
    <button type="button" class="btn danger sm flex-line-remove" data-flex-remove-line aria-label="הסרת פריט">🗑️</button>
  </div>`;
}

function addFlexibleInvoiceLine(seed = {}) {
  $('flexInvoiceLines').insertAdjacentHTML('beforeend', flexibleInvoiceLineHtml(seed));
  invalidateFlexibleInvoicePreview();
}

function invalidateFlexibleInvoicePreview() {
  flexibleInvoicePreviewPayload = null;
  const preview = $('flexInvoicePreview');
  if (preview) preview.innerHTML = '';
}

function collectFlexibleInvoice() {
  const customerId = $('flexInvoiceCustomerId').value;
  if (!customerId || !db.customers.some((c) => c.id === customerId)) throw new Error('יש לבחור לקוח מהרשימה');
  const clientName = $('flexInvoiceClientName').value.trim();
  if (!clientName) throw new Error('חסר שם לקוח לחשבונית');
  const items = $$('#flexInvoiceLines .flex-invoice-line').map((row, index) => {
    const sku = row.querySelector('[data-flex-model]').value.trim();
    const description = row.querySelector('[data-flex-description]').value.trim();
    const quantity = Number(row.querySelector('[data-flex-quantity]').value);
    const unitprice = Number(row.querySelector('[data-flex-unit-price]').value);
    if (!sku && !description) throw new Error(`חסר דגם או פירוט בפריט ${index + 1}`);
    if (!(quantity > 0)) throw new Error(`הכמות בפריט ${index + 1} אינה תקינה`);
    if (!(unitprice > 0)) throw new Error(`המחיר בפריט ${index + 1} אינו תקין`);
    return { sku, description: description || sku, quantity, unitprice };
  });
  if (!items.length) throw new Error('יש להוסיף לפחות פריט אחד');
  const subtotal = roundMoney(items.reduce((sum, item) => sum + item.quantity * item.unitprice, 0));
  const discountValue = Math.max(0, Number($('flexInvoiceDiscount').value || 0));
  const discountType = $('flexInvoiceDiscountType').value;
  const discount = roundMoney(discountType === 'pct' ? subtotal * Math.min(discountValue, 100) / 100 : discountValue);
  if (discount > subtotal) throw new Error('ההנחה גבוהה מסכום החשבונית');
  const docDate = $('flexInvoiceDate').value;
  const paydate = $('flexInvoicePaydate').value;
  if (!docDate || !paydate || paydate < docDate) throw new Error('יש לבדוק את תאריך ההפקה ותאריך התשלום');
  return {
    request_id: flexibleInvoiceRequestId,
    customer_id: customerId,
    client_name: clientName,
    vat_id: $('flexInvoiceTaxId').value.trim(),
    email: $('flexInvoiceEmail').value.trim(),
    address: $('flexInvoiceAddress').value.trim(),
    doc_date: docDate,
    paydate,
    notes: $('flexInvoiceNotes').value.trim(),
    items,
    discount,
  };
}

function renderFlexibleInvoicePreview(payload) {
  const subtotal = roundMoney(payload.items.reduce((sum, item) => sum + item.quantity * item.unitprice, 0));
  const beforeVat = roundMoney(subtotal - payload.discount);
  const vat = roundMoney(beforeVat * 0.18);
  const total = roundMoney(beforeVat + vat);
  flexibleInvoicePreviewPayload = payload;
  $('flexInvoicePreview').innerHTML = `
    <div class="invoice-preview">
      <div class="note small"><b>תצוגה מקדימה בלבד.</b> בשלב זה עדיין לא נוצרה חשבונית.</div>
      <div class="invoice-preview-head">
        <div><span class="muted small">לקוח</span><b>${esc(payload.client_name)}</b></div>
        <div><span class="muted small">ח.פ / ע.מ</span><b>${esc(payload.vat_id || '—')}</b></div>
        <div><span class="muted small">תאריך</span><b>${fmtDate(payload.doc_date, false)}</b></div>
        <div><span class="muted small">לתשלום עד</span><b>${fmtDate(payload.paydate, false)}</b></div>
      </div>
      <div class="table-wrap"><table><thead><tr><th>דגם ופירוט</th><th class="num">כמות</th><th class="num">מחיר</th><th class="num">סה״כ</th></tr></thead><tbody>
        ${payload.items.map((item) => `<tr>
          <td><b>${esc(item.sku || item.description)}</b>${item.sku && item.description !== item.sku ? `<div class="small muted">${esc(item.description)}</div>` : ''}</td>
          <td class="num">${fmtNum(item.quantity)}</td><td class="num">${fmtMoney(item.unitprice)}</td>
          <td class="num">${fmtMoney(item.quantity * item.unitprice)}</td>
        </tr>`).join('')}
      </tbody></table></div>
      <div class="invoice-totals">
        <span>סכום לפני הנחה</span><b>${fmtMoney(subtotal)}</b>
        ${payload.discount ? `<span>הנחה</span><b>−${fmtMoney(payload.discount)}</b>` : ''}
        <span>לפני מע״מ</span><b>${fmtMoney(beforeVat)}</b>
        <span>מע״מ 18%</span><b>${fmtMoney(vat)}</b>
        <span class="invoice-grand">סה״כ כולל מע״מ</span><b class="invoice-grand">${fmtMoney(total)}</b>
      </div>
      <div class="note small">iCount לא ישלח מייל. החשבונית תישמר בכרטיס הלקוח ותהיה זמינה במסך החשבוניות.</div>
      ${LOCAL_REVIEW ? '<div class="note small">🧪 מצב בדיקה מקומית: ההפקה חסומה ולא תישלח בקשה ל־iCount.</div>' : ''}
      <label class="setting-check invoice-confirm">
        <input type="checkbox" id="flexInvoiceConfirm" ${LOCAL_REVIEW ? 'disabled' : ''}>
        <span><b>בדקתי את הלקוח, הפריטים והסכומים</b><small>האישור הבא מפיק חשבונית מקור אמיתית ב־iCount.</small></span>
      </label>
      <div class="err-msg" id="flexInvoiceCreateError"></div>
      <button class="btn block lg" id="flexInvoiceCreate" disabled>אישור והפקת חשבונית</button>
    </div>`;
  on('flexInvoiceConfirm', 'change', () => {
    $('flexInvoiceCreate').disabled = LOCAL_REVIEW || !$('flexInvoiceConfirm').checked;
  });
  on('flexInvoiceCreate', 'click', createFlexibleInvoice);
}

async function createFlexibleInvoice() {
  if (!flexibleInvoicePreviewPayload || !$('flexInvoiceConfirm')?.checked) return;
  const button = $('flexInvoiceCreate');
  const errorBox = $('flexInvoiceCreateError');
  button.disabled = true;
  button.textContent = 'מפיק ושומר… אין לסגור';
  errorBox.classList.remove('show');
  try {
    const { data, error } = await sb.functions.invoke('icount-invoice', {
      body: { action: 'flexible_create', ...flexibleInvoicePreviewPayload },
    });
    if (error) throw error;
    if (!data?.ok) throw new Error(data?.error || 'הפקת החשבונית נכשלה');
    toast(`חשבונית ${data.invoice_number || ''} הופקה ונשמרה בכרטיס הלקוח`);
    closeModal();
    await loadAll();
    switchTab('invoices');
  } catch (error) {
    errorBox.textContent = friendlyError(error);
    errorBox.classList.add('show');
    button.disabled = false;
    button.textContent = 'ניסיון חוזר';
  }
}

function openFlexibleInvoice() {
  flexibleInvoiceRequestId = crypto.randomUUID();
  flexibleInvoicePreviewPayload = null;
  const date = todayISO();
  modal('חשבונית חדשה וגמישה', `
    <div class="invoice-preview">
      <div class="note small">המחירים מוזנים לפני מע״מ. לאחר מילוי הפרטים תוצג חשבונית מלאה לבדיקה ורק אז יהיה ניתן לאשר הפקה.</div>
      <div class="customer-combobox field">
        <label for="flexInvoiceCustomerSearch">לקוח *</label>
        <input type="search" id="flexInvoiceCustomerSearch" autocomplete="off" role="combobox"
               aria-expanded="false" aria-controls="flexInvoiceCustomerList" placeholder="הקלד שם, עסק, טלפון או ח.פ…">
        <input type="hidden" id="flexInvoiceCustomerId">
        <div class="customer-options" id="flexInvoiceCustomerList" role="listbox"></div>
      </div>
      <div class="grid-2">
        <div class="field"><label for="flexInvoiceClientName">שם שיופיע בחשבונית *</label><input id="flexInvoiceClientName" type="text"></div>
        <div class="field"><label for="flexInvoiceTaxId">ח.פ / ע.מ</label><input id="flexInvoiceTaxId" type="text" inputmode="numeric"></div>
        <div class="field"><label for="flexInvoiceEmail">מייל</label><input id="flexInvoiceEmail" type="email"></div>
        <div class="field"><label for="flexInvoiceAddress">כתובת</label><input id="flexInvoiceAddress" type="text"></div>
        <div class="field"><label for="flexInvoiceDate">תאריך הפקה</label><input id="flexInvoiceDate" type="date" value="${date}"></div>
        <div class="field"><label for="flexInvoicePaydate">לתשלום עד</label><input id="flexInvoicePaydate" type="date" value="${endOfMonthISO(new Date(`${date}T12:00:00`))}"></div>
      </div>
      <datalist id="flexInvoiceModels">${db.products.map((product) => `<option value="${esc(product.model)}">${esc(product.description || '')}</option>`).join('')}</datalist>
      <div class="row"><h4 class="bold">פריטים</h4><span class="grow"></span><button type="button" class="btn ghost sm" id="flexInvoiceAddLine">➕ הוספת פריט</button></div>
      <div id="flexInvoiceLines"></div>
      <div class="grid-2">
        <div class="field"><label>הנחה</label><div class="row" style="flex-wrap:nowrap">
          <select id="flexInvoiceDiscountType" style="width:105px"><option value="pct">%</option><option value="amt">₪</option></select>
          <input id="flexInvoiceDiscount" type="number" min="0" step="0.01" inputmode="decimal" value="0">
        </div></div>
        <div class="field"><label for="flexInvoiceNotes">הערה לחשבונית</label><input id="flexInvoiceNotes" type="text" placeholder="טקסט חופשי שיופיע במסמך"></div>
      </div>
      <div class="err-msg" id="flexInvoiceError"></div>
      <button type="button" class="btn block lg" id="flexInvoicePreviewBtn">תצוגה מקדימה</button>
      <div id="flexInvoicePreview"></div>
    </div>`, true);

  addFlexibleInvoiceLine();
  on('flexInvoiceAddLine', 'click', () => addFlexibleInvoiceLine());
  on('flexInvoiceCustomerSearch', 'focus', () => renderFlexibleInvoiceCustomers(true));
  on('flexInvoiceCustomerSearch', 'input', () => {
    $('flexInvoiceCustomerId').value = '';
    renderFlexibleInvoiceCustomers(true);
    invalidateFlexibleInvoicePreview();
  });
  on('flexInvoiceCustomerSearch', 'blur', () => setTimeout(() => {
    $('flexInvoiceCustomerList')?.classList.remove('open');
    $('flexInvoiceCustomerSearch')?.setAttribute('aria-expanded', 'false');
  }, 150));
  on('flexInvoiceCustomerSearch', 'keydown', (event) => {
    if (event.key === 'Escape') $('flexInvoiceCustomerList').classList.remove('open');
    if (event.key === 'Enter') {
      const first = $('flexInvoiceCustomerList').querySelector('[data-flex-invoice-customer]');
      if (first) { event.preventDefault(); selectFlexibleInvoiceCustomer(first.dataset.flexInvoiceCustomer); }
    }
  });
  $('flexInvoiceCustomerList').onclick = (event) => {
    const option = event.target.closest('[data-flex-invoice-customer]');
    if (option) selectFlexibleInvoiceCustomer(option.dataset.flexInvoiceCustomer);
  };
  $('flexInvoiceLines').onclick = (event) => {
    const remove = event.target.closest('[data-flex-remove-line]');
    if (!remove) return;
    remove.closest('.flex-invoice-line').remove();
    invalidateFlexibleInvoicePreview();
  };
  const fillProductDetails = (event) => {
    const modelInput = event.target.closest('[data-flex-model]');
    if (!modelInput) return;
    const product = db.products.find((item) => item.model.toLowerCase() === modelInput.value.trim().toLowerCase());
    if (!product) return;
    modelInput.value = product.model;
    const row = modelInput.closest('.flex-invoice-line');
    const description = row.querySelector('[data-flex-description]');
    const price = row.querySelector('[data-flex-unit-price]');
    if (!description.value.trim()) description.value = product.description || product.model;
    if (!Number(price.value)) price.value = Number(product.wholesale_price || 0) || '';
  };
  $('flexInvoiceLines').addEventListener('input', fillProductDetails);
  $('flexInvoiceLines').addEventListener('change', fillProductDetails);
  $('modalBody').addEventListener('input', (event) => {
    if (!event.target.closest('#flexInvoiceConfirm')) invalidateFlexibleInvoicePreview();
  });
  $('modalBody').addEventListener('change', (event) => {
    if (!event.target.closest('#flexInvoiceConfirm')) invalidateFlexibleInvoicePreview();
  });
  on('flexInvoicePreviewBtn', 'click', () => {
    showError('flexInvoiceError', '');
    try { renderFlexibleInvoicePreview(collectFlexibleInvoice()); }
    catch (error) { showError('flexInvoiceError', error.message); }
  });
}

function filteredInvoices() {
  const cust = $('invCustomer').value;
  return db.invoices.filter((v) => !cust || v.customer_id === cust);
}

function invoiceDisplayAmount(invoice) {
  return invoice.order_id && invoice.orders?.total_amount != null
    ? Number(invoice.orders.total_amount)
    : (invoice.amount != null ? Number(invoice.amount) : null);
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
    <th class="num">סכום</th><th></th></tr></thead><tbody>
    ${items.map((v) => `<tr>
      ${td('מס׳', `${esc(v.invoice_number || '—')}${v.source === 'icount' ? ' <span class="chip violet">iCount</span>' : ''}`, 'bold')}
      ${td('לקוח', esc(v.customers?.name || '—'))}
      ${td('הזמנה', v.orders?.order_number ? '#' + v.orders.order_number : '—')}
      ${td('תאריך', fmtDate(v.issued_at, false), 'small nowrap')}
      ${td('סכום', invoiceDisplayAmount(v) != null ? fmtMoney(invoiceDisplayAmount(v)) : '—', 'num')}
      ${td('', `<button class="btn ghost sm" data-dl="${esc(v.file_path)}"
                data-name="${esc(v.file_name || 'invoice.pdf')}">⬇️</button>
                ${v.source === 'icount'
                  ? '<span class="chip gray" title="חשבונית מקור אינה נמחקת">🔒</span>'
                  : `<button class="btn ghost sm" data-del-inv="${v.id}">🗑️</button>`}`, 'nowrap')}
    </tr>`).join('')}
    </tbody></table></div>`;

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
  if (v.source === 'icount') {
    toast('חשבונית שהופקה ב-iCount אינה נמחקת מהמערכת. יש לבטל או לזכות אותה ב-iCount ולשמור תיעוד.', true);
    return;
  }
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
    <div class="field"><label>תאריך</label>
      <input type="date" id="ivDate" value="${new Date().toISOString().slice(0, 10)}"></div>
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
        status: 'active',
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
        'שם העסק': o.customers?.business_name || o.customers?.name || o.contact_name || '',
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
    'שם העסק': o.customers?.business_name || o.customers?.name || o.contact_name || '',
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
    'סכום': Number(v.amount || 0),
  }));
  await exportXlsx(`לקוח_${(c?.name || '').replace(/\s+/g, '_')}`, [
    { name: 'הזמנות', rows }, { name: 'חשבוניות', rows: invs },
  ]);
}

// ============================================================
// מודאל
// ============================================================
function modal(title, html, wide = false) {
  $('modalTitle').textContent = title;
  $('modalBody').innerHTML = html;
  $('modalBox').classList.toggle('wide-modal', wide);
  $('modal').classList.add('active');
}
function closeModal() {
  $('modal').classList.remove('active');
  $('modalBox').classList.remove('wide-modal');
  $('modalBody').innerHTML = '';
  clearRetLines();     // משחרר תצוגות מקדימות של תמונות חזרה
}

// ============================================================
// לשוניות
// ============================================================
const TABS = ['dash', 'orders', 'stock', 'returns', 'customers', 'invoices',
              'demand', 'profit', 'collections', 'settings'];

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
  if (window.matchMedia('(max-width: 780px)').matches) {
    const active = $(`#adminTabs .tab[data-tab="${tab}"]`);
    requestAnimationFrame(() => active?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' }));
  }
}

// ============================================================
// חיווט
// ============================================================
function wire() {
  if (LOCAL_REVIEW) {
    const blockedClick = [
      '[data-adv]', '[data-adv-panel]', '[data-future-order]', '[data-future-panel]',
      '[data-move-pending]', '[data-archive]', '[data-archive-panel]', '[data-unarchive]',
      '[data-unarchive-panel]', '[data-restore]', '[data-restore-panel]', '[data-del-order]',
      '[data-del-order-panel]', '[data-del-return-panel]', '[data-credit]', '[data-credit-panel]',
      '[data-del-inv]', '[data-delete-cust]', '[data-approve-duplicate]', '[data-reject-duplicate]',
      '[data-delete-user]', '[data-del-mail]', '[data-del-return]', '[data-del-item]', '[data-assign]',
      '[data-resend-shipped]', '[data-model-check]', '[data-demand-model-check]',
      '#newOrderSubmit', '#addOrderModelSave', '#uSave', '#discSave', '#payableSave', '#admNotesSave', '#icountCreate', '#flexInvoiceCreate',
      '#ivSave', '#futureCollectionsSave', '#releaseFutureOrders', '#archiveBucket', '#mgSave',
      '#pSave', '#cSave', '#bkSave', '#rtSave', '#setSave', '#meSave', '#profitStartSave',
      '#profitStartClear', '#syncShopifyBtn', '#testMailBtn',
    ].join(',');
    document.addEventListener('click', (e) => {
      if (!e.target.closest(blockedClick)) return;
      e.preventDefault(); e.stopImmediatePropagation();
      toast('מצב בדיקה מקומית: הפעולה חסומה ולא שינתה נתונים', true);
    }, true);
    document.addEventListener('change', (e) => {
      if (!e.target.matches('[data-item], [data-stock], [data-inv-status], [data-user-role], [data-role], [data-active], [data-mail]')) return;
      e.preventDefault(); e.stopImmediatePropagation();
      toast('מצב בדיקה מקומית: השינוי לא נשמר', true);
    }, true);
  }
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
  on('createFlexibleInvoiceBtn', 'click', openFlexibleInvoice);
  on('uploadInvoiceBtn', 'click', () => uploadInvoice());
  on('invCustomer', 'change', renderInvoices);
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
    dmFilters.includeArchived = $('dmIncludeArchive').checked;
    renderDemand();
  };
  on('dmCollection', 'change', applyDm);
  on('dmStatus', 'change', applyDm);
  on('dmIncludeArchive', 'change', applyDm);
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
      'שם העסק': c.business_name || c.name, 'טלפון': c.phone || '',
      'מיילים': customerEmailList(c).join(', '),
      'עיר': c.city || '', 'הזמנות': c.orders_count, 'יחידות': c.total_units,
      'מחזור': Number(c.total_amount || 0),
      'הזמנה אחרונה': c.last_order_at ? fmtDate(c.last_order_at, false) : '',
    })) }]);
    toast('הקובץ יורד…');
  });
  on('exportInvoices', 'click', async () => {
    const rows = filteredInvoices().map((v) => ({
      'מס׳ חשבונית': v.invoice_number || '', 'לקוח': v.customers?.name || '',
      'הזמנה': v.orders?.order_number || '', 'תאריך': fmtDate(v.issued_at, false),
      'סכום': invoiceDisplayAmount(v) ?? 0,
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
    const futurePanel = e.target.closest('[data-future-panel]');
    if (futurePanel) {
      const [id, enabled] = futurePanel.dataset.futurePanel.split('|');
      await setOrderFuture(id, enabled === 'true');
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
    const modelCheck = e.target.closest('[data-model-check]');
    if (modelCheck) {
      const [orderId, model] = modelCheck.dataset.modelCheck.split('|');
      await toggleOrderModelCheck(orderId, model, modelCheck.getAttribute('aria-pressed') !== 'true');
      return;
    }
    const demandModelCheck = e.target.closest('[data-demand-model-check]');
    if (demandModelCheck) {
      const orderIds = demandModelCheck.dataset.orderIds.split(',').filter(Boolean);
      demandModelCheck.disabled = true;
      await toggleDemandModelChecks(
        demandModelCheck.dataset.demandModelCheck,
        orderIds,
        demandModelCheck.dataset.nextChecked === 'true',
      );
      return;
    }
    const addOrderModel = e.target.closest('[data-add-order-model]');
    if (addOrderModel) { openAddOrderModel(addOrderModel.dataset.addOrderModel); return; }
    const genInv = e.target.closest('[data-generate-invoice]');
    if (genInv) { openIcountInvoicePreview(genInv.dataset.generateInvoice); return; }
    const resendShipment = e.target.closest('[data-resend-shipped]');
    if (resendShipment) { await resendShipmentEmail(resendShipment.dataset.resendShipped); return; }
    const orderInvoice = e.target.closest('#orderPanelBody [data-dl]');
    if (orderInvoice) { await downloadInvoice(orderInvoice); return; }

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
    const customerOrder = e.target.closest('[data-customer-order]');
    if (customerOrder && customerOrder.closest('#customerPanelBody')) {
      $('customerOverlay').classList.remove('active');
      openOrder(customerOrder.dataset.customerOrder);
      return;
    }
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
