export const cleanEmail = (value) => String(value || '').normalize('NFKC')
  .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '').trim().toLowerCase();
export const cleanPhone = (value) => {
  const digits = String(value || '').replace(/\D/g, '');
  return /^(?:00972|972)/.test(digits) ? '0' + digits.replace(/^(?:00972|972)0?/, '') : digits;
};
export const uniqueEmails = (values) => [...new Set(values.map(cleanEmail).filter(Boolean))];
export const uniquePhones = (values) => [...new Set(values.map(cleanPhone).filter(Boolean))];
