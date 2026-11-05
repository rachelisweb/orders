const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(require.resolve('playwright', { paths: [
  process.cwd(), path.join(require('node:os').homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node'),
] }));
const root = path.resolve(__dirname, '..');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = http.createServer(async (req, res) => {
  try {
    const file = path.resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    let data = await fs.readFile(file);
    if (file === path.join(root, 'admin.js')) {
      let source = data.toString();
      const start = source.indexOf('async function openIcountRefundPreview(');
      const reviewBranch = source.indexOf('if (LOCAL_REVIEW)', start);
      // Exercise the real server-response branch, while review mode still blocks document creation.
      source = source.slice(0, reviewBranch) + source.slice(reviewBranch).replace('if (LOCAL_REVIEW)', 'if (false)');
      source = source.replace("'#pSave', '#pImagePick'", "'#pImagePick'"); // Product saves are intercepted below.
      data = source + `\nwindow.refundTest = {
        open: openIcountRefundPreview,
        setup() {
          db.products[0].model='2413B-6';db.products[0].wholesale_price=0;
          db.returnItems[0].model='2413B-6';
          return JSON.parse(JSON.stringify(db));
        }
      };`;
    }
    res.writeHead(200, { 'Content-Type': (mime[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8' }).end(data);
  } catch { res.writeHead(404).end(); }
});

async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 870, height: 764 } });
    const errors = [];
    const actions = [];
    const updates = [];
    let data;
    let errorMessage = 'לא נמצא מחיר לזיכוי עבור הדגם 2413B-6';
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*.supabase.co/**', async route => {
      const req = route.request();
      const url = new URL(req.url());
      if (url.pathname === '/functions/v1/icount-invoice') {
        const body = req.postDataJSON();
        actions.push(body.action);
        assert.equal(body.action, 'refund_preview', 'The test must never issue a document');
        if (errorMessage) return route.fulfill({ status: 409, json: { ok: false, error: errorMessage } });
        return route.fulfill({ json: { ok: true, preview: {
          client_name: 'לקוח בדיקה', return_number: 55, doc_date: '2026-11-05',
          lines: [{ sku: '2413B-6', description: 'בדיקה', quantity: 2, unitprice: 100 }],
          subtotal: 200, vat: 36, total_with_vat: 236,
        } } });
      }
      if (!url.pathname.startsWith('/rest/v1/')) throw new Error('Unexpected request: ' + url.pathname);
      const table = url.pathname.slice('/rest/v1/'.length);
      if (req.method() === 'PATCH') {
        assert.equal(table, 'products');
        const patch = req.postDataJSON();
        updates.push(patch);
        Object.assign(data.products[0], patch);
        errorMessage = '';
        return route.fulfill({ status: 204, body: '' });
      }
      const tables = {
        collections: 'collections', products: 'products', orders: 'orders',
        v_customer_stats: 'customers', customers: 'customers', invoices: 'invoices', profiles: 'users',
        notification_emails: 'emails', returns: 'returns', return_items: 'returnItems',
        future_order_collections: 'futureCollections',
      };
      if (req.method() !== 'GET') assert.equal(table, 'rpc/get_available_inventory');
      return route.fulfill({ json: data?.[tables[table]] || [] });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/admin.html?review=1&mock=1`);
    await page.locator('#adminScreen.active').waitFor();
    data = await page.evaluate(() => refundTest.setup());
    const returnId = data.returns[0].id;
    await page.evaluate(id => refundTest.open(id), returnId);
    assert.match(await page.locator('#modalBody').innerText(), /לא נמצא מחיר לזיכוי עבור הדגם 2413B-6/);
    assert.doesNotMatch(await page.locator('#modalBody').innerText(), /non-2xx/);
    assert.equal(await page.locator('#refundFixPrice').isVisible(), true);
    assert.equal(updates.length, 0);
    await page.locator('#refundPreviewRetry').click();
    await page.locator('#refundFixPrice').waitFor();
    assert.equal(actions.length, 2);
    await page.locator('#refundFixPrice').click();
    assert.equal(await page.locator('#pModel').inputValue(), '2413B-6');
    await page.locator('#pWholesale').fill('100');
    await page.locator('#pSave').click();
    await page.locator('#icountRefundConfirm').waitFor();
    assert.equal(updates.length, 1);
    assert.equal(updates[0].wholesale_price, 100);
    assert.equal(actions.length, 3);
    assert.equal(await page.locator('#icountRefundCreate').isDisabled(), true);
    assert.match(await page.locator('#modalBody').innerText(), /236/);
    console.log('PASS Refund error shows missing model; retry works; catalog price edit returns to preview; preview does not create or credit a document');
    errorMessage = '<img src=x onerror="window.injected=true">';
    await page.evaluate(id => refundTest.open(id), returnId);
    assert.equal(await page.locator('#modalBody img').count(), 0);
    assert.equal(await page.locator('#refundFixPrice').count(), 0);
    assert.equal(await page.locator('#refundPreviewRetry').isVisible(), true);
    assert.deepEqual(errors, []);
    console.log('PASS Other server errors remain readable and escaped; no JavaScript errors');
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
