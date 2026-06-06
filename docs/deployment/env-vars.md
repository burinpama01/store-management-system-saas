# Environment Variables Reference

All values are set in the Vercel dashboard (Settings → Environment Variables) or in `.env.local` for local development.
**Never commit real secrets.** Use `.env.example` as the template.

## Required Variables

### Application

| Variable | Visibility | Required | Description |
|----------|-----------|----------|-------------|
| `APP_URL` | Server-only | Production | Base URL for Stripe redirect URLs. E.g. `https://your-app.vercel.app` |

### Supabase

| Variable | Visibility | Required | Description |
|----------|-----------|----------|-------------|
| `NEXT_PUBLIC_SUPABASE_URL` | Browser + Server | All envs | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Browser + Server | All envs | Supabase anon/publishable key (safe to expose) |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only | All envs | Service role key — bypasses RLS. **Never expose to browser.** |
| `SUPABASE_DATABASE_URL` | Server-only | All envs | Direct Postgres URL for migrations. Format: `postgresql://postgres:<pw>@db.<ref>.supabase.co:5432/postgres` |

### Stripe

| Variable | Visibility | Required | Description |
|----------|-----------|----------|-------------|
| `STRIPE_SECRET_KEY` | Server-only | All envs | `sk_live_...` in Production, `sk_test_...` in Development/Preview |
| `STRIPE_WEBHOOK_SECRET` | Server-only | All envs | `whsec_...` — from Stripe Dashboard → Webhooks → signing secret. Must match the endpoint URL for each environment. |
| `STRIPE_PRICE_STARTER` | Server-only | Production | Stripe Price ID for starter plan |
| `STRIPE_PRICE_STANDARD` | Server-only | Production | Stripe Price ID for standard plan |
| `STRIPE_PRICE_PREMIUM` | Server-only | Production | Stripe Price ID for premium plan |
| `STRIPE_PRICE_ENTERPRISE` | Server-only | Production | Stripe Price ID for enterprise plan |

## Variable Visibility Rules

- **`NEXT_PUBLIC_` prefix**: variable is bundled into the browser JavaScript. Only use for values safe to expose publicly.
- **No prefix**: variable is available only in server-side code (Route Handlers, Server Actions, Server Components). Use for secrets.

Never put `STRIPE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, or `STRIPE_WEBHOOK_SECRET` in a `NEXT_PUBLIC_` variable.

## Per-Environment Recommendations

### Development
```
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...  # from: stripe listen --forward-to localhost:3000/api/stripe/webhook
APP_URL=http://localhost:3000
```

### Preview (Vercel branch deployments)
```
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...  # configure a test-mode webhook for *.vercel.app/* in Stripe
APP_URL=  # leave empty — Vercel auto-injects VERCEL_URL; alternatively set per deployment
```

### Production
```
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...  # configure live-mode webhook for https://your-app.vercel.app/api/stripe/webhook
APP_URL=https://your-app.vercel.app
```

## Supabase Auth Configuration

After setting env vars, also configure in Supabase Dashboard:
1. **Authentication → URL Configuration**:
   - Site URL: `https://your-app.vercel.app`
   - Redirect URLs: add `https://your-app.vercel.app/**` and `http://localhost:3000/**`

## Stripe Webhook Setup

For each Vercel environment, create a separate Stripe webhook endpoint:
- Development: Use `stripe listen --forward-to localhost:3000/api/stripe/webhook` (CLI handles signing secret)
- Preview/Production: Add endpoint in Stripe Dashboard → Developers → Webhooks

Events to listen for:
- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.payment_succeeded`
- `invoice.payment_failed`
