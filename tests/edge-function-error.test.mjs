import test from 'node:test';
import assert from 'node:assert/strict';
import { edgeFunctionError } from '../edge-function-error.js';

test('refund validation errors show the missing model and preserve the response body', async () => {
  const response = new Response(JSON.stringify({ ok: false, error: 'לא נמצא מחיר לזיכוי עבור הדגם 2413B-6' }), { status: 409 });
  const original = Object.assign(new Error('Edge Function returned a non-2xx status code'), { context: response });
  const error = await edgeFunctionError(original);
  assert.equal(error.message, 'לא נמצא מחיר לזיכוי עבור הדגם 2413B-6');
  assert.equal(error.status, 409);
  assert.equal(error.cause, original);
  assert.equal(response.bodyUsed, false);
});

test('gateway authentication messages are surfaced as well as application errors', async () => {
  const error = await edgeFunctionError({ context: new Response(JSON.stringify({ message: 'Invalid JWT' }), { status: 401 }) });
  assert.equal(error.message, 'Invalid JWT');
  assert.equal(error.status, 401);
});

test('network failures, invalid JSON and malformed error payloads retain the original error', async () => {
  for (const context of [undefined, new Response('Service unavailable', { status: 503 }), new Response('{"error":{}}')]) {
    const original = Object.assign(new Error('network error'), { context });
    assert.equal(await edgeFunctionError(original), original);
  }
  assert.equal((await edgeFunctionError({ message: 'permission denied' })).message, 'permission denied');
});
