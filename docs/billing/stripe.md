# Stripe Billing — Developer Reference

## Plans

| Plan       | THB/month         | Key features                                                       |
|------------|-------------------|--------------------------------------------------------------------|
| free       | 0                 | 1 store, 3 members, basic POS                                      |
| starter    | 490–690           | 1 store, 10 members, basic POS + receipts + cashflow               |
| standard   | 990–1,290         | 3 stores, 30 members, + buffet + stock + advanced printing         |
| premium    | 1,590–2,290       | 10 stores, 100 members, + QR ordering + LINE Notify + GPS clock    |
| enterprise | Custom quote      | Unlimited, multi-branch reporting, API integration                  |

## Required environment variables

```
STRIPE_SECRET_KEY=sk_live_...             # Never in client bundle
STRIPE_WEBHOOK_SECRET=whsec_...          # Webhook endpoint secret
STRIPE_PRICE_STARTER=price_...           # Stripe Price ID for starter plan
STRIPE_PRICE_STANDARD=price_...         # Stripe Price ID for standard plan
STRIPE_PRICE_PREMIUM=price_...          # Stripe Price ID for premium plan
STRIPE_PRICE_ENTERPRISE=price_...       # Stripe Price ID for enterprise plan
APP_URL=https://your-app.vercel.app              # Server-only; used in Stripe redirect URLs
```

Set these in Vercel dashboard → Settings → Environment Variables for each environment.
Do **not** commit `.env.local` or any file containing real keys.

## Routes

| Method | Path                        | Auth           | Purpose                          |
|--------|-----------------------------|----------------|----------------------------------|
| POST   | /api/stripe/checkout        | owner only     | Create Checkout Session, return URL |
| POST   | /api/stripe/portal          | owner only     | Create Portal Session, return URL   |
| POST   | /api/stripe/webhook         | Stripe sig only | Handle subscription lifecycle events |

### Checkout flow

1. Client calls `POST /api/stripe/checkout` with `{ priceId }`.
2. Server finds/creates a Stripe Customer for the organization.
3. Server creates a Checkout Session with `mode: "subscription"`.
4. Server returns `{ url }`. Client redirects to that URL.
5. After payment Stripe fires `checkout.session.completed` + `customer.subscription.created`.

### Portal flow

1. Client calls `POST /api/stripe/portal`.
2. Server looks up the Stripe Customer for the organization (must already exist).
3. Server creates a Portal Session and returns `{ url }`.
4. Client redirects. User can upgrade/downgrade/cancel/update payment method.

### Webhook flow

1. Stripe signs the request body with `STRIPE_WEBHOOK_SECRET`.
2. Route verifies signature — rejects invalid requests with 400.
3. Event id is checked against `billing_events` for idempotency.
4. Handler updates `subscriptions` and `billing_customers` in Supabase.
5. Event id is written to `billing_events`. Returns 200.
6. On handler error: returns 500 so Stripe retries.

### Handled event types

| Event type                        | What it does                                        |
|-----------------------------------|-----------------------------------------------------|
| checkout.session.completed        | Stores billing_customers row                        |
| customer.subscription.created     | Upserts subscriptions row with plan + status        |
| customer.subscription.updated     | Updates subscriptions row                           |
| customer.subscription.deleted     | Sets status = canceled                              |
| invoice.payment_succeeded         | Logged; subscription.updated handles status         |
| invoice.payment_failed            | Logged; subscription.updated handles status         |

## Subscription status → feature access

| Status             | Access                                              |
|--------------------|-----------------------------------------------------|
| active             | Full plan features                                  |
| trialing           | Full plan features within trial                     |
| past_due           | Grace access only; show billing warning in UI       |
| incomplete         | Blocked — initial payment not yet succeeded         |
| incomplete_expired | Blocked — require new Checkout Session              |
| unpaid             | Blocked                                             |
| canceled           | Blocked                                             |
| paused             | Blocked                                             |

## Local development / testing

1. Install Stripe CLI: `brew install stripe/stripe-cli/stripe`
2. Forward webhooks: `stripe listen --forward-to localhost:3000/api/stripe/webhook`
3. CLI prints a webhook signing secret — paste into `.env.local` as `STRIPE_WEBHOOK_SECRET`.
4. Use test mode keys (`sk_test_...`).

## Subscription gating (planned, Package P)

Feature gating is implemented in `src/modules/billing/types.ts → getPlanFeatures()`.
Call `canUseFeature(billingState, 'qrOrdering')` before rendering premium features.
Full middleware enforcement is deferred to Package P.
