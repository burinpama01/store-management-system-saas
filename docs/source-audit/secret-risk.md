# Secret Risk Files — Do Not Copy Directly

Files from `C:\Users\burin\Accounting moojoom` that must NOT be copied into this repo:

| File | Risk | Action |
|---|---|---|
| `.env` | Contains Firebase keys, Google Maps API key, other secrets | Read for env var names only; use `.env.example` in target |
| `.env.local` | Same as above | Same |
| `js/config.js` | Embeds `firebaseConfig` object with API key, authDomain, databaseURL | Extract env var names only; use Supabase env vars instead |
| `index.html` | Google Maps script tag with API key in URL param | Do not copy; rebuild without embedded keys |
| `notify-server.js` | May read `process.env` secrets; unknown key scope | Read for notify logic only; reimplement in Vercel Route Handler |
| `netlify/functions/notify.js` | Netlify function wrapper using secrets | Port logic only, not secrets or function wrapper |
| `backup/` | May contain old configs with real credentials | Do not copy; compare logic only if specific gap identified |

## Verified: Target Has No Secrets

- `.env.example` contains only placeholder names (no values)
- `src/` contains no Firebase API keys, Google Maps keys, or service role keys
- Secret scan (regex: `AIza...`, Firebase RTDB URLs, `sk-...`) returned no matches in `src/`

## After Supabase Setup

Extend secret scan to cover:
- Supabase service role key pattern: `eyJ...` (JWT prefix)
- Supabase database URL pattern: `postgresql colon slash slash ...`
- Vercel token pattern: sensitive CI env

Run extended scan before any production deployment:
```
rg -n --glob '!**/*.md' --glob '!docs/**' --glob '!node_modules/**' --glob '!.next/**' --glob '!.env.example' "SUPABASE_SERVICE_ROLE_KEY\s*=\s*\S|eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|postgresql://[^\s`]+|STRIPE_SECRET_KEY\s*=\s*\S|STRIPE_WEBHOOK_SECRET\s*=\s*\S|sk_(live|test)_[A-Za-z0-9]+|whsec_[A-Za-z0-9]+|VERCEL_TOKEN\s*=\s*\S|vercel_[A-Za-z0-9]+" .
```
