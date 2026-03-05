# Cricket Live (Vite + React + Supabase)

## 1) Install
```bash
npm install
```

## 2) Add Supabase keys
Copy `.env.example` to `.env` and fill in:

- VITE_SUPABASE_URL
- VITE_SUPABASE_ANON_KEY

Get these from Supabase → Project Settings → API.

## 3) Run locally
```bash
npm run dev
```

## Routes
- `/` Home (teams list)
- `/score` Scorer login + match list + create match
- `/score/:matchId` Scorer panel (basic ball insert demo + realtime log)
- `/match/:matchId` Public spectator page (realtime updates)

## Deploy to cPanel (static hosting)
1. `npm run build` → creates `dist/`
2. Upload **contents** of `dist/` to `public_html`
3. Add the provided `.htaccess` (from `cpanel_public_html/.htaccess`) into `public_html`
