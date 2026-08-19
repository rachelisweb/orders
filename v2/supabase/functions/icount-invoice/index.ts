import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const ICOUNT_BASE = 'https://api.icount.co.il/api/v3.php';
const VAT_PERCENT = 18;

type OrderItem = {
  id: number; product_id: string | null; model: string; size: string;
  qty: number; unit_price: number;
};

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...CORS, 'Content-Type': 'application/json' },
});

function israelToday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

function endOfMonth(dateISO: string) {
  const [year, month] = dateISO.split('-').map(Number);
  return `${year}-${String(month).padStart(2, '0')}-${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, '0')}`;
}

async function sha256(value: unknown) {
  const data = new TextEncoder().encode(JSON.stringify(value));
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function deepFind(obj: unknown, key: string): unknown {
  if (!obj || typeof obj !== 'object') return undefined;
  if (key in (obj as Record<string, unknown>)) return (obj as Record<string, unknown>)[key];
  for (const value of Object.values(obj as Record<string, unknown>)) {
    const found = deepFind(value, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

function recordValues(value: unknown) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).map(([key, item]) => (
    item && typeof item === 'object' ? { _key: key, ...(item as Record<string, unknown>) } : { _key: key }
  ));
}

function icountClientSummary(value: any) {
  return {
    client_id: Number(value?.client_id || value?._key || 0),
    custom_client_id: String(value?.custom_client_id || ''),
    vat_id: String(value?.vat_id || ''),
    name: String(value?.company_name || value?.client_name || [value?.fname, value?.lname].filter(Boolean).join(' ') || ''),
    email: String(value?.email || ''),
    phone: String(value?.mobile || value?.phone || ''),
    city: String(value?.bus_city || ''),
    address: [value?.bus_street, value?.bus_no].filter(Boolean).join(' '),
  };
}

function icountClientList(value: any) {
  return recordValues(deepFind(value, 'clients'))
    .map(icountClientSummary)
    .filter((client) => Number.isInteger(client.client_id) && client.client_id > 0);
}

async function loadIcountCapabilities(token: string) {
  const [typesResult, bankAccountsResult] = await Promise.all([
    icountCall(token, 'doc/types', {}),
    icountCall(token, 'company/bank_accounts', { list_type: 'object' }).catch(() => ({})),
  ]);

  const doctypes = recordValues(deepFind(typesResult, 'doctypes')).map((item: any) => ({
    code: String(item?.doctype || item?._key || ''),
    title: String(item?.title || item?.name || item?.doctype || item?._key || ''),
  })).filter((item) => item.code);

  const bankAccounts = recordValues(deepFind(bankAccountsResult, 'bank_accounts')).map((item: any) => ({
    id: String(item?.account_id || item?._key || ''),
    title: String(item?.title || [item?.bank, item?.branch, item?.account].filter(Boolean).join('-') || 'חשבון בנק'),
  })).filter((item) => item.id);

  // Bank transfers and cheques are first-class doc/create fields in iCount.
  // They are not guaranteed to appear in payment_method/get_list, which is
  // intended mainly for additional/generic payment methods.
  const paymentMethods = [
    { code: 'banktransfer', name: 'העברה בנקאית' },
    { code: 'cheques', name: 'צ׳קים' },
  ];

  return { doctypes, payment_methods: paymentMethods, bank_accounts: bankAccounts };
}

async function icountCall(token: string, path: string, body: Record<string, unknown>) {
  const response = await fetch(`${ICOUNT_BASE}/${path}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let data: any;
  try { data = JSON.parse(text); }
  catch { throw new Error(`iCount החזיר תשובה לא תקינה (${response.status})`); }
  if (!response.ok || data?.status === false) {
    const message = data?.error_description || data?.reason || data?.error || `שגיאת iCount (${response.status})`;
    const error = new Error(String(message));
    (error as any).code = data?.error || data?.reason_code;
    (error as any).raw = data;
    throw error;
  }
  return data;
}

function invoiceLines(orderItems: OrderItem[], descriptions: Map<string, string>) {
  const groups = new Map<string, any>();
  for (const item of orderItems) {
    const qty = Number(item.qty || 0);
    const unitPrice = Number(item.unit_price || 0);
    if (qty <= 0) continue;
    const key = `${item.model}\u0000${unitPrice.toFixed(2)}`;
    if (!groups.has(key)) groups.set(key, {
      sku: item.model,
      model: item.model,
      description: descriptions.get(item.product_id || '') || '',
      quantity: 0,
      unitprice: unitPrice,
    });
    groups.get(key).quantity += qty;
  }
  return [...groups.values()];
}

function flexibleLines(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    throw new Error('יש להזין בין 1 ל-100 פריטים');
  }
  return value.map((raw: any, index: number) => {
    const sku = String(raw?.sku || '').trim().slice(0, 100);
    const description = String(raw?.description || '').trim().slice(0, 500);
    const quantity = Number(raw?.quantity);
    const unitprice = round2(Number(raw?.unitprice));
    if (!sku && !description) throw new Error(`חסר דגם או פירוט בפריט ${index + 1}`);
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 100000) throw new Error(`כמות לא תקינה בפריט ${index + 1}`);
    if (!Number.isFinite(unitprice) || unitprice <= 0 || unitprice > 10000000) throw new Error(`מחיר לא תקין בפריט ${index + 1}`);
    return { sku, description: description || sku, quantity, unitprice };
  });
}

function validISODate(value: unknown) {
  const text = String(value || '');
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) throw new Error('תאריך לא תקין');
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (date.getUTCFullYear() !== Number(match[1]) || date.getUTCMonth() + 1 !== Number(match[2])
      || date.getUTCDate() !== Number(match[3])) {
    throw new Error('תאריך לא תקין');
  }
  return text;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'POST בלבד' }, 405);

  const service = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
  let orderId = '';
  let returnId = '';
  let flexibleRequestId = '';
  let externalCreated = false;
  let externalDocnum = '';

  try {
    const jwt = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: { user }, error: authError } = await service.auth.getUser(jwt);
    if (authError || !user) return jsonResponse({ ok: false, error: 'נדרשת התחברות' }, 401);
    const { data: profile } = await service.from('profiles').select('role').eq('id', user.id).maybeSingle();
    if (profile?.role !== 'admin') return jsonResponse({ ok: false, error: 'הפקת חשבונית מותרת למנהל בלבד' }, 403);

    const body = await req.json();
    if (!['health', 'client_search', 'client_link', 'client_create', 'client_unlink', 'preview', 'create', 'refund_preview', 'refund_create', 'flexible_preview', 'flexible_create'].includes(body?.action)) {
      return jsonResponse({ ok: false, error: 'action לא חוקי' }, 400);
    }

    // בדיקת חיבור לקריאה בלבד. הנתיב הזה לעולם אינו קורא ל-doc/create.
    if (body.action === 'health') {
      const token = Deno.env.get('ICOUNT_API_TOKEN') || '';
      if (!token) return jsonResponse({ ok: false, error: 'ICOUNT_API_TOKEN לא הוגדר בפונקציית השרת' }, 503);
      const capabilities = await loadIcountCapabilities(token);
      return jsonResponse({
        ok: true,
        mode: 'read_only',
        invoice_type_available: capabilities.doctypes.some((item) => item.code === 'invoice'),
        ...capabilities,
      });
    }

    if (['client_search', 'client_link', 'client_create', 'client_unlink'].includes(body.action)) {
      const customerId = String(body.customer_id || '');
      if (!/^[0-9a-f-]{36}$/i.test(customerId)) return jsonResponse({ ok: false, error: 'מזהה לקוח לא תקין' }, 400);
      const { data: customer, error: customerError } = await service.from('customers').select('*').eq('id', customerId).maybeSingle();
      if (customerError || !customer) return jsonResponse({ ok: false, error: 'הלקוח לא נמצא' }, 404);

      if (body.action === 'client_unlink') {
        const { error } = await service.from('customers').update({
          icount_client_id: null, icount_client_name: null, icount_linked_at: null, icount_linked_by: null,
        }).eq('id', customerId);
        if (error) throw error;
        return jsonResponse({ ok: true });
      }

      const token = Deno.env.get('ICOUNT_API_TOKEN') || '';
      if (!token) return jsonResponse({ ok: false, error: 'ICOUNT_API_TOKEN לא הוגדר בפונקציית השרת' }, 503);

      if (body.action === 'client_search') {
        const query = String(body.query || '').trim().slice(0, 120);
        const searches: Record<string, unknown>[] = [];
        if (query) {
          searches.push({ client_name: query });
          if (query.includes('@')) searches.push({ email: query });
          const digits = query.replace(/\D/g, '');
          if (digits.length >= 5) searches.push({ vat_id: digits }, { phone: digits }, { mobile: digits });
        } else {
          const vatId = String(customer.tax_id || '').replace(/\D/g, '');
          const phone = String(customer.phone || '').replace(/\D/g, '');
          const email = String(customer.email || '').trim();
          const name = String(customer.business_name || customer.name || '').trim();
          if (vatId) searches.push({ vat_id: vatId });
          if (phone) searches.push({ phone }, { mobile: phone });
          if (email) searches.push({ email });
          if (name) searches.push({ client_name: name });
        }
        const results = await Promise.all(searches.slice(0, 6).map((filter) =>
          icountCall(token, 'client/get_list', { ...filter, detail_level: 3, limit: 30, list_type: 'array' }).catch(() => ({}))
        ));
        const unique = new Map<number, ReturnType<typeof icountClientSummary>>();
        results.flatMap(icountClientList).forEach((client) => unique.set(client.client_id, client));
        return jsonResponse({ ok: true, clients: [...unique.values()].slice(0, 50) });
      }

      if (body.action === 'client_link') {
        const clientId = Number(body.icount_client_id);
        if (!Number.isInteger(clientId) || clientId <= 0) return jsonResponse({ ok: false, error: 'מספר לקוח iCount אינו תקין' }, 400);
        const info = await icountCall(token, 'client/info', { client_id: clientId });
        const client = icountClientSummary(deepFind(info, 'client_info'));
        if (!client.client_id) throw new Error('כרטיס הלקוח לא נמצא ב־iCount');
        const localEmails = Array.isArray(customer.email_recipients) ? customer.email_recipients : [];
        const importedEmail = String(client.email || '').trim().toLowerCase();
        const emailRecipients = [...new Set([
          ...localEmails.map((email: unknown) => String(email || '').trim().toLowerCase()),
          String(customer.email || '').trim().toLowerCase(), importedEmail,
        ].filter(Boolean))];
        const { error } = await service.from('customers').update({
          icount_client_id: client.client_id, icount_client_name: client.name,
          icount_linked_at: new Date().toISOString(), icount_linked_by: user.id,
          tax_id: customer.tax_id || client.vat_id || null,
          phone: customer.phone || client.phone || null,
          email: customer.email || client.email || null,
          email_recipients: emailRecipients,
          city: customer.city || client.city || null,
          address: customer.address || client.address || null,
        }).eq('id', customerId);
        if (error) throw error;
        return jsonResponse({ ok: true, client });
      }

      const clientName = String(customer.business_name || customer.name || '').trim();
      if (!clientName) return jsonResponse({ ok: false, error: 'חסר שם לקוח' }, 400);
      // Recovery/idempotency: a previous call may have created the iCount card
      // and failed before the local link was saved. Reuse it instead of creating a duplicate.
      const existingByCustomId = await icountCall(token, 'client/get_list', {
        custom_client_id: customer.id, detail_level: 1, limit: 2, list_type: 'array',
      }).catch(() => ({}));
      const recovered = icountClientList(existingByCustomId)[0];
      if (recovered?.client_id) {
        const { error } = await service.from('customers').update({
          icount_client_id: recovered.client_id, icount_client_name: recovered.name || clientName,
          icount_linked_at: new Date().toISOString(), icount_linked_by: user.id,
        }).eq('id', customerId);
        if (error) throw error;
        return jsonResponse({ ok: true, client: recovered, recovered: true });
      }
      const created = await icountCall(token, 'client/create', {
        custom_client_id: customer.id,
        client_name: clientName,
        vat_id: String(customer.tax_id || '').replace(/\D/g, '') || undefined,
        email: customer.email || undefined,
        phone: customer.phone || undefined,
        bus_city: customer.city || undefined,
        bus_street: customer.address || undefined,
        notes: 'נוצר ממערכת ההזמנות',
      });
      const clientId = Number(deepFind(created, 'client_id') || 0);
      if (!clientId) throw new Error('iCount יצר לקוח אך לא החזיר מספר לקוח');
      const { error } = await service.from('customers').update({
        icount_client_id: clientId, icount_client_name: clientName,
        icount_linked_at: new Date().toISOString(), icount_linked_by: user.id,
      }).eq('id', customerId);
      if (error) throw error;
      return jsonResponse({ ok: true, client: { client_id: clientId, name: clientName }, created: true });
    }

    if (body.action === 'refund_preview' || body.action === 'refund_create') {
      returnId = String(body?.return_id || '');
      if (!returnId) return jsonResponse({ ok: false, error: 'חסר return_id' }, 400);

      const { data: returnRow, error: returnError } = await service.from('returns')
        .select('*').eq('id', returnId).single();
      if (returnError || !returnRow) return jsonResponse({ ok: false, error: 'החזרה לא נמצאה' }, 404);
      if (returnRow.status !== 'pending') {
        return jsonResponse({ ok: false, error: 'ניתן להפיק חשבונית זיכוי רק לחזרה ממתינה' }, 409);
      }
      if (!returnRow.customer_id) {
        return jsonResponse({ ok: false, error: 'יש לשייך את החזרה לכרטיס לקוח לפני הפקת הזיכוי' }, 409);
      }

      const { data: existingRefund } = await service.from('invoices')
        .select('id, invoice_number, file_path')
        .eq('return_id', returnId).neq('status', 'cancelled').limit(1).maybeSingle();
      if (existingRefund) {
        if (body.action === 'refund_create') {
          return jsonResponse({
            ok: true, reused: true, invoice_number: existingRefund.invoice_number,
            invoice_id: existingRefund.id, doctype: 'refund', document_title: 'חשבונית זיכוי',
          });
        }
        return jsonResponse({ ok: false, error: 'כבר קיימת חשבונית זיכוי לחזרה זו', invoice: existingRefund }, 409);
      }

      const [{ data: customer, error: customerError }, { data: returnItems, error: itemsError }] = await Promise.all([
        service.from('customers').select('*').eq('id', returnRow.customer_id).single(),
        service.from('return_items').select('*').eq('return_id', returnId),
      ]);
      if (customerError || !customer) return jsonResponse({ ok: false, error: 'כרטיס הלקוח של החזרה לא נמצא' }, 409);
      if (itemsError) throw itemsError;
      if (!returnItems?.length) return jsonResponse({ ok: false, error: 'אין פריטים בחזרה' }, 409);

      const productIds = [...new Set(returnItems.map((item: any) => item.product_id).filter(Boolean))];
      const { data: products, error: productsError } = productIds.length
        ? await service.from('products').select('id, model, description, wholesale_price, cost_price').in('id', productIds)
        : { data: [], error: null };
      if (productsError) throw productsError;
      const productsById = new Map<string, any>();
      for (const product of products || []) productsById.set(product.id, product);

      const returnDateEnd = `${String(returnRow.return_date || israelToday()).slice(0, 10)}T23:59:59.999Z`;
      const { data: priorOrders, error: priorOrdersError } = await service.from('orders')
        .select('created_at, subtotal_amount, discount_amount, order_items(model, unit_price)')
        .eq('customer_id', customer.id)
        .in('status', ['ready', 'shipped'])
        .lte('created_at', returnDateEnd)
        .order('created_at', { ascending: false })
        .limit(200);
      if (priorOrdersError) throw priorOrdersError;

      const priceForModel = (model: string, product: any) => {
        for (const prior of priorOrders || []) {
          const matching = (prior.order_items || []).find((item: any) => item.model === model && Number(item.unit_price) > 0);
          if (!matching) continue;
          const subtotal = Number(prior.subtotal_amount || 0);
          const discount = Math.min(Math.max(Number(prior.discount_amount || 0), 0), subtotal);
          return round2(Number(matching.unit_price) * (subtotal > 0 ? (subtotal - discount) / subtotal : 1));
        }
        const base = Number(customer.price_at_cost ? product?.cost_price : product?.wholesale_price);
        if (!Number.isFinite(base) || base <= 0) return 0;
        const discountPct = customer.price_at_cost ? 0 : Math.min(Math.max(Number(customer.discount_pct || 0), 0), 100);
        return round2(base * (1 - discountPct / 100));
      };

      const grouped = new Map<string, any>();
      for (const item of returnItems) {
        const quantity = Number(item.qty || 0);
        if (quantity <= 0) continue;
        const model = String(item.model || '').trim();
        const product: any = productsById.get(item.product_id);
        const unitprice = priceForModel(model, product);
        if (!model || unitprice <= 0) {
          return jsonResponse({ ok: false, error: `לא נמצא מחיר לזיכוי עבור הדגם ${model || 'ללא מספר'}` }, 409);
        }
        const key = `${model}\u0000${unitprice.toFixed(2)}`;
        if (!grouped.has(key)) grouped.set(key, {
          sku: model,
          description: product?.description || model,
          quantity: 0,
          unitprice,
        });
        grouped.get(key).quantity += quantity;
      }
      const lines = [...grouped.values()];
      if (!lines.length) return jsonResponse({ ok: false, error: 'אין פריטים שניתן לזכות' }, 409);

      const subtotal = round2(lines.reduce((sum, item) => sum + item.quantity * item.unitprice, 0));
      const vat = round2(subtotal * VAT_PERCENT / 100);
      const totalWithVat = round2(subtotal + vat);
      const clientName = customer.business_name || customer.name || returnRow.returner_name;
      if (!customer.icount_client_id) return jsonResponse({ ok: false, error: 'יש לקשר את הלקוח לכרטיס iCount לפני הפקת זיכוי' }, 409);
      const docDate = israelToday();
      const fingerprint = await sha256({
        return_id: returnId, customer_id: customer.id, clientName, lines, subtotal, vat: VAT_PERCENT, docDate,
      });
      const preview = {
        lines, subtotal, vat, total_with_vat: totalWithVat, doc_date: docDate,
        doctype: 'refund', document_title: 'חשבונית זיכוי', client_name: clientName,
        tax_id: customer.tax_id || '', return_number: returnRow.return_number,
      };
      if (body.action === 'refund_preview') return jsonResponse({ ok: true, preview, fingerprint });

      const token = Deno.env.get('ICOUNT_API_TOKEN') || '';
      if (!token) return jsonResponse({ ok: false, error: 'ICOUNT_API_TOKEN לא הוגדר בפונקציית השרת' }, 503);
      const capabilities = await loadIcountCapabilities(token);
      if (!capabilities.doctypes.some((item) => item.code === 'refund')) {
        return jsonResponse({ ok: false, error: 'חשבונית זיכוי אינה זמינה בחשבון iCount' }, 409);
      }

      const sanity = `rcl-ret-${returnRow.return_number}-${returnId.replace(/-/g, '').slice(0, 8)}`.slice(0, 30);
      const { data: claim, error: claimError } = await service.rpc('claim_icount_refund_generation', {
        p_return_id: returnId, p_fingerprint: fingerprint, p_sanity_string: sanity,
      });
      if (claimError) throw claimError;
      if (!claim?.claimed) {
        if (claim?.status === 'succeeded') {
          return jsonResponse({ ok: true, reused: true, invoice_number: claim.docnum, doctype: 'refund', document_title: 'חשבונית זיכוי' });
        }
        if (claim?.status === 'processing') {
          return jsonResponse({ ok: false, error: 'הפקת חשבונית הזיכוי כבר מתבצעת. יש להמתין ולרענן.' }, 409);
        }
        return jsonResponse({ ok: false, error: claim?.error || 'ההפקה נעצרה לבדיקה ידנית כדי למנוע מסמך כפול' }, 409);
      }

      const { data: generation } = await service.from('icount_refund_generations')
        .select('*').eq('return_id', returnId).single();
      externalDocnum = generation?.external_docnum || '';
      let docUrl = generation?.external_url || '';
      if (!externalDocnum) {
        let created: any;
        try {
          created = await icountCall(token, 'doc/create', {
            doctype: 'refund',
            client_id: customer.icount_client_id,
            vat_id: String(customer.tax_id || '').replace(/\D/g, '') || undefined,
            email: customer.email || undefined,
            client_name: clientName,
            client_address: [customer.address, customer.city].filter(Boolean).join(', ') || undefined,
            doc_date: docDate,
            currency_code: 'ILS',
            vat_percent: VAT_PERCENT,
            items: lines.map((item) => ({
              sku: item.sku,
              description: item.description,
              quantity: item.quantity,
              unitprice: item.unitprice,
            })),
            hwc: `זיכוי עבור חזרה #${returnRow.return_number}`,
            sanity_string: sanity,
            doc_lang: 'he',
            send_email: false,
            send_sms: false,
          });
        } catch (error) {
          if (String((error as any)?.code || (error as Error).message).includes('doc_exists_based_on_sanity_string')) {
            await service.from('icount_refund_generations').update({
              status: 'needs_review', error: 'iCount דיווח שחשבונית הזיכוי כבר קיימת, אך מספרה לא נשמר. נדרשת בדיקה ידנית.', updated_at: new Date().toISOString(),
            }).eq('return_id', returnId);
          }
          throw error;
        }
        externalDocnum = String(deepFind(created, 'docnum') || '');
        docUrl = String(deepFind(created, 'doc_url') || '');
        externalCreated = true;
        if (!externalDocnum) throw new Error('iCount יצר חשבונית זיכוי אך לא החזיר מספר מסמך — ההפקה נעצרה לבדיקה');
        await service.from('icount_refund_generations').update({
          external_docnum: externalDocnum, external_url: docUrl, updated_at: new Date().toISOString(),
        }).eq('return_id', returnId);
      } else {
        externalCreated = true;
      }

      const info = await icountCall(token, 'doc/info', {
        doctype: 'refund', docnum: Number(externalDocnum), get_items: false,
        get_payments: false, get_pdf_link: true, lang: 'he',
      });
      const pdfLink = String(deepFind(info, 'pdf_link') || '');
      if (!pdfLink) throw new Error('חשבונית הזיכוי הופקה אך iCount לא החזיר קישור PDF — ניתן לנסות שוב בבטחה');
      const pdfResponse = await fetch(pdfLink);
      if (!pdfResponse.ok) throw new Error(`חשבונית הזיכוי הופקה אך הורדת ה-PDF נכשלה (${pdfResponse.status})`);
      const pdf = new Uint8Array(await pdfResponse.arrayBuffer());
      if (pdf.length < 500 || String.fromCharCode(...pdf.slice(0, 4)) !== '%PDF') {
        throw new Error('iCount החזיר קובץ שאינו PDF — חשבונית הזיכוי לא נשמרה בחזרה');
      }

      const fileName = `RACHELI-S-refund-${externalDocnum}.pdf`;
      const path = `${customer.id}/icount_refund_${externalDocnum}_${Date.now()}.pdf`;
      const { error: uploadError } = await service.storage.from('invoices').upload(path, pdf, {
        contentType: 'application/pdf', upsert: false,
      });
      if (uploadError) throw uploadError;
      const { data: invoice, error: invoiceError } = await service.from('invoices').insert({
        customer_id: customer.id,
        order_id: null,
        return_id: returnId,
        invoice_number: externalDocnum,
        amount: -totalWithVat,
        file_path: path,
        file_name: fileName,
        status: 'active',
        issued_at: docDate,
        uploaded_by: user.id,
        source: 'icount',
        external_doctype: 'refund',
        external_docnum: externalDocnum,
        external_url: docUrl || null,
      }).select('id, invoice_number, file_path').single();
      if (invoiceError) {
        await service.storage.from('invoices').remove([path]);
        throw invoiceError;
      }
      await service.from('icount_refund_generations').update({
        status: 'succeeded', invoice_id: invoice.id, error: null, updated_at: new Date().toISOString(),
      }).eq('return_id', returnId);
      return jsonResponse({
        ok: true, invoice_number: externalDocnum, invoice_id: invoice.id,
        total_with_vat: totalWithVat, doctype: 'refund', document_title: 'חשבונית זיכוי',
      });
    }

    if (body.action === 'flexible_preview' || body.action === 'flexible_create') {
      flexibleRequestId = String(body?.request_id || '');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(flexibleRequestId)) {
        return jsonResponse({ ok: false, error: 'מזהה בקשה לא תקין' }, 400);
      }
      const customerId = String(body?.customer_id || '');
      const { data: customer, error: customerError } = await service.from('customers').select('*').eq('id', customerId).single();
      if (customerError || !customer) return jsonResponse({ ok: false, error: 'הלקוח לא נמצא' }, 404);
      if (!customer.icount_client_id) return jsonResponse({ ok: false, error: 'יש לקשר את הלקוח לכרטיס iCount לפני הפקת מסמך' }, 409);

      const clientName = String(body?.client_name || '').trim().slice(0, 200);
      if (!clientName) return jsonResponse({ ok: false, error: 'חסר שם לקוח לחשבונית' }, 400);
      const vatId = String(body?.vat_id || '').replace(/\D/g, '').slice(0, 20);
      const email = String(body?.email || '').trim().slice(0, 254);
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return jsonResponse({ ok: false, error: 'כתובת המייל אינה תקינה' }, 400);
      const address = String(body?.address || '').trim().slice(0, 500);
      const notes = String(body?.notes || '').trim().slice(0, 1000);
      const docDate = validISODate(body?.doc_date);
      const paydate = validISODate(body?.paydate);
      if (paydate < docDate) return jsonResponse({ ok: false, error: 'תאריך התשלום מוקדם מתאריך ההפקה' }, 400);
      const lines = flexibleLines(body?.items);
      const subtotal = round2(lines.reduce((sum, line) => sum + line.quantity * line.unitprice, 0));
      const discount = round2(Number(body?.discount || 0));
      if (!Number.isFinite(discount) || discount < 0 || discount > subtotal) {
        return jsonResponse({ ok: false, error: 'ההנחה אינה תקינה' }, 400);
      }
      const beforeVat = round2(subtotal - discount);
      const vat = round2(beforeVat * VAT_PERCENT / 100);
      const totalWithVat = round2(beforeVat + vat);
      const normalized = {
        customer_id: customer.id, client_name: clientName, vat_id: vatId, email, address,
        doc_date: docDate, paydate, notes, lines, discount, subtotal, vat_percent: VAT_PERCENT,
      };
      const fingerprint = await sha256(normalized);
      const preview = { lines, subtotal, discount, before_vat: beforeVat, vat, total_with_vat: totalWithVat, doc_date: docDate, paydate };
      if (body.action === 'flexible_preview') return jsonResponse({ ok: true, preview, fingerprint });

      const token = Deno.env.get('ICOUNT_API_TOKEN') || '';
      if (!token) return jsonResponse({ ok: false, error: 'ICOUNT_API_TOKEN לא הוגדר בפונקציית השרת' }, 503);
      const sanity = `rcl-flex-${flexibleRequestId.replace(/-/g, '').slice(0, 20)}`;
      const now = new Date();
      const { error: insertClaimError } = await service.from('icount_flexible_invoice_generations').insert({
        request_id: flexibleRequestId, customer_id: customer.id, fingerprint, sanity_string: sanity, status: 'processing',
      });
      if (insertClaimError && insertClaimError.code !== '23505') throw insertClaimError;
      if (insertClaimError?.code === '23505') {
        const { data: existing, error: existingError } = await service.from('icount_flexible_invoice_generations')
          .select('*').eq('request_id', flexibleRequestId).single();
        if (existingError || !existing) throw existingError || new Error('לא ניתן לבדוק את בקשת ההפקה הקודמת');
        if (existing.fingerprint !== fingerprint) return jsonResponse({ ok: false, error: 'פרטי החשבונית השתנו לאחר ניסיון הפקה קודם' }, 409);
        if (existing.status === 'succeeded') {
          return jsonResponse({ ok: true, reused: true, invoice_number: existing.external_docnum, invoice_id: existing.invoice_id });
        }
        if (existing.status === 'needs_review') return jsonResponse({ ok: false, error: existing.error || 'נדרשת בדיקה ידנית לפני ניסיון נוסף' }, 409);
        const lockedAt = new Date(existing.locked_at || 0).getTime();
        if (existing.status === 'processing' && lockedAt > now.getTime() - 5 * 60 * 1000) {
          return jsonResponse({ ok: false, error: 'הפקת החשבונית כבר מתבצעת. יש להמתין ולרענן.' }, 409);
        }
        const { error: retryError } = await service.from('icount_flexible_invoice_generations').update({
          status: 'processing', attempts: Number(existing.attempts || 1) + 1, error: null,
          locked_at: now.toISOString(), updated_at: now.toISOString(),
        }).eq('request_id', flexibleRequestId);
        if (retryError) throw retryError;
      }

      const { data: generation, error: generationError } = await service.from('icount_flexible_invoice_generations')
        .select('*').eq('request_id', flexibleRequestId).single();
      if (generationError || !generation) throw generationError || new Error('יומן ההפקה לא נמצא');
      externalDocnum = String(generation.external_docnum || '');
      let docUrl = String(generation.external_url || '');
      if (!externalDocnum) {
        try {
          const created = await icountCall(token, 'doc/create', {
          doctype: 'invoice',
          client_id: customer.icount_client_id,
          vat_id: vatId || undefined,
          email: email || undefined,
          client_name: clientName,
          client_address: address || undefined,
          doc_date: docDate,
          paydate,
          currency_code: 'ILS',
          vat_percent: VAT_PERCENT,
          items: lines.map((line) => ({
            sku: line.sku || undefined,
            description: line.sku && line.description !== line.sku ? `${line.sku} — ${line.description}` : line.description,
            quantity: line.quantity,
            unitprice: line.unitprice,
          })),
          discount: discount || undefined,
          hwc: notes || undefined,
          sanity_string: sanity,
          doc_lang: 'he',
          send_email: false,
          send_sms: false,
          });
          externalDocnum = String(deepFind(created, 'docnum') || '');
          docUrl = String(deepFind(created, 'doc_url') || '');
          externalCreated = true;
          if (!externalDocnum) throw new Error('iCount יצר מסמך אך לא החזיר מספר מסמך — ההפקה נעצרה לבדיקה');
          await service.from('icount_flexible_invoice_generations').update({
            external_doctype: 'invoice', external_docnum: externalDocnum, external_url: docUrl,
            updated_at: new Date().toISOString(),
          }).eq('request_id', flexibleRequestId);
        } catch (error) {
          if (String((error as any)?.code || (error as Error).message).includes('doc_exists_based_on_sanity_string')) {
            await service.from('icount_flexible_invoice_generations').update({
              status: 'needs_review', error: 'iCount דיווח שהמסמך כבר קיים, אך מספרו לא נשמר. נדרשת בדיקה ידנית.',
              updated_at: new Date().toISOString(),
            }).eq('request_id', flexibleRequestId);
          }
          throw error;
        }
      } else {
        externalCreated = true;
      }

      const { data: storedInvoice, error: storedInvoiceError } = await service.from('invoices')
        .select('id, invoice_number').eq('source', 'icount').eq('external_doctype', 'invoice')
        .eq('external_docnum', externalDocnum).maybeSingle();
      if (storedInvoiceError) throw storedInvoiceError;
      if (storedInvoice) {
        await service.from('icount_flexible_invoice_generations').update({
          status: 'succeeded', invoice_id: storedInvoice.id, error: null, updated_at: new Date().toISOString(),
        }).eq('request_id', flexibleRequestId);
        return jsonResponse({ ok: true, reused: true, invoice_number: storedInvoice.invoice_number, invoice_id: storedInvoice.id });
      }

      const info = await icountCall(token, 'doc/info', {
        doctype: 'invoice', docnum: Number(externalDocnum), get_items: false,
        get_payments: false, get_pdf_link: true, lang: 'he',
      });
      const pdfLink = String(deepFind(info, 'pdf_link') || '');
      if (!pdfLink) throw new Error('החשבונית הופקה אך iCount לא החזיר קישור PDF — ניתן לנסות שוב בבטחה');
      const pdfResponse = await fetch(pdfLink);
      if (!pdfResponse.ok) throw new Error(`החשבונית הופקה אך הורדת ה-PDF נכשלה (${pdfResponse.status})`);
      const pdf = new Uint8Array(await pdfResponse.arrayBuffer());
      if (pdf.length < 500 || String.fromCharCode(...pdf.slice(0, 4)) !== '%PDF') {
        throw new Error('iCount החזיר קובץ שאינו PDF — החשבונית לא נשמרה בכרטיס הלקוח');
      }
      const fileName = `RACHELI-S-invoice-${externalDocnum}.pdf`;
      const path = `${customer.id}/icount_${externalDocnum}_${Date.now()}.pdf`;
      const { error: uploadError } = await service.storage.from('invoices').upload(path, pdf, {
        contentType: 'application/pdf', upsert: false,
      });
      if (uploadError) throw uploadError;
      const { data: invoice, error: invoiceError } = await service.from('invoices').insert({
        customer_id: customer.id,
        order_id: null,
        invoice_number: externalDocnum,
        amount: totalWithVat,
        file_path: path,
        file_name: fileName,
        status: 'active',
        issued_at: docDate,
        notes: notes || null,
        uploaded_by: user.id,
        source: 'icount',
        external_doctype: 'invoice',
        external_docnum: externalDocnum,
        external_url: docUrl || null,
      }).select('id, invoice_number, file_path').single();
      if (invoiceError) {
        await service.storage.from('invoices').remove([path]);
        throw invoiceError;
      }
      await service.from('icount_flexible_invoice_generations').update({
        status: 'succeeded', invoice_id: invoice.id, error: null, updated_at: new Date().toISOString(),
      }).eq('request_id', flexibleRequestId);
      return jsonResponse({ ok: true, invoice_number: externalDocnum, invoice_id: invoice.id, total_with_vat: totalWithVat });
    }

    orderId = String(body?.order_id || '');
    if (!orderId) return jsonResponse({ ok: false, error: 'חסר order_id' }, 400);

    const { data: order, error: orderError } = await service.from('orders')
      .select('*, order_items(id, product_id, model, size, qty, unit_price), customers(id, name, business_name, email, phone, city, address, tax_id, icount_client_id, icount_client_name)')
      .eq('id', orderId).single();
    if (orderError || !order) throw orderError || new Error('ההזמנה לא נמצאה');
    if (order.status !== 'ready') return jsonResponse({ ok: false, error: 'ניתן להפיק חשבונית רק להזמנה שמוכנה לאיסוף' }, 409);
    if (order.archived_at) return jsonResponse({ ok: false, error: 'לא ניתן להפיק חשבונית להזמנה שכבר בארכיון' }, 409);

    const { data: existingInvoice } = await service.from('invoices').select('id, invoice_number, file_path')
      .eq('order_id', orderId).neq('status', 'cancelled').limit(1).maybeSingle();
    if (existingInvoice) return jsonResponse({ ok: false, error: 'כבר קיימת חשבונית להזמנה זו', invoice: existingInvoice }, 409);

    const productIds = [...new Set((order.order_items || []).map((x: OrderItem) => x.product_id).filter(Boolean))];
    const descriptions = new Map<string, string>();
    if (productIds.length) {
      const { data: products, error: productsError } = await service.from('products').select('id, description').in('id', productIds);
      if (productsError) throw productsError;
      for (const product of products || []) descriptions.set(product.id, product.description || '');
    }

    const lines = invoiceLines(order.order_items || [], descriptions);
    if (!lines.length) return jsonResponse({ ok: false, error: 'אין פריטים לחשבונית' }, 409);
    if (lines.some((x) => x.unitprice <= 0)) return jsonResponse({ ok: false, error: 'יש פריט במחיר 0 — ההפקה נעצרה' }, 409);
    const customer = order.customers;
    if (!customer?.id) return jsonResponse({ ok: false, error: 'להזמנה אין כרטיס לקוח משויך' }, 409);
    if (!customer.icount_client_id) return jsonResponse({ ok: false, error: 'יש לקשר את הלקוח לכרטיס iCount לפני הפקת מסמך' }, 409);
    const clientName = customer?.business_name || customer?.name || order.contact_name;
    if (!clientName) return jsonResponse({ ok: false, error: 'חסר שם לקוח לחשבונית' }, 409);

    const subtotal = round2(lines.reduce((sum, x) => sum + x.quantity * x.unitprice, 0));
    const orderSubtotal = Number(order.subtotal_amount || 0);
    if (Math.abs(subtotal - orderSubtotal) > 0.02) {
      return jsonResponse({ ok: false, error: 'סכום השורות אינו תואם לסכום ההזמנה — יש לרענן ולבדוק' }, 409);
    }
    const discount = round2(Math.min(Math.max(Number(order.discount_amount || 0), 0), subtotal));
    const beforeVat = round2(subtotal - discount);
    if (Math.abs(beforeVat - Number(order.total_amount || 0)) > 0.02) {
      return jsonResponse({ ok: false, error: 'הסכום לתשלום השתנה — יש לפתוח תצוגה מקדימה חדשה' }, 409);
    }
    const vat = round2(beforeVat * VAT_PERCENT / 100);
    const totalWithVat = round2(beforeVat + vat);
    const docDate = israelToday();
    const paydate = endOfMonth(docDate);
    const doctypeWasProvided = Boolean(body?.doctype);
    const doctype = String(body?.doctype || 'invoice');
    if (!['invoice', 'receipt', 'invrec'].includes(doctype)) {
      return jsonResponse({ ok: false, error: 'סוג המסמך אינו נתמך' }, 400);
    }
    const documentTitle = doctype === 'receipt' ? 'קבלה'
      : doctype === 'invrec' ? 'חשבונית מס + קבלה' : 'חשבונית מס';
    const token = Deno.env.get('ICOUNT_API_TOKEN') || '';
    if (!token) return jsonResponse({ ok: false, error: 'ICOUNT_API_TOKEN לא הוגדר בפונקציית השרת' }, 503);
    const capabilities = await loadIcountCapabilities(token);
    if (!capabilities.doctypes.some((item) => item.code === doctype)) {
      return jsonResponse({ ok: false, error: `${documentTitle} אינה זמינה בחשבון iCount` }, 409);
    }

    const paymentMethod = String(body?.payment_method || '');
    const bankAccountId = String(body?.bank_account_id || '');
    let paymentFields: Record<string, unknown> = {};
    if (doctype === 'receipt' || doctype === 'invrec') {
      const method = capabilities.payment_methods.find((item) => item.code === paymentMethod);
      if (!method || !['banktransfer', 'cheques'].includes(paymentMethod)) {
        return jsonResponse({ ok: false, error: 'יש לבחור העברה בנקאית או צ׳קים' }, 409);
      }

      if (paymentMethod === 'banktransfer') {
        const account = capabilities.bank_accounts.find((item) => item.id === bankAccountId);
        if (!account) return jsonResponse({ ok: false, error: 'יש לבחור חשבון בנק לקבלת ההעברה' }, 409);
        paymentFields = { banktransfer: { sum: totalWithVat, date: docDate, account: Number(account.id) } };
      } else {
        if (!Array.isArray(body?.cheques) || body.cheques.length < 1 || body.cheques.length > 36) {
          return jsonResponse({ ok: false, error: 'יש להזין בין צ׳ק אחד ל־36 צ׳קים' }, 400);
        }
        const cheques = body.cheques.map((raw: any, index: number) => {
          const sum = round2(Number(raw?.sum));
          const date = validISODate(raw?.date);
          const bank = String(raw?.bank || '').trim();
          const branch = String(raw?.branch || '').trim();
          const account = String(raw?.account || '').trim();
          const number = String(raw?.number || '').trim();
          if (!Number.isFinite(sum) || sum <= 0 || sum > 10000000) throw new Error(`סכום לא תקין בצ׳ק ${index + 1}`);
          if (![bank, branch, account, number].every((value) => /^\d{1,20}$/.test(value))) {
            throw new Error(`פרטי הבנק אינם תקינים בצ׳ק ${index + 1}`);
          }
          return {
            sum, date,
            bank: Number(bank), branch: Number(branch), account: Number(account), number: Number(number),
          };
        });
        const chequeTotal = round2(cheques.reduce((sum: number, cheque: any) => sum + cheque.sum, 0));
        if (Math.abs(chequeTotal - totalWithVat) > 0.02) {
          return jsonResponse({ ok: false, error: `סכום הצ׳קים חייב להיות ${totalWithVat.toFixed(2)}` }, 409);
        }
        paymentFields = { cheques };
      }
    }

    const fingerprintBase: Record<string, unknown> = {
      order_id: order.id, customer_id: order.customer_id, clientName,
      tax_id: customer?.tax_id || '', address: customer?.address || '',
      lines, discount, subtotal, docDate, paydate, vat: VAT_PERCENT,
    };
    if (doctypeWasProvided) Object.assign(fingerprintBase, {
      doctype,
      paymentMethod: doctype === 'invoice' ? '' : paymentMethod,
      bankAccountId: paymentMethod === 'banktransfer' ? bankAccountId : '',
      cheques: paymentMethod === 'cheques' ? body.cheques : [],
    });
    const fingerprint = await sha256(fingerprintBase);
    const preview = {
      lines, subtotal, discount, before_vat: beforeVat, vat, total_with_vat: totalWithVat,
      doc_date: docDate, paydate, doctype, document_title: documentTitle, payment_method: paymentMethod,
    };
    if (body.action === 'preview') return jsonResponse({ ok: true, preview, fingerprint });

    const sanity = `rcl-${order.order_number}-${String(order.id).replace(/-/g, '').slice(0, 12)}`.slice(0, 30);
    const { data: claim, error: claimError } = await service.rpc('claim_icount_invoice_generation', {
      p_order_id: orderId, p_fingerprint: fingerprint, p_sanity_string: sanity,
    });
    if (claimError) throw claimError;
    if (!claim?.claimed) {
      if (claim?.status === 'succeeded') return jsonResponse({ ok: true, reused: true, invoice_number: claim.docnum });
      if (claim?.status === 'processing') return jsonResponse({ ok: false, error: 'הפקת החשבונית כבר מתבצעת. יש להמתין ולרענן.' }, 409);
      return jsonResponse({ ok: false, error: claim?.error || 'ההפקה נעצרה לבדיקה ידנית כדי למנוע חשבונית כפולה' }, 409);
    }

    // ניסיון התאוששות: אם iCount כבר יצר מסמך אך שמירת ה-PDF נכשלה, לא יוצרים מסמך שני.
    const { data: generation } = await service.from('icount_invoice_generations').select('*').eq('order_id', orderId).single();
    externalDocnum = generation?.external_docnum || '';
    let docUrl = generation?.external_url || '';
    const externalDoctype = String(generation?.external_doctype || doctype);
    if (!externalDocnum) {
      let created: any;
      try {
        created = await icountCall(token, 'doc/create', {
          doctype,
          client_id: customer.icount_client_id,
          vat_id: String(customer.tax_id || '').replace(/\D/g, '') || undefined,
          email: customer.email || order.email || undefined,
          client_name: clientName,
          client_address: [customer.address, customer.city].filter(Boolean).join(', ') || undefined,
          doc_date: docDate,
          ...(doctype === 'invoice' ? { paydate } : {}),
          currency_code: 'ILS',
          ...(doctype === 'receipt' ? {} : {
            vat_percent: VAT_PERCENT,
            items: lines.map((x) => ({
              sku: x.model,
              description: x.description ? `${x.model} — ${x.description}` : x.model,
              quantity: x.quantity,
              unitprice: x.unitprice,
            })),
            discount: discount || undefined,
          }),
          ...paymentFields,
          hwc: `הזמנה #${order.order_number}`,
          sanity_string: sanity,
          doc_lang: 'he',
          send_email: false,
          send_sms: false,
        });
      } catch (error) {
        if (String((error as any)?.code || (error as Error).message).includes('doc_exists_based_on_sanity_string')) {
          await service.from('icount_invoice_generations').update({
            status: 'needs_review', error: 'iCount דיווח שהמסמך כבר קיים, אך מספרו לא נשמר. נדרשת בדיקה ידנית לפני ניסיון נוסף.', updated_at: new Date().toISOString(),
          }).eq('order_id', orderId);
        }
        throw error;
      }
      externalDocnum = String(deepFind(created, 'docnum') || '');
      docUrl = String(deepFind(created, 'doc_url') || '');
      externalCreated = true;
      if (!externalDocnum) throw new Error('iCount יצר מסמך אך לא החזיר מספר מסמך — ההפקה נעצרה לבדיקה');
      await service.from('icount_invoice_generations').update({
        external_doctype: doctype, external_docnum: externalDocnum, external_url: docUrl,
        updated_at: new Date().toISOString(),
      }).eq('order_id', orderId);
    } else {
      externalCreated = true;
    }

    const info = await icountCall(token, 'doc/info', {
      doctype: externalDoctype, docnum: Number(externalDocnum), get_items: false,
      get_payments: false, get_pdf_link: true, lang: 'he',
    });
    const pdfLink = String(deepFind(info, 'pdf_link') || '');
    if (!pdfLink) throw new Error(`${documentTitle} הופקה אך iCount לא החזיר קישור PDF — ניתן לנסות שוב בבטחה`);
    const pdfResponse = await fetch(pdfLink);
    if (!pdfResponse.ok) throw new Error(`${documentTitle} הופקה אך הורדת ה-PDF נכשלה (${pdfResponse.status})`);
    const pdf = new Uint8Array(await pdfResponse.arrayBuffer());
    const pdfSignature = String.fromCharCode(...pdf.slice(0, 4));
    if (pdf.length < 500 || pdfSignature !== '%PDF') {
      throw new Error(`iCount החזיר קובץ שאינו PDF — ${documentTitle} לא נשמרה בהזמנה`);
    }

    const fileName = `RACHELI-S-${externalDoctype}-${externalDocnum}.pdf`;
    const path = `${customer.id}/icount_${externalDoctype}_${externalDocnum}_${Date.now()}.pdf`;
    const { error: uploadError } = await service.storage.from('invoices').upload(path, pdf, {
      contentType: 'application/pdf', upsert: false,
    });
    if (uploadError) throw uploadError;

    const { data: invoice, error: insertError } = await service.from('invoices').insert({
      customer_id: customer.id,
      order_id: order.id,
      invoice_number: externalDocnum,
      amount: totalWithVat,
      file_path: path,
      file_name: fileName,
      status: 'active',
      issued_at: docDate,
      uploaded_by: user.id,
      source: 'icount',
      external_doctype: externalDoctype,
      external_docnum: externalDocnum,
      external_url: docUrl || null,
    }).select('id, invoice_number, file_path').single();
    if (insertError) {
      await service.storage.from('invoices').remove([path]);
      throw insertError;
    }

    await service.from('icount_invoice_generations').update({
      status: 'succeeded', invoice_id: invoice.id, error: null, updated_at: new Date().toISOString(),
    }).eq('order_id', orderId);
    return jsonResponse({
      ok: true, invoice_number: externalDocnum, invoice_id: invoice.id,
      total_with_vat: totalWithVat, doctype: externalDoctype, document_title: documentTitle,
    });
  } catch (error) {
    console.error(error);
    if (flexibleRequestId) {
      const current = await service.from('icount_flexible_invoice_generations')
        .select('status').eq('request_id', flexibleRequestId).maybeSingle();
      if (current.data && current.data.status !== 'needs_review' && current.data.status !== 'succeeded') {
        await service.from('icount_flexible_invoice_generations').update({
          status: externalCreated && !externalDocnum ? 'needs_review' : 'failed',
          error: error instanceof Error ? error.message : String(error),
          updated_at: new Date().toISOString(),
        }).eq('request_id', flexibleRequestId);
      }
    }
    if (returnId) {
      const current = await service.from('icount_refund_generations')
        .select('status').eq('return_id', returnId).maybeSingle();
      if (current.data && current.data.status !== 'needs_review' && current.data.status !== 'succeeded') {
        await service.from('icount_refund_generations').update({
          status: externalCreated && !externalDocnum ? 'needs_review' : 'failed',
          error: error instanceof Error ? error.message : String(error),
          updated_at: new Date().toISOString(),
        }).eq('return_id', returnId);
      }
    }
    if (orderId) {
      const current = await service.from('icount_invoice_generations').select('status').eq('order_id', orderId).maybeSingle();
      if (current.data && current.data.status !== 'needs_review' && current.data.status !== 'succeeded') {
        await service.from('icount_invoice_generations').update({
          status: externalCreated && !externalDocnum ? 'needs_review' : 'failed',
          error: error instanceof Error ? error.message : String(error),
          updated_at: new Date().toISOString(),
        }).eq('order_id', orderId);
      }
    }
    return jsonResponse({ ok: false, error: error instanceof Error ? error.message : String(error), external_docnum: externalDocnum || undefined }, 500);
  }
});
