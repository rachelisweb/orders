import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanEmail, cleanEmails } from './email-address.ts';

test('מסיר תווי כיווניות מהכתובת הבעייתית לפני SMTP', () => {
  assert.equal(cleanEmail('\u202Bracheli0526500@gmail.com\u202C'), 'racheli0526500@gmail.com');
  assert.equal(cleanEmail('\u202Bracheli0526500@gmail.com'), 'racheli0526500@gmail.com');
});

test('מנקה ומאחד רשימת נמענים', () => {
  assert.deepEqual(cleanEmails([
    ' RACHELI0526500@gmail.com ',
    '\u202Bracheli0526500@gmail.com\u202C',
    'not-an-email',
  ]), ['racheli0526500@gmail.com']);
});

