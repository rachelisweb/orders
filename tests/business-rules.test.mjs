import test from 'node:test';
import assert from 'node:assert/strict';
import { allocationTaxIdError } from '../invoice-policy.js';
import { uniqueEmails, uniquePhones } from '../contact-utils.js';
import { catalogCollectionVisible } from '../catalog-display.js';

test('allocation requires identity only above 5000 before VAT on tax documents', () => {
  for (const type of ['invoice', 'invrec']) {
    assert.equal(allocationTaxIdError(type, 5000, ''), '');
    assert.equal(allocationTaxIdError(type, 4999.99, ''), '');
    assert.ok(allocationTaxIdError(type, 5000.01, ''));
    assert.ok(allocationTaxIdError(type, 6000, 'abc123456789'));
    assert.ok(allocationTaxIdError(type, 6000, '000000000'));
    assert.equal(allocationTaxIdError(type, 6000, '123-456-789'), '');
    assert.equal(allocationTaxIdError(type, 6000, '012345678'), '');
  }
  assert.equal(allocationTaxIdError('receipt', 10000, ''), '');
  assert.equal(allocationTaxIdError('refund', 10000, ''), '');
});

test('merged contacts collapse equivalent forms while preserving different contacts', () => {
  assert.deepEqual(uniqueEmails([' A@Example.com ', '\u200fa@example.com', 'b@example.com', '']), ['a@example.com', 'b@example.com']);
  assert.deepEqual(uniqueEmails(['yaelasayag26@gmail.com', 'yaelasayg26@gmail.com']), ['yaelasayag26@gmail.com', 'yaelasayg26@gmail.com']);
  assert.deepEqual(uniquePhones(['050-1234567', '+972 50 123 4567', '00972501234567', '0507654321']), ['0501234567', '0507654321']);
});

test('catalog choices include only visible collections and the selected collection', () => {
  const collections = [{ id: 'a', is_active: true }, { id: 'b', is_active: true }, { id: 'hidden', is_active: false }];
  assert.equal(catalogCollectionVisible('a', collections), true);
  assert.equal(catalogCollectionVisible('hidden', collections), false);
  assert.equal(catalogCollectionVisible('hidden', collections, { mode: 'all' }), false);
  assert.equal(catalogCollectionVisible('b', collections, { mode: 'all' }), true);
  assert.equal(catalogCollectionVisible(null, collections, { mode: 'all' }), true);
  assert.equal(catalogCollectionVisible(null, collections), false);
  assert.equal(catalogCollectionVisible('a', collections, { mode: 'single', collection_id: 'b' }), false);
  assert.equal(catalogCollectionVisible('b', collections, { mode: 'single', collection_id: 'b' }), true);
});
