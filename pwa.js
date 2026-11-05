// התקנת האתר כאפליקציה בטלפון.
//
// 1. רושם את ה-service worker (פרטים ב-sw.js).
// 2. מנהל את כפתורי ההתקנה: כל אלמנט עם data-pwa-install מוצג רק כשאפשר
//    להתקין. באנדרואיד לחיצה פותחת את חלון ההתקנה של כרום, ובאייפון
//    (שאין בו חלון כזה) נפתחות הוראות קצרות.
//    אלמנט עם data-pwa-banner הוא פס הזמנה שמוצג רק בטלפון, ו-data-pwa-dismiss
//    בתוכו סוגר אותו לצמיתות באותו דפדפן.
(() => {
  if ('serviceWorker' in navigator && window.isSecureContext) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch((err) => {
        console.warn('service worker registration failed', err);
      });
    });
  }

  const DISMISS_KEY = 'rachelis-install-banner-dismissed';
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isPhone = window.matchMedia('(pointer: coarse)').matches;
  const isInstalled = () => window.matchMedia('(display-mode: standalone)').matches
    || navigator.standalone === true;

  // כרום שולח את האירוע הזה רק כשהאתר עדיין לא מותקן וההתקנה אפשרית
  let installPrompt = null;

  function bannerDismissed() {
    try { return localStorage.getItem(DISMISS_KEY) === '1'; } catch { return false; }
  }

  function render() {
    const canInstall = !isInstalled() && (installPrompt !== null || isIOS);
    document.querySelectorAll('[data-pwa-install]').forEach((el) => { el.hidden = !canInstall; });
    document.querySelectorAll('[data-pwa-banner]').forEach((el) => {
      el.hidden = !(canInstall && isPhone && !bannerDismissed());
    });
  }

  function showIOSHelp() {
    let modal = document.getElementById('installHelp');
    if (!modal) {
      modal = document.createElement('div');
      modal.className = 'modal';
      modal.id = 'installHelp';
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      modal.setAttribute('aria-labelledby', 'installHelpTitle');
      modal.innerHTML = `
        <div class="modal-box install-help">
          <button class="modal-x" type="button" data-pwa-help-close aria-label="סגירה">✕</button>
          <img src="icons/icon-192.png" alt="" width="64" height="64">
          <h3 id="installHelpTitle">התקנה באייפון</h3>
          <ol>
            <li>לוחצים על כפתור השיתוף <svg class="share-ico" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 3v12M8 7l4-4 4 4M8 10H6a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-9a1 1 0 0 0-1-1h-2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
              (ריבוע עם חץ למעלה). אם הוא לא מופיע, לוחצים קודם על <b>⋯</b>.</li>
            <li>בוחרים <b>"הוספה למסך הבית"</b>.</li>
            <li>לוחצים <b>"הוספה"</b>, והאייקון של רחליס יופיע במסך הבית.</li>
          </ol>
          <button class="btn block" type="button" data-pwa-help-close>הבנתי</button>
        </div>`;
      modal.addEventListener('click', (e) => {
        if (e.target === modal || e.target.closest('[data-pwa-help-close]')) modal.classList.remove('active');
      });
      document.body.appendChild(modal);
    }
    modal.classList.add('active');
    modal.querySelector('.modal-x').focus();
  }

  async function install() {
    if (installPrompt) {
      const prompt = installPrompt;
      installPrompt = null;   // אפשר להשתמש בכל אירוע פעם אחת בלבד
      render();
      await prompt.prompt();
      await prompt.userChoice;
      return;
    }
    if (isIOS) showIOSHelp();
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();       // במקום הפס האוטומטי של כרום מוצגים הכפתורים שלנו
    installPrompt = e;
    render();
  });
  window.addEventListener('appinstalled', () => { installPrompt = null; render(); });

  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-pwa-install]')) { install(); return; }
    const dismiss = e.target.closest('[data-pwa-dismiss]');
    if (dismiss) {
      try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* פרטי/חסום: ייסגר עד הטעינה הבאה */ }
      dismiss.closest('[data-pwa-banner]').hidden = true;
    }
  });

  document.addEventListener('keydown', (e) => {
    const modal = document.getElementById('installHelp');
    if (e.key === 'Escape' && modal && modal.classList.contains('active')) modal.classList.remove('active');
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render);
  else render();
})();
