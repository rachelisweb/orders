// ============================================================
// רחליס — מיילים על הזמנות
//
//   event=created  → אישור ללקוח + התראה לכתובות שב-notification_emails
//   event=shipped  → הודעת משלוח ללקוח, עם החשבונית מצורפת אם קיימת
//   event=test     → מייל בדיקה לכתובת שנשלחה, בלי לגעת בהזמנות
//
// השליחה היא SMTP ישיר עם סיסמת אפליקציה (Gmail App Password),
// בלי שירות צד-שלישי.
//
// התבניות יושבות ב-template.ts — מודול טהור שנבדק ב-Node.
//
// פריסה:
//   supabase secrets set SMTP_HOST=smtp.gmail.com SMTP_PORT=465
//   supabase secrets set SMTP_USER=rachelisweb@gmail.com
//   supabase secrets set SMTP_PASS="abcd efgh ijkl mnop"   ← קוד אפליקציה
//   supabase secrets set MAIL_FROM="רחליס <rachelisweb@gmail.com>"
//   supabase functions deploy order-email
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
// nodemailer ולא denomailer: ב-denomailer@1.6.0 הכותרות מקודדות
// עם מקודד ה-*גוף* (config/mail/encoding.ts) — הוא משאיר רווחים
// ממשיים בתוך encoded-word ושובר שורות ב-CRLF יבש בלי רווח המשך.
// כותרת Subject בעברית נחתכה באמצע, וכל שאר הכותרות נחתו בגוף
// ההודעה כטקסט. nodemailer מיישם RFC 2047/2231 כמו שצריך.
import nodemailer from 'npm:nodemailer@6.9.16';
import {
  shell, box, itemsTable,
  customerCreatedEmail, teamCreatedEmail, shippedEmail,
  esc, fmtDate,
  type Brand,
} from './template.ts';

const SMTP_HOST = Deno.env.get('SMTP_HOST') ?? 'smtp.gmail.com';
const SMTP_PORT = Number(Deno.env.get('SMTP_PORT') ?? '465');
const SMTP_USER = Deno.env.get('SMTP_USER') ?? '';
const SMTP_PASS = Deno.env.get('SMTP_PASS') ?? '';
// ברירת המחדל היא המשתמש עצמו — ג'ימייל בלאו הכי דורס From זר
const MAIL_FROM = Deno.env.get('MAIL_FROM') ?? SMTP_USER;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// ============================================================
// SMTP
//
// חיבור אחד לכל קריאה לפונקציה, ולא אחד לכל מייל: ג'ימייל חונק
// חיבורים חדשים בתדירות גבוהה, וממילא כל אירוע שולח 1-2 מיילים.
// ============================================================
let client: ReturnType<typeof nodemailer.createTransport> | null = null;

function smtp() {
  if (!SMTP_USER || !SMTP_PASS) {
    throw new Error('SMTP_USER / SMTP_PASS לא הוגדרו — ראה שלב 9.5 בהוראות ההתקנה');
  }
  if (!client) {
    client = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      // 465 = TLS מלא מרגע החיבור. 587 = STARTTLS.
      secure: SMTP_PORT === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
      // חיבור אחד לכל קריאה לפונקציה: ג'ימייל חונק חיבורים חדשים
      // בתדירות גבוהה, וכל אירוע שולח 1-2 מיילים.
      pool: true,
      maxConnections: 1,
    });
  }
  return client;
}

async function closeSmtp() {
  if (!client) return;
  try { client.close(); } catch { /* החיבור כבר נסגר */ }
  client = null;
}

type Attachment = { filename: string; content: string };

async function sendMail(to: string[], subject: string, html: string, attachments: Attachment[] = []) {
  if (!to.length) return { skipped: true };

  const info = await smtp().sendMail({
    from: MAIL_FROM,
    to,
    subject,
    html,
    // גרסת טקסט למי שחוסם HTML, ולסינון ספאם טוב יותר.
    // nodemailer גוזר אותה מה-HTML לבד.
    text: htmlToText(html),
    attachments: attachments.map((a) => ({
      filename: a.filename,
      content: a.content,
      encoding: 'base64' as const,
      contentType: 'application/pdf',
    })),
  });

  return { ok: true, to, messageId: info?.messageId };
}

// גרסת טקסט פשוטה: מסירה תגים ומכווצת רווחים. לא מנסה להיות
// מושלמת — היא רק החלופה למי שחוסם HTML.
function htmlToText(html: string) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6]|table)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function cleanEmail(value: unknown) {
  if (typeof value !== 'string') return null;
  const email = value.trim();
  return email || null;
}

function cleanEmails(values: unknown) {
  const list = Array.isArray(values) ? values : [values];
  return [...new Set(list
    .map(cleanEmail)
    .filter((email): email is string => !!email)
    .map((email) => email.toLowerCase()))];
}

// ============================================================
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

  try {
    const { order_id, event, to } = await req.json();
    if (!['created', 'shipped', 'test'].includes(event)) {
      return json({ ok: false, error: 'event חייב להיות created / shipped / test' }, 400);
    }

    const sb = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { data: settingsRows } = await sb.from('app_settings').select('key, value');
    const S = Object.fromEntries((settingsRows || []).map((r: any) => [r.key, r.value || '']));
    const brand: Brand = {
      name:  S.brand_name  || 'רחליס',
      phone: S.brand_phone || '',
      email: S.brand_email || '',
    };

    // ── מייל בדיקה: מאמת SMTP מקצה לקצה בלי לגעת בנתונים ──
    //
    // זו הקריאה היחידה שמקבלת כתובת יעד חופשית מגוף הבקשה, ולכן
    // בלי בדיקת מנהל היא הייתה ריליי ספאם: ה-anon key חשוף ב-config.js,
    // וכל אחד היה יכול לשלוח מייל שרירותי מהג'ימייל של העסק.
    // ב-created/shipped היעד נגזר מההזמנה עצמה ולכן אין שם חשיפה כזו.
    if (event === 'test') {
      const jwt = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
      const { data: { user } } = await sb.auth.getUser(jwt);
      if (!user) return json({ ok: false, error: 'נדרשת התחברות' }, 401);

      const { data: prof } = await sb.from('profiles').select('role').eq('id', user.id).maybeSingle();
      if (prof?.role !== 'admin') {
        return json({ ok: false, error: 'מייל בדיקה מותר למנהל בלבד' }, 403);
      }

      if (!to) return json({ ok: false, error: 'חסרה כתובת יעד לבדיקה' }, 400);
      const html = shell('בדיקת שליחה', '#047857', `
        <p style="margin:0 0 14px;font-size:17px;font-weight:bold;">ה-SMTP עובד ✅</p>
        <p style="margin:0 0 14px;">אם הגעת עד כאן, מערכת ההזמנות יכולה לשלוח מיילים.</p>
        ${box('#ecfdf5', '#6ee7b7', '#065f46',
          `שרת: <b>${esc(SMTP_HOST)}:${SMTP_PORT}</b><br>
           שולח: <b>${esc(MAIL_FROM)}</b><br>
           נשלח ב-${fmtDate(new Date().toISOString())}`)}
        <p style="margin:16px 0 0;font-weight:bold;">כך תיראה טבלת הפריטים</p>
        ${itemsTable([
          { model: '2420-1', size: 'S', qty: 2, unit_price: 45 },
          { model: '2420-1', size: 'M', qty: 3, unit_price: 45 },
          { model: '2420-1', size: 'L', qty: 1, unit_price: 45 },
          { model: '2611',   size: 'M', qty: 4, unit_price: 62 },
          { model: '2611',   size: 'XL', qty: 2, unit_price: 62 },
        ], { showPrice: true })}
      `, brand);

      await sendMail([to], `בדיקת מערכת ההזמנות — ${brand.name}`, html);
      return json({ ok: true, sent: [to] });
    }

    if (!order_id) return json({ ok: false, error: 'order_id נדרש' }, 400);

    const { data: order, error } = await sb
      .from('orders')
      .select('*, order_items(model, size, qty, qty_ordered, unit_price), customers(name, business_name, email, email_recipients, phone)')
      .eq('id', order_id)
      .single();
    if (error) throw error;
    if (!order) return json({ ok: false, error: 'ההזמנה לא נמצאה' }, 404);

    // גם אם מזהה הזמנה דלף, אסור להשתמש בפונקציה כדי להציף את הלקוח
    // או את צוות החנות במיילים. יצירה מותרת לבעל ההזמנה או למנהל;
    // הודעת "נשלחה" מותרת למנהל בלבד.
    const jwt = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: { user }, error: authErr } = await sb.auth.getUser(jwt);
    if (authErr || !user) return json({ ok: false, error: 'נדרשת התחברות' }, 401);

    const { data: callerProfile } = await sb
      .from('profiles').select('role').eq('id', user.id).maybeSingle();
    const callerIsAdmin = callerProfile?.role === 'admin';

    if (event === 'shipped' && !callerIsAdmin) {
      return json({ ok: false, error: 'הודעת משלוח מותרת למנהל בלבד' }, 403);
    }
    if (event === 'created' && !callerIsAdmin && order.user_id !== user.id) {
      return json({ ok: false, error: 'אין הרשאה לשלוח מייל עבור הזמנה זו' }, 403);
    }

    // הרשימה בכרטיס הלקוח היא המקור העדכני לכל ההתראות והחשבוניות.
    // בהזמנות ישנות בלי רשימה נשמרת תאימות למייל שב-snapshot של ההזמנה.
    const configuredEmails = cleanEmails(order.customers?.email_recipients);
    const customerEmails = configuredEmails.length
      ? configuredEmails
      : cleanEmails([order.email, order.customers?.email]);
    const customerEmail = customerEmails[0] || null;
    const who = order.customers?.business_name || order.customers?.name || order.contact_name || 'לקוח יקר';
    const sent: string[] = [];
    const warnings: string[] = [];

    // ── אישור קבלה ──
    if (event === 'created') {
      if (customerEmails.length) {
        await sendMail(
          customerEmails,
          `אישור הזמנה #${order.order_number} — ${brand.name}`,
          customerCreatedEmail(order, brand, who),
        );
        sent.push(...customerEmails);
      } else {
        warnings.push('ללקוח אין כתובת מייל — לא נשלח אישור');
      }

      // ── התראה לצוות ──
      const { data: notify } = await sb
        .from('notification_emails').select('email')
        .eq('is_active', true).eq('on_new_order', true);
      const team = (notify || []).map((n: any) => n.email);

      if (team.length) {
        await sendMail(
          team,
          `🛍️ הזמנה חדשה #${order.order_number} מ-${who}`,
          teamCreatedEmail(order, brand, who, customerEmail),
        );
        sent.push(...team);
      }
    }

    // ── נשלחה ──
    if (event === 'shipped') {
      if (!customerEmails.length) return json({ ok: true, sent: [], warnings: ['ללקוח אין כתובת מייל'] });

      // אם כבר הופקה חשבונית — מצרפים אותה לאותו מייל
      const attachments: Attachment[] = [];
      const { data: invoices } = await sb
        .from('invoices').select('*')
        .eq('order_id', order_id).neq('status', 'cancelled')
        .order('issued_at', { ascending: false });

      for (const inv of invoices || []) {
        try {
          const { data: file, error: dlErr } = await sb.storage.from('invoices').download(inv.file_path);
          if (dlErr) throw dlErr;
          const buf = new Uint8Array(await file.arrayBuffer());
          // base64 בבלוקים — btoa על מערך גדול חורג ממגבלת הארגומנטים
          let bin = '';
          for (let i = 0; i < buf.length; i += 8192) {
            bin += String.fromCharCode(...buf.subarray(i, i + 8192));
          }
          attachments.push({
            filename: inv.file_name || `חשבונית-${inv.invoice_number || order.order_number}.pdf`,
            content: btoa(bin),
          });
        } catch (e) {
          warnings.push(`צירוף חשבונית ${inv.invoice_number || inv.file_path} נכשל: ${e instanceof Error ? e.message : e}`);
        }
      }

      await sendMail(
        customerEmails,
        `📦 הזמנה #${order.order_number} נשלחה — ${brand.name}`,
        shippedEmail(order, brand, who, attachments.length > 0),
        attachments,
      );
      sent.push(...customerEmails);
      if (attachments.length) warnings.push(`צורפו ${attachments.length} חשבוניות`);
    }

    return json({ ok: true, sent, warnings });
  } catch (e) {
    console.error(e);
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  } finally {
    await closeSmtp();
  }
});
