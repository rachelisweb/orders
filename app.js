// ============================================================
// אפליקציית הלקוח
// הלקוח לא רואה מחירים ולא רואה כמויות מלאי — רק מה אפשר להזמין.
// החשבוניות יושבות בתוך ההזמנה שאליה הן שייכות.
// ============================================================
import {
  sb, state, IS_CONFIGURED, BRAND, isCustomerPreview, setCustomerPreview,
  $, $$, on, esc, imgTag, img, toast, showError,
  fmtDate, fmtNum, friendlyError,
  loadProfile, canOrder, needsProfile, sortSizes, statusChip, debounce,
  ORDER_STATUS, exportXlsx,
} from './lib.js';

let authMode = 'signin';
let isGuest = false;
let activeCollection = null;
let allProducts = [];
let byModel = {};
let myOrders = [];
let myInvoices = new Map();          // order_id → [invoices]
const GUEST_LINE_LIMIT = 999;        // לא חושף לאורח את כמות המלאי המדויקת
const guestApprovedQty = new Map();  // הכמות האחרונה שהשרת אישר לכל דגם/מידה
const guestValidationTimers = new Map();

// ההזמנות שעדיין בטיפול מול אלה שכבר יצאו. ברגע שהמנהל מסמן
// "נשלחה" ההזמנה עוברת מ"ממתינות" ל"היסטוריה".
const OPEN_STATUSES = ['pending', 'ready'];
const isOpenOrder = (o) => OPEN_STATUSES.includes(o.status);
let myOrderTab = 'open';

const customerEmails = (customer) => [...new Set([
  ...(Array.isArray(customer?.email_recipients) ? customer.email_recipients : []),
  customer?.email,
].map((email) => String(email || '').trim().toLowerCase()).filter(Boolean))];

function parseEmails(value) {
  const emails = [...new Set(String(value || '').split(/[\s,;]+/)
    .map((email) => email.trim().toLowerCase()).filter(Boolean))];
  const invalid = emails.filter((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
  return { emails, invalid };
}

// תצוגת הקטלוג נשמרת בין ביקורים — זו העדפה אישית, לא מצב זמני
const VIEW_KEY = 'rachelis:catalogView';
let catalogView = 'list';
try { catalogView = localStorage.getItem(VIEW_KEY) === 'grid' ? 'grid' : 'list'; } catch { /* מצב פרטי */ }

// ============================================================
// אתחול
// ============================================================
async function init() {
  if (!IS_CONFIGURED) { screen('configScreen'); return; }
  wire();

  sb.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_IN' && window.location.hash.includes('access_token')) {
      history.replaceState(null, '', window.location.pathname + window.location.search);
    }
    if (event === 'SIGNED_OUT' && !isGuest) { screen('authScreen'); return; }
    if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') route();
  });

  await route();
}

async function route() {
  if (isGuest) {
    enterGuestApp();
    return;
  }
  try {
    await loadProfile();
  } catch (err) {
    console.error(err);
    toast(friendlyError(err), true);
  }

  if (!state.user) { screen('authScreen'); return; }

  // מנהל מנותב לניהול, אלא אם ביקש במפורש לראות את ממשק הלקוח
  if (state.isAdmin && !isCustomerPreview()) {
    window.location.replace('admin.html');
    return;
  }

  // כניסה ראשונה — משלימים טלפון ושם עסק. מנהלים פטורים.
  if (needsProfile()) {
    $('pfBusiness').value = state.customer?.business_name || state.customer?.name || state.profile?.full_name || '';
    $('pfPhone').value = state.profile?.phone || '';
    screen('profileScreen');
    return;
  }

  if (!canOrder()) {
    // מצב חריג: אין כרטיס לקוח למרות שהפרופיל מסומן כמושלם
    screen('profileScreen');
    return;
  }

  updateAccountHeader();
  setSignedInNavigation();

  screen('appScreen');
  nav('catalog');
  await loadCatalog();
}

async function startGuest() {
  isGuest = true;
  state.user = null;
  state.profile = null;
  state.customer = null;
  enterGuestApp();
  await loadCatalog();
}

function enterGuestApp() {
  screen('appScreen');
  $('accountBtn').style.display = 'none';
  $('guestExitBtn').style.display = '';
  $('navPersonalArea').style.display = 'none';
  $$('.bn-item[data-nav="orders"]').forEach((b) => { b.style.display = 'none'; });
  nav('catalog');
}

function setSignedInNavigation() {
  $('accountBtn').style.display = '';
  $('guestExitBtn').style.display = 'none';
  $('navPersonalArea').style.display = '';
  $$('.bn-item[data-nav="orders"]').forEach((b) => { b.style.display = ''; });
  $('successOrders').style.display = '';
}

function exitGuest() {
  isGuest = false;
  state.cart = {};
  $('orderNotes').value = '';
  $('guestOrderFields').hidden = true;
  $('cartOverlay').classList.remove('guest-checkout');
  $('guestBusiness').value = '';
  $('guestEmail').value = '';
  $('guestPhone').value = '';
  closeCart();
  updateBadge();
  screen('authScreen');
}

function screen(id) {
  ['authScreen', 'profileScreen', 'configScreen', 'appScreen']
    .forEach((s) => $(s)?.classList.toggle('active', s === id));
  window.scrollTo(0, 0);
}

function view(id, title, sub) {
  ['catalogView', 'ordersView', 'successView']
    .forEach((v) => $(v)?.classList.toggle('active', v === id));
  if (title) $('headerTitle').textContent = title;
  $('headerSub').textContent = sub || '';
  $('accountMenu').classList.remove('open');
  window.scrollTo(0, 0);
}

function nav(key) {
  $$('.bn-item').forEach((b) => b.classList.toggle('active', b.dataset.nav === key));
  if (key === 'catalog') view('catalogView', '🛍️ רחליס', 'הזמנה חדשה');
  else if (key === 'orders') {
    view('ordersView', '📋 האזור האישי', '');
    fillAccountProfile();
    loadMyOrders();
  }
  else if (key === 'cart') openCart();
}

// ============================================================
// התחברות
// ============================================================
function setAuthMode(mode) {
  authMode = mode;
  $('signupFields').style.display = mode === 'signup' ? 'block' : 'none';
  $('authSubmit').textContent = mode === 'signup' ? 'הרשמה' : 'התחברות';
  $('authToggle').textContent = mode === 'signup'
    ? 'יש לי כבר חשבון — התחברות' : 'אין לי חשבון — הרשמה';
  $('authPassword').setAttribute('autocomplete', mode === 'signup' ? 'new-password' : 'current-password');
  showError('authError', '');
}

async function handleGoogle() {
  try {
    const { error } = await sb.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin + window.location.pathname },
    });
    if (error) throw error;
  } catch (err) {
    showError('authError', friendlyError(err));
  }
}

async function handleEmailAuth() {
  const email = $('authEmail').value.trim();
  const pass  = $('authPassword').value;
  showError('authError', '');
  if (!email || !pass) { showError('authError', 'יש למלא אימייל וסיסמה'); return; }

  const btn = $('authSubmit');
  btn.disabled = true;
  btn.textContent = 'רגע…';

  try {
    if (authMode === 'signup') {
      const businessName = $('authName').value.trim();
      if (!businessName) throw new Error('יש למלא שם העסק');
      const { error } = await sb.auth.signUp({
        email, password: pass,
        options: {
          data: { full_name: businessName, business_name: businessName },
          emailRedirectTo: window.location.origin + window.location.pathname,
        },
      });
      if (error) throw error;
      toast('נרשמת בהצלחה — אפשר להתחיל להשתמש במערכת');
    } else {
      const { error } = await sb.auth.signInWithPassword({ email, password: pass });
      if (error) throw error;
    }
    await route();
  } catch (err) {
    showError('authError', friendlyError(err));
  } finally {
    btn.disabled = false;
    setAuthMode(authMode);
  }
}

async function signOut() {
  isGuest = false;
  setCustomerPreview(false);
  await sb.auth.signOut();
  state.cart = {};
  screen('authScreen');
}

// ============================================================
// השלמת פרטים
// ============================================================
async function saveProfile() {
  const businessName = $('pfBusiness').value.trim();
  const phone = $('pfPhone').value.trim();
  showError('profileError', '');

  if (!businessName)  { showError('profileError', 'יש למלא שם העסק'); return; }
  if (!phone) { showError('profileError', 'יש למלא מספר טלפון'); return; }

  const btn = $('pfSave');
  btn.disabled = true;
  btn.textContent = 'שומר…';

  try {
    const { error } = await sb.rpc('complete_profile', {
      p_full_name: businessName,
      p_phone: phone,
      p_business_name: businessName,
      p_city: $('pfCity').value.trim() || null,
    });
    if (error) throw error;
    toast('הפרטים נשמרו בהצלחה');
    await route();
  } catch (err) {
    showError('profileError', friendlyError(err));
  } finally {
    btn.disabled = false;
    btn.textContent = 'שמירה והמשך';
  }
}

function updateAccountHeader() {
  $('whoName').textContent = state.customer?.business_name || state.customer?.name
                          || state.profile?.full_name || 'לקוח';
  $('whoMail').textContent = state.profile?.email || '';
  $('navAdmin').style.display = state.isAdmin ? 'block' : 'none';
  $('previewBanner').style.display = state.isAdmin ? 'block' : 'none';
}

function fillAccountProfile() {
  $('accountPhone').value    = state.profile?.phone || state.customer?.phone || '';
  $('accountBusiness').value = state.customer?.business_name || state.customer?.name || state.profile?.full_name || '';
  $('accountCity').value     = state.customer?.city || '';
  $('accountEmails').value   = customerEmails(state.customer).join('\n') || state.profile?.email || '';
  showError('accountProfileError', '');
}

async function saveAccountProfile() {
  const businessName = $('accountBusiness').value.trim();
  const phone = $('accountPhone').value.trim();
  const { emails, invalid } = parseEmails($('accountEmails').value);
  showError('accountProfileError', '');

  if (!businessName)  { showError('accountProfileError', 'יש למלא שם העסק'); return; }
  if (!phone) { showError('accountProfileError', 'יש למלא מספר טלפון'); return; }
  if (invalid.length) { showError('accountProfileError', `כתובת מייל לא תקינה: ${invalid[0]}`); return; }

  const btn = $('accountProfileSave');
  btn.disabled = true;
  btn.textContent = 'שומר…';

  try {
    const { error } = await sb.rpc('complete_profile', {
      p_full_name: businessName,
      p_phone: phone,
      p_business_name: businessName,
      p_city: $('accountCity').value.trim() || null,
    });
    if (error) throw error;
    const { error: emailError } = await sb.rpc('set_my_customer_emails', { p_emails: emails });
    if (emailError) throw emailError;
    await loadProfile();
    updateAccountHeader();
    fillAccountProfile();
    toast('הפרטים נשמרו בהצלחה');
  } catch (err) {
    showError('accountProfileError', friendlyError(err));
  } finally {
    btn.disabled = false;
    btn.textContent = 'שמירת פרטים';
  }
}

// ============================================================
// קטלוג — בלי מחירים, בלי מספרי מלאי
// ============================================================
async function loadCatalog() {
  const list = $('productList');
  list.innerHTML = '<div class="loading"><div class="spinner"></div>טוען קטלוג…</div>';

  try {
    let cols, prods, available;
    if (isGuest) {
      const { data, error } = await sb.rpc('get_guest_catalog');
      if (error) throw error;
      cols = data?.collections || [];
      prods = data?.products || [];
      available = data?.inventory || [];
    } else {
      const [{ data: c, error: e1 }, { data: p, error: e2 }, { data: a, error: e3 }] = await Promise.all([
      sb.from('collections').select('*').eq('is_active', true).order('sort_order'),
      sb.from('products')
        .select('id, model, description, image_url, sort_order, collection_id, inventory(size, qty)')
        .eq('is_active', true)
        .order('sort_order'),
      sb.rpc('get_available_inventory'),
      ]);
      if (e1) throw e1;
      if (e2) throw e2;
      if (e3) throw e3;
      cols = c; prods = p; available = a;
    }

    state.collections = cols || [];
    const availableByProduct = new Map();
    for (const row of available || []) {
      if (!availableByProduct.has(row.product_id)) availableByProduct.set(row.product_id, {});
      availableByProduct.get(row.product_id)[row.size] = isGuest
        ? GUEST_LINE_LIMIT
        : Number(row.qty || 0);
    }
    // המלאי הזמין כבר מקזז יחידות שתפוסות בהזמנות ממתינות אחרות.
    allProducts = (prods || []).map((p) => ({
      ...p,
      stock: Object.fromEntries(Object.entries(availableByProduct.get(p.id) || {})
        .filter(([, qty]) => qty > 0)),
    })).filter((p) => Object.keys(p.stock).length > 0);
    byModel = Object.fromEntries(allProducts.map((p) => [p.model, p]));

    let cartAdjusted = false;
    for (const [model, sizes] of Object.entries(state.cart)) {
      const product = byModel[model];
      if (!product) { delete state.cart[model]; cartAdjusted = true; continue; }
      for (const [size, current] of Object.entries(sizes)) {
        const max = Number(product.stock[size] || 0);
        if (current > max) {
          if (max > 0) sizes[size] = max; else delete sizes[size];
          cartAdjusted = true;
        }
      }
      if (!Object.keys(sizes).length) delete state.cart[model];
    }
    if (cartAdjusted) {
      updateBadge();
      toast('הסל עודכן לפי המלאי שעדיין זמין', true);
    }

    renderTabs();
    renderProducts();
  } catch (err) {
    console.error(err);
    list.innerHTML = `<div class="empty"><div class="ico">⚠️</div>${esc(friendlyError(err))}
      <div style="margin-top:1rem"><button class="btn ghost sm" id="retryLoad">נסה שוב</button></div></div>`;
    on('retryLoad', 'click', loadCatalog);
  }
}

function renderTabs() {
  const tabs = $('collectionTabs');
  if (!state.collections.length) { tabs.innerHTML = ''; return; }

  if (!activeCollection || !state.collections.some((c) => c.id === activeCollection)) {
    activeCollection = state.collections[0].id;
  }

  tabs.innerHTML = state.collections.map((c) => {
    const n = allProducts.filter((p) => p.collection_id === c.id).length;
    return `<button class="tab ${c.id === activeCollection ? 'active' : ''}" data-col="${c.id}">
      ${esc(c.icon || '📦')} ${esc(c.name)} <span class="tab-count">${n}</span>
    </button>`;
  }).join('');

  tabs.onclick = (e) => {
    const b = e.target.closest('[data-col]');
    if (!b) return;
    activeCollection = b.dataset.col;
    $('searchInput').value = '';
    renderTabs();
    renderProducts();
  };
}

function visibleProducts() {
  const q = $('searchInput').value.trim().toLowerCase();
  return allProducts.filter((p) => {
    if (p.collection_id !== activeCollection) return false;
    if (!q) return true;
    return p.model.toLowerCase().includes(q) || (p.description || '').toLowerCase().includes(q);
  });
}

function setCatalogView(mode) {
  catalogView = mode === 'grid' ? 'grid' : 'list';
  try { localStorage.setItem(VIEW_KEY, catalogView); } catch { /* מצב פרטי */ }
  $$('#viewToggle button').forEach((b) => b.classList.toggle('on', b.dataset.view === catalogView));
  renderProducts();
}

function renderProducts() {
  const list = $('productList');
  const items = visibleProducts();
  // ברשת התמונה גדולה יותר ולכן צריך מקור ברזולוציה גבוהה יותר
  const imgW = catalogView === 'grid' ? 480 : 320;

  list.className = catalogView === 'grid' ? 'grid' : '';

  if (!items.length) {
    list.innerHTML = `<div class="empty"><div class="ico">🔍</div>לא נמצאו דגמים מתאימים</div>`;
    return;
  }

  list.innerHTML = items.map((p) => {
    const sizes = Object.keys(p.stock).sort(sortSizes);
    return `
    <div class="product" data-model="${esc(p.model)}">
      <div class="product-img" data-zoom="${esc(p.model)}">
        ${imgTag(p.image_url, 'דגם ' + p.model, imgW)}
        ${p.image_url ? '<span class="zoom" aria-hidden="true">🔍</span>' : ''}
      </div>
      <div class="product-body">
        <div class="product-top">
          <div class="product-title">דגם ${esc(p.model)}</div>
          <button class="btn ghost sm" data-serie="${esc(p.model)}">📦 סריה</button>
        </div>
        ${p.description ? `<div class="product-desc">${esc(p.description)}</div>` : ''}
        <div class="sizes">
          ${sizes.map((s) => {
            const cur = state.cart[p.model]?.[s] || 0;
            return `<label class="size">
              <span class="lbl">${esc(s)}</span>
              <input type="number" inputmode="numeric" pattern="[0-9]*" min="0" max="${p.stock[s]}"
                     value="${cur || ''}" placeholder="0" class="${cur > 0 ? 'on' : ''}"
                     aria-label="דגם ${esc(p.model)} מידה ${esc(s)}"
                     data-last-approved="${isGuest ? (guestApprovedQty.get(`${p.model}|${s}`) || 0) : cur}"
                     data-m="${esc(p.model)}" data-s="${esc(s)}">
            </label>`;
          }).join('')}
        </div>
      </div>
    </div>`;
  }).join('');

  list.oninput = (e) => {
    const inp = e.target.closest('input[data-m]');
    if (inp) {
      setQty(inp);
      scheduleGuestInputValidation(inp);
    }
  };
  list.onchange = (e) => {
    const inp = e.target.closest('input[data-m][data-s]');
    if (inp) {
      clearGuestValidationTimer(inp);
      validateGuestInput(inp);
    }
  };
  list.onclick = (e) => {
    const zoom = e.target.closest('[data-zoom]');
    if (zoom) { openImg(zoom.dataset.zoom); return; }
    const serie = e.target.closest('[data-serie]');
    if (serie) addSerie(serie.dataset.serie);
  };
}

function setCartLine(model, size, qty) {
  if (qty > 0) {
    (state.cart[model] ||= {})[size] = qty;
  } else if (state.cart[model]) {
    delete state.cart[model][size];
    if (!Object.keys(state.cart[model]).length) delete state.cart[model];
  }
  updateBadge();
}

function guestLineKey(inp) {
  return `${inp.dataset.m}|${inp.dataset.s}`;
}

function clearGuestValidationTimer(inp) {
  const key = guestLineKey(inp);
  clearTimeout(guestValidationTimers.get(key));
  guestValidationTimers.delete(key);
}

function scheduleGuestInputValidation(inp) {
  if (!isGuest) return;
  clearGuestValidationTimer(inp);
  const key = guestLineKey(inp);
  const timer = setTimeout(async () => {
    guestValidationTimers.delete(key);
    await validateGuestInput(inp);
  }, 400);
  guestValidationTimers.set(key, timer);
}

function refreshCartQuantitySummary(model) {
  const box = $('cartItems');
  if (!box) return;
  const modelQty = Object.values(state.cart[model] || {}).reduce((sum, value) => sum + value, 0);
  const total = box.querySelector(`[data-cart-model-total="${CSS.escape(model)}"]`);
  if (total) total.textContent = `${fmtNum(modelQty)} יח׳`;
  if ($('cartTotal')) $('cartTotal').textContent = `סה״כ ${fmtNum(cartUnits())} יחידות`;
}

async function checkGuestItems(items) {
  if (!isGuest || !items.length) return { available: true, unavailable: [] };
  const { data, error } = await sb.rpc('validate_guest_cart', { p_items: items });
  if (error) throw error;
  return data || { available: false, unavailable: items };
}

async function validateGuestInput(inp) {
  if (!isGuest) return true;
  const model = inp.dataset.m;
  const size = inp.dataset.s;
  const qty = Number(state.cart[model]?.[size] || 0);
  const previous = Number(inp.dataset.lastApproved || 0);
  if (qty <= 0) {
    guestApprovedQty.set(`${model}|${size}`, 0);
    inp.dataset.lastApproved = '0';
    return true;
  }

  inp.disabled = true;
  inp.setAttribute('aria-busy', 'true');
  try {
    const result = await checkGuestItems([{ model, size, qty }]);
    if (!result.available) {
      const adjusted = Number(result.unavailable?.[0]?.qty || 0);
      setCartLine(model, size, adjusted);
      guestApprovedQty.set(`${model}|${size}`, adjusted);
      inp.dataset.lastApproved = String(adjusted);
      inp.value = adjusted || '';
      inp.classList.toggle('on', adjusted > 0);
      refreshCartQuantitySummary(model);
      toast(`דגם ${model} מידה ${size}: הכמות עודכנה למקסימום הזמין (${adjusted})`, true);
      return false;
    }
    guestApprovedQty.set(`${model}|${size}`, qty);
    inp.dataset.lastApproved = String(qty);
    return true;
  } catch (err) {
    setCartLine(model, size, previous);
    inp.value = previous || '';
    inp.classList.toggle('on', previous > 0);
    refreshCartQuantitySummary(model);
    toast(friendlyError(err), true);
    return false;
  } finally {
    inp.disabled = false;
    inp.removeAttribute('aria-busy');
  }
}

async function validateGuestCartBeforeSubmit() {
  if (!isGuest) return true;
  const items = [];
  for (const [model, sizes] of Object.entries(state.cart)) {
    for (const [size, qty] of Object.entries(sizes)) {
      if (qty > 0) items.push({ model, size, qty });
    }
  }
  try {
    const result = await checkGuestItems(items);
    if (result.available) return true;
    for (const line of result.unavailable || []) {
      const adjusted = Number(line.qty || 0);
      setCartLine(line.model, line.size, adjusted);
      guestApprovedQty.set(`${line.model}|${line.size}`, adjusted);
    }
    renderCart();
    renderProducts();
    toast('הכמויות בסל עודכנו אוטומטית למלאי המרבי הזמין');
    return true;
  } catch (err) {
    showError('cartError', friendlyError(err));
    return false;
  }
}

function setQty(inp) {
  const model = inp.dataset.m;
  const size  = inp.dataset.s;
  const max   = Number(inp.max) || 0;
  let v = parseInt(inp.value, 10);
  if (!Number.isFinite(v) || v < 0) v = 0;
  // הכמות נחסמת לפי המלאי, אבל לא מסגירים ללקוח כמה יש
  if (v > max) { v = max; toast(`דגם ${model} מידה ${size}: אין כמות כזו במלאי`, true); }

  inp.value = v || '';
  inp.classList.toggle('on', v > 0);

  setCartLine(model, size, v);
}

async function addSerie(model) {
  const p = byModel[model];
  if (!p) return;
  const cart = (state.cart[model] ||= {});
  const candidates = Object.entries(p.stock).map(([size]) => ({
    model, size, qty: (cart[size] || 0) + 1,
  }));
  let unavailable = new Set();
  if (isGuest) {
    try {
      const result = await checkGuestItems(candidates);
      unavailable = new Set((result.unavailable || []).map((line) => `${line.model}|${line.size}`));
    } catch (err) {
      toast(friendlyError(err), true);
      return;
    }
  }
  let added = 0;
  for (const [size, avail] of Object.entries(p.stock)) {
    const cur = cart[size] || 0;
    if (cur < avail && !unavailable.has(`${model}|${size}`)) {
      cart[size] = cur + 1;
      if (isGuest) guestApprovedQty.set(`${model}|${size}`, cur + 1);
      added++;
    }
  }
  renderProducts();
  updateBadge();
  toast(added ? `נוספה סריה לדגם ${model}` : `אין כרגע מלאי נוסף לדגם ${model}`, !added);
}

function openImg(model) {
  const p = byModel[model];
  if (!p?.image_url) return;
  $('modalImg').src = img(p.image_url, 900);
  $('modalTitle').textContent = 'דגם ' + p.model;
  $('modalDesc').textContent = p.description || '';
  $('imgModal').classList.add('active');
}

// ============================================================
// סל — סופר יחידות בלבד, בלי סכומים
// ============================================================
function cartUnits() {
  let units = 0;
  for (const sizes of Object.values(state.cart)) {
    for (const qty of Object.values(sizes)) units += qty;
  }
  return units;
}

function updateBadge() {
  const units = cartUnits();
  for (const id of ['cartBadge', 'bnBadge']) {
    const b = $(id);
    if (!b) continue;
    b.textContent = units;
    b.classList.toggle('hidden', units === 0);
  }
}

function renderCart() {
  const box  = $('cartItems');
  const foot = $('cartFoot');
  const entries = Object.entries(state.cart).filter(([, s]) => Object.keys(s).length);

  if (!entries.length) {
    box.innerHTML = `<div class="empty"><div class="ico">🛒</div>הסל ריק</div>`;
    foot.style.display = 'none';
    return;
  }

  box.innerHTML = entries.map(([model, sizes]) => {
    const p = byModel[model];
    const qty = Object.values(sizes).reduce((a, b) => a + b, 0);
    const sizeInputs = Object.keys(sizes).sort(sortSizes).map((s) => {
      const current = Number(sizes[s] || 0);
      const available = Number(p?.stock?.[s] || current);
      return `<label class="size">
        <span class="lbl">${esc(s)}</span>
        <input type="number" inputmode="numeric" pattern="[0-9]*" min="0" max="${Math.max(available, current)}"
               value="${current}" class="${current > 0 ? 'on' : ''}"
               aria-label="דגם ${esc(model)} מידה ${esc(s)}"
               data-last-approved="${isGuest ? (guestApprovedQty.get(`${model}|${s}`) || 0) : current}"
               data-m="${esc(model)}" data-s="${esc(s)}">
      </label>`;
    }).join('');
    return `<div class="cart-item">
      ${p?.image_url
        ? `<img class="thumb" src="${esc(img(p.image_url, 120))}" alt="" loading="lazy" decoding="async">`
        : '<div class="thumb img-ph">📷</div>'}
      <div class="info">
        <div class="title">דגם ${esc(model)}</div>
        <div class="sizes cart-sizes">${sizeInputs}</div>
        <div class="muted small" data-cart-model-total="${esc(model)}">${qty} יח׳</div>
      </div>
      <button class="btn ghost sm" data-rm="${esc(model)}" aria-label="הסר דגם ${esc(model)}">🗑️</button>
    </div>`;
  }).join('');

  box.onclick = (e) => {
    const rm = e.target.closest('[data-rm]');
    if (!rm) return;
    delete state.cart[rm.dataset.rm];
    renderCart();
    renderProducts();
    updateBadge();
  };
  box.oninput = (e) => {
    const input = e.target.closest('input[data-m][data-s]');
    if (!input) return;
    setQty(input);
    const modelQty = Object.values(state.cart[input.dataset.m] || {}).reduce((sum, value) => sum + value, 0);
    const total = box.querySelector(`[data-cart-model-total="${CSS.escape(input.dataset.m)}"]`);
    if (total) total.textContent = `${fmtNum(modelQty)} יח׳`;
    $('cartTotal').textContent = `סה״כ ${fmtNum(cartUnits())} יחידות`;
    scheduleGuestInputValidation(input);
  };
  box.onchange = async (e) => {
    const input = e.target.closest('input[data-m][data-s]');
    if (!input) return;
    clearGuestValidationTimer(input);
    await validateGuestInput(input);
    renderCart();
    renderProducts();
  };

  $('cartTotal').textContent = `סה״כ ${fmtNum(cartUnits())} יחידות`;
  foot.style.display = 'block';
}

async function submitOrder() {
  if (state.submitting) return;
  showError('cartError', '');
  if (isGuest && !(await validateGuestCartBeforeSubmit())) return;

  const items = [];
  for (const [model, sizes] of Object.entries(state.cart)) {
    for (const [size, qty] of Object.entries(sizes)) {
      if (qty > 0) items.push({ model, size, qty });
    }
  }
  if (!items.length) { showError('cartError', 'הסל ריק'); return; }

  if (isGuest && $('guestOrderFields').hidden) {
    $('guestOrderFields').hidden = false;
    $('cartOverlay').classList.add('guest-checkout');
    $('guestBusiness').focus();
    $('guestOrderFields').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return;
  }

  const guestBusiness = isGuest ? $('guestBusiness').value.trim() : '';
  const guestEmail = isGuest ? $('guestEmail').value.trim() : '';
  const guestPhone = isGuest ? $('guestPhone').value.trim() : '';
  if (isGuest && !guestBusiness) {
    showError('cartError', 'יש למלא שם העסק');
    $('guestBusiness').focus();
    return;
  }
  if (isGuest && guestEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guestEmail)) {
    showError('cartError', 'כתובת האימייל אינה תקינה');
    $('guestEmail').focus();
    return;
  }

  state.submitting = true;
  const btn = $('submitOrderBtn');
  btn.disabled = true;
  btn.textContent = 'שולח…';

  try {
    const params = isGuest ? {
      p_business_name: guestBusiness,
      p_phone: guestPhone || null,
      p_email: guestEmail || null,
      p_notes: $('orderNotes').value.trim() || null,
      p_items: items,
    } : {
      p_contact_name: state.customer?.business_name || state.customer?.name || state.profile?.full_name || 'לקוח',
      p_phone: state.customer?.phone || state.profile?.phone || null,
      p_email: customerEmails(state.customer)[0] || state.profile?.email || null,
      p_notes: $('orderNotes').value.trim() || null,
      p_items: items,
    };
    const { data, error } = await sb.rpc(isGuest ? 'submit_guest_order' : 'create_order', params);
    if (error) throw error;

    state.cart = {};
    $('orderNotes').value = '';
    if (isGuest) {
      $('guestOrderFields').hidden = true;
      $('cartOverlay').classList.remove('guest-checkout');
      $('guestBusiness').value = '';
      $('guestEmail').value = '';
      $('guestPhone').value = '';
    }
    updateBadge();
    closeCart();

    $('successMsg').textContent =
      `הזמנה מס׳ ${data.order_number} · ${fmtNum(data.total_units)} יחידות`;
    $('successFollowup').textContent = isGuest && !guestEmail
      ? 'ההזמנה התקבלה. ניצור קשר לתיאום אספקה אם הוזן מספר טלפון.'
      : 'שלחנו לך מייל אישור. ניצור קשר לתיאום אספקה.';
    $('successOrders').style.display = isGuest ? 'none' : '';
    view('successView', '✅ נשלח', '');
    $$('.bn-item').forEach((b) => b.classList.remove('active'));

    notifyNewOrder(data.order_id, data.notification_token);
    loadCatalog();
  } catch (err) {
    console.error(err);
    showError('cartError', friendlyError(err));
  } finally {
    state.submitting = false;
    btn.disabled = false;
    btn.textContent = 'שלח הזמנה';
  }
}

// שליחת המיילים היא best-effort: הזמנה שנשמרה לא נכשלת בגלל מייל
async function notifyNewOrder(orderId, notificationToken = null) {
  try {
    await sb.functions.invoke('order-email', {
      body: { order_id: orderId, event: 'created', notification_token: notificationToken },
    });
  } catch (err) {
    console.warn('order-email failed', err);
  }
}

function openCart()  { renderCart(); $('cartOverlay').classList.add('active'); }
function closeCart() {
  $('cartOverlay').classList.remove('active');
  const active = $('catalogView').classList.contains('active') ? 'catalog' : 'orders';
  $$('.bn-item').forEach((b) => b.classList.toggle('active', b.dataset.nav === active));
}

// ============================================================
// האזור האישי
//
// "ממתינות" = הזמנות שעדיין בטיפול. ברגע שהמנהל מסמן "נשלחה"
// ההזמנה עוברת ל"היסטוריה". לחיצה על הזמנה פותחת את הפירוט
// המלא — מה הוזמן ומה סופק בפועל. חשבונית מסומנת באייקון על
// הכרטיס עצמו, ולחיצה עליו מורידה אותה ישירות.
// ============================================================
let looseInvoices = [];

async function loadMyOrders() {
  const box = $('myOrdersList');
  box.innerHTML = '<div class="loading"><div class="spinner"></div>טוען…</div>';

  try {
    const [{ data: orders, error: e1 }, { data: invoices, error: e2 }] = await Promise.all([
      sb.from('orders')
        .select('*, order_items(model, size, qty, qty_ordered, unit_price)')
        .order('created_at', { ascending: false }),
      sb.from('invoices').select('*').order('issued_at', { ascending: false }),
    ]);
    if (e1) throw e1;
    if (e2) throw e2;

    myOrders = orders || [];
    myInvoices = new Map();
    looseInvoices = [];
    for (const v of invoices || []) {
      if (!v.order_id) { looseInvoices.push(v); continue; }
      if (!myInvoices.has(v.order_id)) myInvoices.set(v.order_id, []);
      myInvoices.get(v.order_id).push(v);
    }

    renderMyOrders();
  } catch (err) {
    box.innerHTML = `<div class="empty"><div class="ico">⚠️</div>${esc(friendlyError(err))}</div>`;
  }
}

function renderMyOrders() {
  const box  = $('myOrdersList');
  const open = myOrders.filter(isOpenOrder);
  const hist = myOrders.filter((o) => !isOpenOrder(o));

  $('cntOpen').textContent    = open.length;
  $('cntHistory').textContent = hist.length;
  $$('#myOrderTabs button').forEach((b) => b.classList.toggle('on', b.dataset.mine === myOrderTab));

  const list = myOrderTab === 'open' ? open : hist;

  if (!myOrders.length) {
    box.innerHTML = `<div class="empty"><div class="ico">📋</div>עדיין אין הזמנות
      <div style="margin-top:1rem"><button class="btn sm" id="goCatalog">להזמנה ראשונה</button></div></div>`;
    on('goCatalog', 'click', () => nav('catalog'));
    return;
  }

  if (!list.length) {
    box.innerHTML = myOrderTab === 'open'
      ? `<div class="empty"><div class="ico">✅</div>אין הזמנות בטיפול כרגע
         <div style="margin-top:1rem"><button class="btn sm" id="goCatalog">להזמנה חדשה</button></div></div>`
      : `<div class="empty"><div class="ico">📚</div>ההיסטוריה תתמלא ברגע שהזמנה תישלח</div>`;
    on('goCatalog', 'click', () => nav('catalog'));
    return;
  }

  box.innerHTML = list.map((o) => {
    const lines = (o.order_items || []);
    const invs  = myInvoices.get(o.id) || [];
    const st    = ORDER_STATUS[o.status] || {};
    const short = lines.some((l) => (l.qty_ordered ?? l.qty) !== l.qty);

    return `<div class="order-card clickable" data-open-order="${o.id}">
      <div class="order-head">
        <span class="order-no">#${o.order_number}</span>
        ${statusChip(ORDER_STATUS, o.status)}
        <span class="grow"></span>
        ${invs.length ? `<button class="inv-icon" data-dl="${esc(invs[0].file_path)}"
            data-name="${esc(invs[0].file_name || 'invoice.pdf')}"
            title="הורדת החשבונית" aria-label="הורדת החשבונית של הזמנה ${o.order_number}">
            🧾${invs.length > 1 ? `<span class="n">${invs.length}</span>` : ''}
          </button>` : ''}
        <span class="muted small nowrap">${fmtDate(o.created_at, false)}</span>
      </div>

      <div class="order-meta">
        ${fmtNum(o.total_units)} יחידות · ${lines.length} דגמים
        ${short ? ' · <span class="qty-diff">סופק חלקית</span>' : ''}
        ${o.notes ? `<div class="muted small" style="margin-top:.25rem">📝 ${esc(o.notes)}</div>` : ''}
      </div>

      ${isOpenOrder(o)
        ? `<div class="ship-note">${st.icon} ${esc(st.label)} — נעדכן אותך ברגע שתישלח</div>`
        : ''}

      <div class="small" style="color:var(--accent-ink);font-weight:700">
        לחץ לפירוט המלא ←
      </div>
    </div>`;
  }).join('')
  + (myOrderTab === 'history' && looseInvoices.length ? `
    <div class="order-card">
      <div class="oi-title">🧾 חשבוניות שאינן משויכות להזמנה</div>
      ${looseInvoices.map((v) => `
        <button class="inv-row" data-dl="${esc(v.file_path)}" data-name="${esc(v.file_name || 'invoice.pdf')}">
          <span class="grow"><b>${esc(v.invoice_number || 'חשבונית')}</b>
          <span class="muted small"> · ${fmtDate(v.issued_at, false)}</span></span>
          <span class="dl">⬇️ הורדה</span>
        </button>`).join('')}
    </div>` : '');

  box.onclick = async (e) => {
    const dl = e.target.closest('[data-dl]');
    if (dl) { e.stopPropagation(); await downloadInvoice(dl); return; }
    const card = e.target.closest('[data-open-order]');
    if (card) openMyOrder(card.dataset.openOrder);
  };
}

async function downloadInvoice(btn) {
  btn.disabled = true;
  try {
    const { data: sig, error } = await sb.storage
      .from('invoices').createSignedUrl(btn.dataset.dl, 3600, { download: btn.dataset.name });
    if (error) throw error;
    window.open(sig.signedUrl, '_blank', 'noopener');
  } catch (err) {
    toast(friendlyError(err), true);
  } finally {
    btn.disabled = false;
  }
}

// ── פירוט הזמנה: מה הוזמן מול מה התקבל ──────────────────────
function openMyOrder(id) {
  const o = myOrders.find((x) => x.id === id);
  if (!o) return;

  const lines = (o.order_items || []).slice()
    .sort((a, b) => a.model.localeCompare(b.model, 'he') || sortSizes(a.size, b.size));
  const invs  = myInvoices.get(o.id) || [];
  const st    = ORDER_STATUS[o.status] || {};
  const done  = o.status === 'shipped' || o.status === 'paid';
  const ordered  = lines.reduce((a, l) => a + (l.qty_ordered ?? l.qty), 0);
  const supplied = lines.reduce((a, l) => a + l.qty, 0);
  const short    = ordered !== supplied;

  $('myOrderTitle').textContent = `הזמנה #${o.order_number}`;
  $('myOrderBody').innerHTML = `
    <div class="row" style="margin-bottom:.9rem">
      ${statusChip(ORDER_STATUS, o.status)}
      <span class="muted small">${fmtDate(o.created_at)}</span>
    </div>

    <div class="order-invoices-top">
      <h4 class="bold" style="margin:.5rem 0">🧾 חשבוניות (${invs.length})</h4>
      ${invs.length
        ? invs.map((v) => `
            <button class="inv-row" data-dl="${esc(v.file_path)}" data-name="${esc(v.file_name || 'invoice.pdf')}">
              <span class="grow">
                <b>${esc(v.invoice_number || 'חשבונית')}</b>
                <span class="muted small"> · ${fmtDate(v.issued_at, false)}</span>
              </span>
              <span class="dl">⬇️ הורדה</span>
            </button>`).join('')
        : '<div class="small muted">עדיין לא הופקה חשבונית להזמנה הזו</div>'}
    </div>

    ${done
      ? `<div class="ship-note">${st.icon} ${esc(st.label)}${
          o.shipped_at ? ` ב-${fmtDate(o.shipped_at, false)}` : ''} — למטה מה שנשלח בפועל</div>`
      : `<div class="ship-note">${st.icon} ${esc(st.label)} — הכמויות עוד עשויות להשתנות לפי המלאי</div>`}

    ${short ? `<div class="note warn small">
      הזמנת <b>${fmtNum(ordered)}</b> יחידות והתקבלו <b>${fmtNum(supplied)}</b>.
      השורות שהשתנו מסומנות בטבלה.</div>` : ''}

    <div class="table-wrap" style="margin-bottom:1rem">
      <table class="responsive"><thead><tr>
        <th>דגם</th><th>מידה</th>
        ${short ? '<th class="num">הוזמן</th><th class="num">התקבל</th>' : '<th class="num">כמות</th>'}
      </tr></thead><tbody>
      ${lines.map((l) => {
        const ord = l.qty_ordered ?? l.qty;
        const diff = ord !== l.qty;
        return `<tr class="${diff ? 'short' : ''}">
          <td data-label="דגם" class="bold">${esc(l.model)}</td>
          <td data-label="מידה">${esc(l.size)}</td>
          ${short
            ? `<td data-label="הוזמן" class="num">${ord}</td>
               <td data-label="התקבל" class="num ${diff ? 'qty-diff' : ''}">${l.qty}</td>`
            : `<td data-label="כמות" class="num bold">${l.qty}</td>`}
        </tr>`;
      }).join('')}
      </tbody><tfoot><tr>
        <td colspan="2">סה״כ ${lines.length} דגמים</td>
        ${short ? `<td class="num">${fmtNum(ordered)}</td><td class="num">${fmtNum(supplied)}</td>`
                : `<td class="num">${fmtNum(supplied)}</td>`}
      </tr></tfoot></table>
    </div>

    ${o.notes ? `<div class="note small"><b>ההערה שלך:</b> ${esc(o.notes)}</div>` : ''}
  `;

  $('myOrderFoot').innerHTML =
    `<button class="btn block" id="closeMyOrderFoot">סגירה</button>`;

  $('myOrderBody').onclick = async (e) => {
    const dl = e.target.closest('[data-dl]');
    if (dl) await downloadInvoice(dl);
  };
  on('closeMyOrderFoot', 'click', closeMyOrder);

  $('orderOverlay').classList.add('active');
}

function closeMyOrder() { $('orderOverlay').classList.remove('active'); }

async function exportMyOrders() {
  if (!myOrders.length) { toast('אין הזמנות לייצוא', true); return; }
  const rows = [];
  for (const o of myOrders) {
    for (const l of o.order_items || []) {
      rows.push({
        'מס׳ הזמנה': o.order_number,
        'תאריך': fmtDate(o.created_at, false),
        'סטטוס': ORDER_STATUS[o.status]?.label || o.status,
        'דגם': l.model,
        'מידה': l.size,
        'הוזמן': l.qty_ordered ?? l.qty,
        'התקבל': l.qty,
      });
    }
  }
  await exportXlsx('ההזמנות_שלי', [{ name: 'הזמנות', rows }]);
  toast('הקובץ יורד…');
}

// ============================================================
// חיווט
// ============================================================
function wire() {
  on('googleBtn',    'click', handleGoogle);
  on('authSubmit',   'click', handleEmailAuth);
  on('authToggle',   'click', () => setAuthMode(authMode === 'signin' ? 'signup' : 'signin'));
  on('guestBtn',     'click', startGuest);
  on('guestExitBtn', 'click', exitGuest);
  on('authPassword', 'keydown', (e) => { if (e.key === 'Enter') handleEmailAuth(); });
  on('authEmail',    'keydown', (e) => { if (e.key === 'Enter') $('authPassword').focus(); });

  on('pfSave',    'click', saveProfile);
  on('pfCity',    'keydown', (e) => { if (e.key === 'Enter') saveProfile(); });
  on('pfSignout', 'click', signOut);

  on('accountBtn', 'click', (e) => { e.stopPropagation(); $('accountMenu').classList.toggle('open'); });
  document.addEventListener('click', () => $('accountMenu')?.classList.remove('open'));

  on('navPersonalArea', 'click', () => nav('orders'));
  on('navAdmin',   'click', () => {
    setCustomerPreview(false);
    window.location.href = 'admin.html';
  });
  on('previewBackAdmin', 'click', () => setCustomerPreview(false));
  on('navSignout', 'click', signOut);

  on('accountProfileSave', 'click', saveAccountProfile);
  on('accountCity', 'keydown', (e) => { if (e.key === 'Enter') saveAccountProfile(); });

  $('bottomNav').onclick = (e) => {
    const b = e.target.closest('[data-nav]');
    if (b) nav(b.dataset.nav);
  };

  on('cartBtn',      'click', openCart);
  on('closeCartBtn', 'click', closeCart);
  on('cartOverlay',  'click', (e) => { if (e.target.id === 'cartOverlay') closeCart(); });
  on('clearCartBtn', 'click', () => {
    state.cart = {};
    renderCart(); renderProducts(); updateBadge();
  });
  on('submitOrderBtn', 'click', submitOrder);

  on('searchInput', 'input', debounce(renderProducts, 180));
  on('exportMyOrders', 'click', exportMyOrders);

  $('viewToggle').onclick = (e) => {
    const b = e.target.closest('[data-view]');
    if (b) setCatalogView(b.dataset.view);
  };
  $$('#viewToggle button').forEach((b) => b.classList.toggle('on', b.dataset.view === catalogView));

  $('myOrderTabs').onclick = (e) => {
    const b = e.target.closest('[data-mine]');
    if (!b) return;
    myOrderTab = b.dataset.mine;
    renderMyOrders();
  };

  on('closeMyOrder',  'click', closeMyOrder);
  on('orderOverlay',  'click', (e) => { if (e.target.id === 'orderOverlay') closeMyOrder(); });

  on('successBack',   'click', () => nav('catalog'));
  on('successOrders', 'click', () => nav('orders'));

  on('imgModal',      'click', (e) => { if (e.target.id === 'imgModal') closeImgModal(); });
  on('closeImgModal', 'click', closeImgModal);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    closeImgModal();
    closeMyOrder();
    if ($('cartOverlay').classList.contains('active')) closeCart();
  });

  setAuthMode('signin');
  document.title = `${BRAND} — הזמנות`;
}

function closeImgModal() {
  $('imgModal').classList.remove('active');
  $('modalImg').src = '';
}

init();
