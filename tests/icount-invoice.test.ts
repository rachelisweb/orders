import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';

let handler: (request: Request) => Promise<Response>;
Object.defineProperty(Deno, 'serve', { value: (fn: typeof handler) => { handler = fn; } });
Deno.env.set('SUPABASE_URL', 'https://test.supabase.co');
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'test-service-key');
Deno.env.set('ICOUNT_API_TOKEN', 'test-token');
const id = '10000000-0000-4000-8000-000000000001';
let beforeVat = 5000.01;
let taxId = '';
let creates = 0;
let writes = 0;
globalThis.fetch = async (input, options) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const customer = { id, name: 'בדיקה', icount_client_id: 1, tax_id: taxId };
  let data: unknown;
  if (url.hostname === 'api.icount.co.il') {
    if (url.pathname.endsWith('/doc/create')) creates++;
    if (url.pathname.endsWith('/doc/types')) data = { status: true, doctypes: { invoice: {}, receipt: {}, invrec: {} } };
    else if (url.pathname.endsWith('/company/bank_accounts')) data = { status: true, bank_accounts: { '1': { title: 'test' } } };
    else throw new Error('Unexpected iCount operation: ' + url.pathname);
  } else {
    if (options?.method && !['GET', 'HEAD'].includes(options.method)) writes++;
    if (url.pathname === '/auth/v1/user') data = { id };
    else if (url.pathname === '/rest/v1/profiles') data = { role: 'admin' };
    else if (url.pathname === '/rest/v1/customers') data = customer;
    else if (url.pathname === '/rest/v1/orders') data = {
      id, order_number: 1, status: 'ready', customer_id: id, customers: customer,
      subtotal_amount: 6000, discount_amount: 6000 - beforeVat, total_amount: beforeVat,
      order_items: [{ id: 1, product_id: null, model: 'test', size: 'M', qty: 1, unit_price: 6000 }],
    };
    else if (url.pathname === '/rest/v1/invoices') data = null;
    else if (url.pathname.endsWith('_generations')) data = null;
    else throw new Error('Unexpected database operation: ' + url.pathname);
  }
  return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
await import('../supabase/functions/icount-invoice/index.ts');
async function request(body: unknown) {
  return handler(new Request('https://test/functions/v1/icount-invoice', {
    method: 'POST', headers: { authorization: 'Bearer test', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }));
}

Deno.test('order preview and creation cannot bypass identity requirement; receipts stay available', async () => {
  for (const doctype of ['invoice', 'invrec']) {
    for (const action of ['preview', 'create']) {
      beforeVat = 5000.01; taxId = '';
      const response = await request({ action, doctype, order_id: id });
      assertEquals(response.status, 409);
      assertEquals((await response.json()).error.includes('5,000'), true);
    }
  }
  beforeVat = 5000;
  assertEquals((await request({ action: 'preview', doctype: 'invoice', order_id: id })).status, 200);
  beforeVat = 6000; taxId = '123456789';
  assertEquals((await request({ action: 'preview', doctype: 'invrec', order_id: id, payment_method: 'banktransfer', bank_account_id: '1' })).status, 200);
  taxId = '';
  assertEquals((await request({ action: 'preview', doctype: 'receipt', order_id: id, payment_method: 'banktransfer', bank_account_id: '1' })).status, 200);
  assertEquals(creates, 0);
  assertEquals(writes, 0);
});

Deno.test('flexible invoices validate discounted total and reject a direct create without identity', async () => {
  const body = { request_id: id, customer_id: id, client_name: 'בדיקה', doc_date: '2026-10-19', paydate: '2026-10-31',
    items: [{ sku: 'test', quantity: 1, unitprice: 6000 }], discount: 999.99 };
  assertEquals((await request({ ...body, action: 'flexible_create' })).status, 409);
  assertEquals((await request({ ...body, action: 'flexible_preview', vat_id: '123456789abc' })).status, 409);
  assertEquals((await request({ ...body, action: 'flexible_preview', discount: 1000 })).status, 200);
  assertEquals((await request({ ...body, action: 'flexible_preview', vat_id: '123456789' })).status, 200);
  assertEquals(creates, 0);
  assertEquals(writes, 0);
});
