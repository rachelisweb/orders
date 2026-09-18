// Keep address normalization in one pure module so it can be tested without
// starting the Edge Function or touching SMTP.
export function cleanEmail(value: unknown) {
  if (typeof value !== 'string') return null;
  const email = value.normalize('NFKC')
    .replace(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
    .trim()
    .toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

export function cleanEmails(values: unknown) {
  const list = Array.isArray(values) ? values : [values];
  return [...new Set(list
    .map(cleanEmail)
    .filter((email): email is string => !!email)
  )];
}

