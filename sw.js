// Service worker של אפליקציית רחליס.
//
// בכוונה הוא לא שומר את קוד האפליקציה במטמון: כל עמוד, סקריפט ונתון
// מגיעים תמיד מהרשת, כך שכל עדכון שנדחף לאתר מגיע מיד גם לאפליקציה
// המותקנת. התפקיד היחיד שלו הוא להציג מסך "אין חיבור" כשאין אינטרנט,
// במקום מסך השגיאה של הדפדפן.
//
// כשמשנים את offline.html או את האייקון — להעלות את הגרסה כאן.
const CACHE = 'rachelis-offline-v2';
const OFFLINE_URL = 'offline.html';
const PRECACHE = [OFFLINE_URL, 'icons/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(PRECACHE.map(async (url) => {
      const res = await fetch(new Request(url, { cache: 'reload' }));
      if (!res.ok) throw new Error(`precache ${url}: ${res.status}`);
      // שרת שמקצר כתובות (offline.html ← offline) מחזיר תשובה "מנותבת",
      // ודפדפן מסרב להציג תשובה כזו במעבר עמוד. לכן שומרים עותק נקי.
      const clean = res.redirected
        ? new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: res.headers })
        : res;
      await cache.put(url, clean);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)));
    // מתחיל לטעון את העמוד במקביל להפעלת ה-service worker, כדי שלא יאט פתיחה
    if (self.registration.navigationPreload) await self.registration.navigationPreload.enable();
    await self.clients.claim();
  })());
});

const PRECACHE_PATHS = new Set(PRECACHE.map((url) => new URL(url, self.location.href).pathname));

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  // בקשות ל-Supabase, ל-Cloudinary, לגופנים ולכל אתר אחר עוברות ישר
  // לרשת בלי שה-service worker נוגע בהן.
  if (url.origin !== self.location.origin) return;

  // הקבצים המעטים שמסך "אין חיבור" צריך (למשל האייקון שלו) מגיעים מהמטמון
  if (request.mode !== 'navigate') {
    if (request.method === 'GET' && PRECACHE_PATHS.has(url.pathname)) {
      event.respondWith(caches.match(request, { cacheName: CACHE, ignoreSearch: true, ignoreVary: true }).then((hit) => hit || fetch(request)));
    }
    return;
  }

  event.respondWith((async () => {
    try {
      const preloaded = await event.preloadResponse;
      if (preloaded) return preloaded;
      return await fetch(request);
    } catch (err) {
      const offline = await caches.match(OFFLINE_URL, { cacheName: CACHE });
      return offline || Response.error();
    }
  })());
});
