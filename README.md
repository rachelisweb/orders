# מערכת ההזמנות של רחליס

אתר סטטי לניהול והזנת הזמנות, עם Supabase כמסד נתונים וכשכבת backend.

## מבנה הפרויקט

```text
frontend/
├── index.html          # אפליקציית ההזמנות
├── admin.html          # ממשק הניהול
├── app.js              # לוגיקת אפליקציית ההזמנות
├── admin.js            # לוגיקת ממשק הניהול
├── lib.js              # קוד משותף
├── config.js           # הגדרות החיבור הציבוריות ל-Supabase
├── styles.css          # עיצוב משותף
├── docs/               # הוראות תפעול והקמה
└── supabase/
    ├── functions/      # Edge Functions
    └── migrations/     # מיגרציות מסד הנתונים
```

## הרצה מקומית

מהתיקייה הזו:

```powershell
python -m http.server 8080 --bind 127.0.0.1
```

לאחר מכן פותחים את `http://127.0.0.1:8080/`.

## Supabase

המיגרציות והפונקציות נשמרות תחת `supabase`. מידע זמני של Supabase CLI בתיקייה
`supabase/.temp` הוא מקומי ואינו נשמר ב-Git.

לפני פריסה יש לקשר את הפרויקט באמצעות Supabase CLI, ולאחר מכן להריץ לפי הצורך:

```powershell
supabase db push
supabase functions deploy
```

להגדרת iCount ראו [docs/ICOUNT_SETUP.md](docs/ICOUNT_SETUP.md).
