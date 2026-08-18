import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
});

async function sha1(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-1', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function productPublicId(model: string) {
  const safeModel = model
    .normalize('NFKC')
    .replace(/[?&#\\%<>+/]/g, '-')
    .replace(/\s+/g, '_')
    .replace(/[-_]{2,}/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 140);
  if (!safeModel) throw new Error('מספר הדגם אינו מתאים לשם תמונה');
  return `rachelis/products/${safeModel}`;
}

async function cloudinarySignature(params: Record<string, string>, secret: string) {
  const signed = Object.entries(params)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  return sha1(`${signed}${secret}`);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'POST בלבד' }, 405);

  try {
    const service = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );
    const jwt = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: { user }, error: authError } = await service.auth.getUser(jwt);
    if (authError || !user) return jsonResponse({ ok: false, error: 'נדרשת התחברות' }, 401);

    const { data: profile } = await service.from('profiles').select('role').eq('id', user.id).maybeSingle();
    if (profile?.role !== 'admin') {
      return jsonResponse({ ok: false, error: 'העלאת תמונה מותרת למנהל בלבד' }, 403);
    }

    const cloudName = Deno.env.get('CLOUDINARY_CLOUD_NAME') || '';
    const apiKey = Deno.env.get('CLOUDINARY_API_KEY') || '';
    const apiSecret = Deno.env.get('CLOUDINARY_API_SECRET') || '';
    if (!cloudName || !apiKey || !apiSecret) {
      return jsonResponse({ ok: false, error: 'החיבור ל־Cloudinary עדיין לא הוגדר בשרת' }, 503);
    }

    const contentLength = Number(req.headers.get('content-length') || 0);
    if (contentLength > MAX_FILE_BYTES + 1024 * 1024) {
      return jsonResponse({ ok: false, error: 'התמונה גדולה מדי. הגודל המרבי הוא 10MB' }, 413);
    }

    const form = await req.formData();
    const model = String(form.get('model') || '').trim();
    const file = form.get('file');
    if (!model) return jsonResponse({ ok: false, error: 'יש להזין מספר דגם לפני העלאת התמונה' }, 400);
    if (!(file instanceof File)) return jsonResponse({ ok: false, error: 'לא נבחר קובץ תמונה' }, 400);
    if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
      return jsonResponse({ ok: false, error: 'אפשר להעלות תמונת JPG, PNG או WebP בלבד' }, 415);
    }
    if (!file.size || file.size > MAX_FILE_BYTES) {
      return jsonResponse({ ok: false, error: 'התמונה גדולה מדי. הגודל המרבי הוא 10MB' }, 413);
    }

    const publicId = productPublicId(model);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signedParams = {
      invalidate: 'true',
      overwrite: 'true',
      public_id: publicId,
      timestamp,
    };
    const signature = await cloudinarySignature(signedParams, apiSecret);
    const upload = new FormData();
    upload.append('file', file, file.name || `${model}.jpg`);
    upload.append('api_key', apiKey);
    upload.append('signature', signature);
    Object.entries(signedParams).forEach(([key, value]) => upload.append(key, value));

    // הקובץ מועבר ישירות ל-Cloudinary. הוא אינו נכתב ל-Supabase Storage או למסד הנתונים.
    const response = await fetch(
      `https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/image/upload`,
      { method: 'POST', body: upload },
    );
    const result = await response.json().catch(() => null);
    if (!response.ok || !result?.secure_url) {
      const message = String(result?.error?.message || `Cloudinary דחה את ההעלאה (${response.status})`);
      return jsonResponse({ ok: false, error: message.slice(0, 300) }, 502);
    }

    return jsonResponse({
      ok: true,
      secure_url: String(result.secure_url),
      public_id: String(result.public_id || publicId),
      version: Number(result.version || 0),
      width: Number(result.width || 0),
      height: Number(result.height || 0),
      bytes: Number(result.bytes || 0),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'העלאת התמונה נכשלה';
    return jsonResponse({ ok: false, error: message.slice(0, 300) }, 500);
  }
});
