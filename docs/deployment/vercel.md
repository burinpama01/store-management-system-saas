# Vercel Deployment Guide

## Overview

This app is deployed on Vercel as a Next.js 15 App Router project. The deployment pipeline uses:
- **Preview deployments** on every push to a branch (auto by Vercel Git integration)
- **Production promotion** by promoting a verified preview — not direct prod deploys

## Initial Project Setup

1. Install Vercel CLI: `npm i -g vercel`
2. Link the repo: `vercel link` (follow prompts)
3. Do **not** commit `.vercel/project.json` — it contains project IDs that should stay local

## Environment Variables

Set all env vars in the Vercel dashboard under **Settings → Environment Variables**. See `docs/deployment/env-vars.md` for the full list. Never commit real values to the repo — use `.env.example` as the template.

Vercel environments map to:
| Vercel env    | Used for                        | Notes                          |
|---------------|---------------------------------|--------------------------------|
| Development   | `vercel dev` or `vercel env pull` | Can use Stripe test mode keys |
| Preview       | Every branch push                | Use Stripe test mode keys      |
| Production    | Promoted preview only            | Use Stripe live mode keys      |

To pull dev vars locally: `vercel env pull .env.local`

## Build Verification Checklist

Before promoting a preview to production, verify all of the following:

- [ ] Preview deployment URL is accessible and loads the dashboard
- [ ] Login flow works (Supabase auth)
- [ ] POS flow: create order, add items, complete payment
- [ ] Stripe: open `/settings/billing` (owner account), start a checkout flow (test mode)
- [ ] Webhook: verify `billing_events` row is created after test checkout
- [ ] TypeScript: `npx tsc --noEmit` passes with 0 errors
- [ ] Tests: `npx vitest run` passes (79/79 as of 2026-05-18)
- [ ] No console errors on main flows (dashboard, catalog, POS, reports)
- [ ] Mobile width (375px): no text overflow in sidebar, POS grid, tables

## Deployment Workflows

### Preview (automatic)

Every push to a branch triggers a preview deployment. Vercel posts the URL in the PR. No manual steps needed.

### Production (promote preview)

1. Verify the preview URL passes the checklist above
2. Get explicit user approval (document: preview URL, verification result, production env confirmation, rollback target)
3. In Vercel dashboard: **Deployments** → select the verified preview → **Promote to Production**
4. Or via CLI: `vercel promote <deployment-url>`

Direct `vercel deploy --prod` is **only** allowed when there is a documented reason, impact assessment, rollback target, and user approval on record.

### Emergency Rollback

1. In Vercel dashboard: **Deployments** → find the last good production deployment → **Promote to Production**
2. Or via CLI: `vercel rollback [deployment-url]`
3. The rollback target should be identified and documented before every production promotion

## Build Command

Vercel auto-detects Next.js. The default build command is `next build`. No `vercel.json` required unless overrides are needed (cron jobs, custom headers, etc.).

If custom configuration is needed in future, prefer `vercel.ts` (TypeScript config) from `@vercel/config` over `vercel.json`.

## Notes

- `.vercel/project.json` is gitignored — each developer runs `vercel link` locally
- Stripe webhook endpoint in Stripe Dashboard must be set to `https://your-app.vercel.app/api/stripe/webhook`
- Supabase Auth: set `Site URL` and `Redirect URLs` in Supabase dashboard to the production URL
