// iCount / חשבוניות ישראל: the threshold applies after discounts, before VAT.
export const ALLOCATION_THRESHOLD = 5000;
export function allocationTaxIdError(doctype, beforeVat, taxId) {
  if (!['invoice', 'invrec'].includes(doctype) || Math.round(Number(beforeVat) * 100) <= ALLOCATION_THRESHOLD * 100) return '';
  const digits = String(taxId || '').replace(/[\s\-\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '');
  if (!/^\d{9}$/.test(digits) || /^0+$/.test(digits)) {
    return 'לחשבונית מעל 5,000 ₪ לפני מע״מ, לאחר הנחות, חובה להזין ח.פ / ע.מ / תעודת זהות של העוסק (9 ספרות) לצורך מספר הקצאה.';
  }
  return '';
}
