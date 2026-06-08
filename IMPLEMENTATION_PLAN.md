# Store Management System SaaS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` หรือ `superpowers:executing-plans` เพื่อทำตามแผนทีละ task. Steps ใช้ checkbox (`- [ ]`) สำหรับ track งาน.

**Goal:** สร้าง SaaS store management system ใหม่ใน `D:\Store management system saas` โดยใช้ business/domain structure จาก `C:\Users\burin\Accounting moojoom` แต่สร้าง UX/UI ใหม่ทั้งหมดและยกระดับเป็น multi-tenant SaaS.

**Architecture:** ใช้ modular SaaS architecture แยก tenant/store boundary, domain services, data adapters, UI modules และ public QR app. ย้าย logic สำคัญจาก source แบบ controlled migration ไม่ก๊อป secret หรือ legacy UI เป็น final product.

**Tech Stack:** Next.js App Router/React + TypeScript, Supabase Postgres/Auth/Realtime/Storage, Stripe Billing/Checkout/Customer Portal, Vercel Functions/Deployments, component system ใหม่, service/data adapter layer, unit/integration/E2E tests.

---

## 0. Operating Rules

- Source: `C:\Users\burin\Accounting moojoom`
- Target: `D:\Store management system saas`
- ห้ามก๊อป `.env`, API key, token, customer data, `node_modules/`, `graphify-out/`
- UX/UI ใหม่ทั้งหมด: ห้ามถือว่า `styles.css`, `index.html`, `order.html`, `public-tables.html` คือ final UI
- อนุญาตให้ใช้ source เป็น reference สำหรับ domain logic, data shape, edge cases, printing behavior, QR ordering flow
- Database/auth/realtime/storage target คือ Supabase เท่านั้น; Firebase เป็น legacy reference ไม่ใช่ backend target
- SaaS payment/subscription target คือ Stripe Billing; POS payment methods ของร้านเป็นคนละ domain
- Deploy/runtime target คือ Vercel; Netlify function จาก source เป็น reference logic เท่านั้น
- ทุก implementation/config/build/commit ต้องทำตาม version bump rule ของโปรเจกต์
- ทุก code/config change ต้อง review ด้วย `code_reviewer` ก่อนสรุปเสร็จ
- ทุกงานจบต้องอัปเดต Obsidian `Projects/Store management system saas/log.md`

## 1. Copy Strategy

### Copy As Reference Only

- `js/pos-types.js`
- `js/pos-mock-data.js`
- `js/POS_DATA_STRUCTURE.md`
- `PRINTING_GUIDE.md`
- `PLAN_BUFFET_QR_ORDERING.md`
- `PLAN_QR_FOOD_ORDERING_INTEGRATION.md`
- `FIREBASE_DATA_AUDIT.md`
- `RECEIPT_BUG_FIX.md`
- `TEST_GUIDE.md`
- `js/pos/cart-logic.js`
- `js/pos/order-service.js`
- `js/pos/print-service.js`
- `js/pos/print-browser.js`
- `js/pos/print-usb.js`
- `js/pos/print-bluetooth.js`
- `js/pos/print-ip.js`
- `js/pos/print-escpos.js`
- `js/pos/promptpay-qr.js`
- `js/buffet-service.js`
- `js/attendance/attendance.service.js`
- `js/utils/validation.js`
- `js/utils/error-handler.js`
- `js/utils/firebase-listener.js`
- `netlify/functions/notify.js`

### Do Not Copy

- `.env`, `.env.local`
- `node_modules/`
- `graphify-out/`
- hard-coded `firebaseConfig` and Google Maps script key from `js/config.js` / `index.html`
- `backup/` unless comparing missing logic only
- `styles.css` as final stylesheet
- corrupted Thai text from terminal output
- scratch tests that only verify old static UI manually

### Copy Method

- Create `docs/source-audit/` in target.
- Copy selected docs and small source references into `docs/source-audit/legacy-reference/` only if needed.
- For code logic, reimplement into TypeScript modules with tests instead of copying large JS files unchanged.
- Preserve function behavior through tests: cart totals, modifier selection, receipt calculation, QR order lifecycle, attendance payroll, report summaries.

## 2. Target File Map

```text
D:\Store management system saas\
  PROJECT_CONTEXT.md
  IMPLEMENTATION_PLAN.md
  package.json
  README.md
  .env.example
  .gitignore
  docs/
    source-audit/
    superpowers/plans/
    architecture/
    qa/
  src/
    app/
      (auth)/
      (dashboard)/
      pos/
      qr/[storeSlug]/[tableId]/
      settings/
      reports/
    modules/
      auth/
      tenants/
      stores/
      dashboard/
      accounting/
      cashflow/
      catalog/
      pos/
      qr-ordering/
      buffet/
      attendance/
      reports/
      settings/
      notifications/
      printing/
    shared/
      components/
      hooks/
      services/
      realtime/
      utils/
      validation/
    server/
      api/
      integrations/
  tests/
    unit/
    integration/
    e2e/
```

## 3. Data Model Baseline

### SaaS Boundary

- `Organization`: SaaS tenant/account
- `Store`: branch/business unit inside organization
- `User`: auth identity
- `Membership`: user role within organization/store
- `Permission`: action-level permission key such as `pos.refund`, `reports.view`, `users.manage`
- `MembershipPermission`: per-user permission override scoped to organization/store
- `AuditLog`: security/action log for permission changes and sensitive operations
- `Subscription`: plan, limits, billing status
- `BillingCustomer`: organization to Stripe customer mapping
- `BillingEvent`: processed Stripe webhook event idempotency record

### Store Operations

- `Transaction`: income/expense/cash adjustment
- `CashLedgerEntry`: cash movement and balance snapshot
- `Category`: accounting/category or product category depending namespace
- `Product`: sellable item
- `ProductVariant`: size/temp/SKU/stock quantity
- `ModifierGroup`: single/multi selectable option group
- `ModifierOption`: option with price delta
- `Order`: POS/QR order
- `OrderItem`: product + variant + modifiers + quantity + price snapshot
- `Payment`: method, amount, status, reference
- `ReceiptSettings`: receipt display/printing config
- `Printer`: browser/USB/Bluetooth/IP/ESC-POS config
- `Table`: table number/status/public ordering config
- `BuffetSession`: table session, package, guest count, charges
- `AttendanceRecord`: clock in/out, GPS evidence, status
- `PayrollSummary`: derived report per employee/date range

## 4. Agent Work Packages

### Package A - Project Bootstrap

Owner: `tech_lead` + main session

Scope:
- Initialize target project structure.
- Add package/version, `.gitignore`, `.env.example`, README.
- Add docs skeleton and source-audit policy.

Steps:
- [ ] Confirm target directory is `D:\Store management system saas`.
- [ ] Initialize app scaffold.
- [ ] Add `.gitignore` with `.env*`, `node_modules/`, `.next/`, `dist/`, `coverage/`, `graphify-out/`.
- [ ] Add `.env.example` with placeholder names only:
  - `NEXT_PUBLIC_APP_URL=`
  - `NEXT_PUBLIC_SUPABASE_URL=`
  - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=`
  - `SUPABASE_SERVICE_ROLE_KEY=`
  - `SUPABASE_DATABASE_URL=`
  - `GOOGLE_MAPS_API_KEY=`
  - `NOTIFICATION_WEBHOOK_URL=`
  - `VERCEL_PROJECT_ID=`
  - `VERCEL_ORG_ID=`
  - `STRIPE_SECRET_KEY=`
  - `STRIPE_WEBHOOK_SECRET=`
  - `STRIPE_PRICE_BASIC=`
  - `STRIPE_PRICE_PRO=`
  - `STRIPE_PRICE_ENTERPRISE=`
- [ ] Add `PROJECT_CONTEXT.md` and this plan.
- [ ] Run initial build/test command available for chosen stack.

Verification:
- `npm run build` or chosen equivalent passes.
- No secret value exists in tracked files.
- Secret scan returns no real credentials. Use a targeted scan that excludes planning/docs files to avoid self-matching documented patterns:

```powershell
rg -n --glob '!**/*.md' --glob '!docs/**' --glob '!node_modules/**' --glob '!graphify-out/**' "AIza[0-9A-Za-z_-]{30,}|https://[0-9A-Za-z_-]+-default-rtdb\\.[0-9A-Za-z.-]+\\.firebasedatabase\\.app|sk-[0-9A-Za-z]{20,}" .
```

After Supabase/Vercel setup exists, extend the scan to catch committed Supabase service keys, database URLs, and Vercel tokens without matching `.env.example` placeholders.

### Package B - Source Audit And Mapping

Owner: `tech_writer` or `architect-researcher`

Scope:
- Turn source knowledge into migration map.
- No runtime code changes.

Steps:
- [ ] Read `PROJECT_CONTEXT.md`.
- [ ] Read source Graphify report: `C:\Users\burin\Accounting moojoom\graphify-out\GRAPH_REPORT.md`.
- [ ] Create `docs/source-audit/module-map.md` with table:
  - legacy file
  - target module
  - domain rules to preserve
  - UI to discard
  - tests required
- [ ] Create `docs/source-audit/secret-risk.md` listing files that must not be copied directly.
- [ ] Create `docs/source-audit/migration-order.md` matching phases in this plan.

Verification:
- Each source module in `PROJECT_CONTEXT.md` has target module owner.
- Secret-risk doc includes `js/config.js`, `index.html`, `.env`, `notify-server.js` if it reads env.

### Package C - Core Types And Validation

Owner: `backend_dev` or `tech_lead`

Scope:
- Create TypeScript domain model before UI.

Files:
- `src/modules/tenants/types.ts`
- `src/modules/stores/types.ts`
- `src/modules/catalog/types.ts`
- `src/modules/pos/types.ts`
- `src/modules/accounting/types.ts`
- `src/modules/attendance/types.ts`
- `src/shared/validation/*`
- `tests/unit/*`

Steps:
- [ ] Port `Category`, `Product`, `ProductVariant`, `ModifierGroup`, `ModifierOption` from `js/pos-types.js` into TypeScript.
- [ ] Add SaaS models: `Organization`, `Store`, `Membership`, `Role`, `Permission`, `MembershipPermission`, `AuditLog`.
- [ ] Add billing models: `Subscription`, `BillingCustomer`, `BillingEvent`, `PlanLimit`.
- [ ] Define permission keys:
  - `dashboard.view`
  - `pos.use`
  - `pos.discount`
  - `pos.refund`
  - `pos.delete_bill`
  - `orders.manage_qr`
  - `catalog.view`
  - `catalog.manage`
  - `stock.manage`
  - `cashflow.view`
  - `cashflow.manage`
  - `reports.view`
  - `attendance.clock`
  - `attendance.manage`
  - `settings.view`
  - `settings.manage_store`
  - `users.manage`
  - `permissions.manage`
  - `notifications.manage`
- [ ] Define role defaults for `owner`, `admin`, `manager`, `cashier`, `staff`.
- [ ] Add order/payment/receipt/printer types.
- [ ] Add accounting/cashflow types.
- [ ] Add attendance/payroll types.
- [ ] Port validation rules from `js/utils/validation.js` without browser coupling.
- [ ] Add unit tests for required fields, price number validation, phone/date/email validation.

Verification:
- Unit tests pass.
- Typecheck passes.

### Package D - Supabase Data Adapter Layer

Owner: `backend_dev`

Scope:
- Implement Supabase as the primary backend while keeping legacy Firebase concepts only as migration reference.

Files:
- `src/shared/services/data-client.ts`
- `src/shared/realtime/realtime-client.ts`
- `src/modules/*/repository.ts`
- `src/server/integrations/supabase/*`
- `supabase/migrations/*`
- `supabase/seed.sql`

Steps:
- [ ] Define repository interfaces per module.
- [ ] Define realtime subscription interface based on legacy `managedOnValue()` semantics.
- [ ] Check current Supabase changelog/docs before implementing Auth, RLS, Realtime, Storage, and SSR helpers.
- [ ] Design Supabase schema with `organizations`, `stores`, `memberships`, catalog, POS, accounting, attendance, reports, settings tables.
- [ ] Add permission tables:
  - `permissions`
  - `role_permission_defaults`
  - `membership_permission_overrides`
  - `audit_logs`
- [ ] Add billing tables:
  - `billing_customers`
  - `subscriptions`
  - `billing_events`
  - `plan_limits`
- [ ] Add permission security invariants:
  - Only `owner` can grant/revoke owner-level permissions.
  - Only `owner` can grant/revoke billing/subscription permissions.
  - Only `owner` can grant/revoke `permissions.manage`.
  - Only `owner` can assign or remove `owner` role.
  - Only `owner` can promote a user to `admin`; admin can manage lower roles only when explicitly allowed.
  - Admin cannot modify owner memberships.
  - Admin cannot modify their own role or permission overrides.
  - Admin cannot grant a permission they do not currently have.
  - Admin can manage only users within the same organization/store scope.
- [ ] Add permission-table RLS contract:
  - Every permission table row must include `organization_id`; store-scoped rows must include `store_id`.
  - `membership_permission_overrides` writes must validate actor membership in the same organization/store.
  - Deny cross-tenant and cross-store reads/writes by default.
  - Deny self-edit/self-escalation in RLS and server action checks.
  - Server action must re-check actor permissions inside the same transaction before writing overrides.
  - `audit_logs` must be append-only: allow insert from trusted server path, deny client update/delete.
- [ ] Add tenant/store foreign keys and indexes before feature tables are consumed.
- [ ] Enable RLS on every exposed table.
- [ ] Write RLS policies based on membership/store access, not `user_metadata`.
- [ ] Implement Supabase server client and browser client with lazy initialization.
- [ ] Add Supabase Storage buckets and policies:
  - `product-images`: public read only if product image is meant to be public; write limited by organization/store membership.
  - `receipt-assets`: private by default; read/write limited to store admins/managers.
  - `staff-evidence`: private only; read limited to owner/admin/manager for the same organization/store.
  - Object paths must start with `organizationId/storeId/...` or stricter equivalent.
  - Policies must cover `SELECT`, `INSERT`, `UPDATE`, `DELETE`; upsert requires INSERT + SELECT + UPDATE.
- [ ] Implement Supabase repository adapters using env config only.
- [ ] Implement Supabase Realtime subscriptions for POS/table/order/status updates.
- [ ] Add cleanup/unsubscribe pattern test matching legacy listener risk.
- [ ] Add error mapping based on legacy `handleFirebaseError()`.

Verification:
- Integration tests mock adapter and assert unsubscribe runs on module unmount/navigation.
- Supabase migrations apply locally or in linked preview environment.
- RLS policies are tested for owner/admin/manager/cashier/staff and cross-tenant denial.
- Permission RLS/server checks are tested for allowed/denied actions per role and per-user override.
- Permission escalation tests cover:
  - admin cannot grant `permissions.manage`
  - admin cannot modify owner
  - admin cannot modify self
  - admin cannot promote staff to admin/owner
  - admin cannot grant permissions they do not have
  - cross-tenant and cross-store override writes are denied
  - owner override success path works
- Audit log tests prove update/delete are denied and permission changes write audit logs in the same server transaction.
- Storage policy tests cover upload/read/update/delete for product images, receipt assets, and staff evidence, including cross-tenant denial.
- No hard-coded Supabase URL/key/service role.

### Package D2 - Stripe Billing And Subscription

Owner: `backend_dev` + `devops`

Scope:
- Implement SaaS subscription billing with Stripe while keeping in-store POS payments separate.
- Implement pricing tiers from the approved subscription model:
  - `starter`: 490-690 THB/month, target ร้านอาหารทั่วไป/คาเฟ่ขนาดเล็ก, includes POS พื้นฐาน, รายรับ-รายจ่าย, Browser receipt printing, customer history
  - `standard`: 990-1,290 THB/month, target ร้านบุฟเฟต์/หมูกุ่มที่ไม่มีสั่งผ่าน QR, includes Starter + buffet management, stock, Bluetooth/USB/IP printing
  - `premium`: 1,590-2,290 THB/month, target ร้านบุฟเฟต์ที่ต้องการลดพนักงาน, includes Standard + QR Food Ordering, LINE Notify, staff time GPS, commission
  - `enterprise`: Custom Quote, target ร้านหลายสาขา, includes centralized branch management/reporting, API integration, special support

Files:
- `src/modules/billing/types.ts`
- `src/modules/billing/billing-service.ts`
- `src/modules/billing/stripe-service.ts`
- `src/app/api/stripe/checkout/route.ts`
- `src/app/api/stripe/portal/route.ts`
- `src/app/api/stripe/webhook/route.ts`
- `supabase/migrations/*`
- `docs/billing/stripe.md`

Steps:
- [ ] Check current Stripe docs/API version before implementation; target latest API version available to the project.
- [ ] Use Stripe Billing APIs + Checkout Sessions with `mode: 'subscription'`.
- [ ] Use Stripe Prices for products/plans; do not use deprecated `plan` object.
- [ ] Create Checkout Session route:
  - require authenticated owner or actor with explicit billing permission
  - create/reuse Stripe Customer for organization
  - pass organization id in metadata
  - return Checkout URL only
- [ ] Create Customer Portal route:
  - require owner or explicit billing permission
  - open Stripe-hosted portal for upgrade/downgrade/cancel/payment method update
- [ ] Create Stripe webhook route:
  - verify signature using `STRIPE_WEBHOOK_SECRET`
  - handle at least `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_succeeded`, `invoice.payment_failed`
  - store processed event id in `billing_events` for idempotency
  - update Supabase subscription state in one server-side transaction where possible
- [ ] Add subscription gating:
  - max stores
  - max users/seats
  - buffet management availability: standard and above
  - stock management availability: standard and above
  - advanced printer adapters: standard and above
  - QR ordering availability: premium and above
  - LINE notification availability: premium and above
  - attendance GPS and commission availability: premium and above
  - centralized multi-branch reporting: enterprise
  - API integration: enterprise
  - advanced reports availability based on tier
  - advanced permissions availability if plan requires it
- [ ] Define Stripe subscription status mapping:
  - `trialing`: allow plan features within trial limits
  - `active`: allow plan features
  - `past_due`: allow temporary grace access only if configured; show billing warning and block high-risk expansion such as adding stores/users beyond current usage
  - `incomplete`: block paid features until initial payment succeeds
  - `incomplete_expired`: block paid features and require new Checkout Session
  - `unpaid`: block paid features except billing/account recovery
  - `canceled`: block paid features at cancellation effective date
  - `paused`: block paid features except billing/account recovery
- [ ] Define trial-ended-without-payment-method behavior: degrade to free/recovery state and require Checkout/Portal before paid feature access.
- [ ] Add billing audit logs for checkout start, portal open, subscription status changes, and webhook failures.

Verification:
- Stripe webhook signature verification rejects invalid signatures.
- Duplicate webhook event does not mutate subscription twice.
- All Stripe statuses map to expected feature access: `trialing`, `active`, `past_due`, `incomplete`, `incomplete_expired`, `unpaid`, `canceled`, `paused`.
- Failed initial payment and trial ended without payment method are blocked/degraded correctly.
- Non-owner without billing permission cannot open Checkout or Customer Portal.
- POS payment flows do not depend on Stripe Billing state except SaaS feature gating.

### Package E - Auth, Tenant, Store Context

Owner: `backend_dev` + `frontend_web`

Scope:
- Replace legacy username/password/local auth flow with SaaS-ready auth boundary.

Source references:
- `js/auth.controller.js`
- `js/main.js`
- `js/utils/auth-storage.js`

Steps:
- [ ] Implement `authService` interface.
- [ ] Implement Supabase Auth as the primary auth provider.
- [ ] Use `@supabase/ssr` for Next.js App Router auth.
- [ ] Implement separate browser/server Supabase clients.
- [ ] Use cookie-based sessions and PKCE flow; do not rely on localStorage-only auth for protected app routes.
- [ ] Add proxy/middleware session refresh for protected routes.
- [ ] Mark authenticated Server Component/API responses as dynamic/no-store where session-specific data is read.
- [ ] Implement session state and membership resolution.
- [ ] Implement permission resolver:
  - load role defaults
  - apply per-user override
  - scope result by organization/store
  - expose `can(permissionKey, storeId)` to server actions, route handlers, and client UI
- [ ] Implement permission mutation server action:
  - accept target membership, target store, desired role/permission changes, and reason
  - reject self-edit and cross-store/cross-tenant attempts
  - reject granting permissions above actor's effective permission set
  - reject owner/admin role changes unless actor is owner
  - write permission override and append audit log in one transaction
- [ ] Implement organization/store switcher state.
- [ ] Build new login screen UX.
- [ ] Build organization/store selection UX.
- [ ] Add role guard for owner/admin/manager/cashier/staff.
- [ ] Add action guard for sensitive operations such as refund, delete bill, discount, report view, settings update, and permission update.

Verification:
- Login/logout/store switch flow works in browser.
- Unauthorized role cannot access settings/admin routes.
- Unauthorized permission cannot call protected server action/API even if UI is bypassed.
- Protected route refresh keeps server/client auth state in sync.
- No authenticated response is cached across users.

### Package F - Catalog Module

Owner: `frontend_web` + `backend_dev`

Scope:
- Product menu management for POS/QR.

Source references:
- `js/settings/pos-menu.controller.js`
- `js/pos-types.js`
- `js/pos-mock-data.js`

Steps:
- [ ] Implement catalog repositories.
- [ ] Implement category CRUD.
- [ ] Implement product CRUD.
- [ ] Implement variants and modifiers editor.
- [ ] Implement stock tracking fields.
- [ ] Build UX as dense management table + side panel editor, not legacy form dump.
- [ ] Add tests for modifier single/multi selection rules.

Verification:
- Create product with variants/modifiers.
- Product appears in POS catalog query.
- Invalid required modifier config is rejected.

### Package G - POS Domain

Owner: `backend_dev` for logic, `frontend_web` for UI

Source references:
- `js/pos/cart-logic.js`
- `js/pos/order-service.js`
- `js/pos.js`
- `js/pos-view.controller.js`
- `js/pos/bill-delete.js`

Steps:
- [ ] Extract cart item key logic.
- [ ] Implement cart add/update/remove/clear.
- [ ] Implement price calculation: variant + modifiers, quantity, discount if present.
- [ ] Implement order draft, submit, payment, refund/delete rules.
- [ ] Implement held/resumed tickets if legacy behavior confirms need.
- [ ] Build new POS workspace UI:
  - left: product/category grid
  - center/right: cart and item editor
  - bottom/right: payment actions
  - modal/sheet: modifiers, payment, refund
- [ ] Add unit tests for cart totals and modifier combinations.
- [ ] Add E2E for order creation and payment.

Verification:
- POS order can be completed and appears in report source.
- Required modifiers block checkout until selected.
- Refund/delete path logs reason and permission.

### Package H - Printing And Receipt

Owner: `backend_dev` + `qa_engineer`

Source references:
- `js/pos/print-service.js`
- `js/pos/print-browser.js`
- `js/pos/print-usb.js`
- `js/pos/print-bluetooth.js`
- `js/pos/print-ip.js`
- `js/pos/print-escpos.js`
- `js/receipt-settings.js`
- `PRINTING_GUIDE.md`
- `RECEIPT_BUG_FIX.md`

Steps:
- [ ] Define `PrintAdapter` interface.
- [ ] Implement browser receipt preview first.
- [ ] Implement ESC/POS formatter as pure function.
- [ ] Keep USB/Bluetooth/IP adapters behind capability checks.
- [ ] Implement receipt settings editor in new settings UI.
- [ ] Add tests for Thai text, totals, taxes/fees, QR/payment display.

Verification:
- Browser print preview renders receipt.
- ESC/POS output snapshot matches expected line structure.
- Unsupported adapter shows actionable UI state, not crash.

### Package I - QR Ordering And Public Tables

Owner: `frontend_web` + `backend_dev`

Source references:
- `order.html`
- `public-tables.html`
- `js/qr-order/qr-main.js`
- `js/public-tables.js`
- `PLAN_QR_FOOD_ORDERING_INTEGRATION.md`

Steps:
- [ ] Define public route `/qr/[storeSlug]/[tableId]`.
- [ ] Implement public catalog read model.
- [ ] Implement customer cart and order submit.
- [ ] Implement table status read/write service.
- [ ] Build public mobile-first ordering UX.
- [ ] Build staff table monitor UX.
- [ ] Add anti-abuse/rate-limit design before public launch.

Verification:
- Public QR page loads without admin auth.
- Customer can submit order to correct store/table.
- Staff sees incoming QR order in POS/table monitor.

### Package J - Buffet Mode

Owner: `backend_dev` + `frontend_web`

Source references:
- `js/buffet-service.js`
- `PLAN_BUFFET_QR_ORDERING.md`

Steps:
- [ ] Decide feature flag: buffet mode enabled per store.
- [ ] Implement buffet package and session types.
- [ ] Implement session create/add guests/close.
- [ ] Connect buffet charges to order/payment.
- [ ] Build table/session UX.
- [ ] Add tests for guest count, package charge, close session.

Verification:
- Buffet session can start, receive QR orders, close and bill correctly.

### Package K - Accounting And Cashflow

Owner: `backend_dev` + `frontend_web`

Source references:
- `js/entry.controller.js`
- `js/cashflow.controller.js`
- `js/dashboard.controller.js`

Steps:
- [ ] Implement transaction model and repository.
- [ ] Implement income/expense entry form.
- [ ] Implement cash ledger calculation.
- [ ] Implement category filtering and pagination.
- [ ] Connect POS payments to accounting/cashflow summary.
- [ ] Build new accounting UX with table, filters, quick add, summary strip.

Verification:
- Manual transaction changes dashboard/cashflow.
- POS payment creates correct cashflow entry or report source.

### Package L - Attendance And Payroll

Owner: `backend_dev` + `frontend_web`

Source references:
- `js/attendance/attendance.controller.js`
- `js/attendance/attendance.service.js`
- `js/attendance/attendance.views.js`
- `js/attendance/geo.utils.js`
- `js/attendance/qr-scanner.js`

Steps:
- [ ] Implement attendance records and clock action domain.
- [ ] Implement timezone functions for Bangkok date/month.
- [ ] Implement geolocation evidence model.
- [ ] Implement QR/scanner support only after base clock flow works.
- [ ] Build staff time tracking UX.
- [ ] Build manager timesheet/payroll report UX.
- [ ] Add tests for clock in/out, backdate, payroll calculation.

Verification:
- Staff clock in/out persists.
- Manager report matches expected hours/pay.

### Package M - Dashboard And Reports

Owner: `frontend_web` + `data_analyst`

Source references:
- `js/dashboard.controller.js`
- `js/reports.controller.js`
- `js/views.js`

Steps:
- [ ] Define dashboard query contracts.
- [ ] Implement sales summary, cash summary, stock alert, staff status widgets.
- [ ] Implement reports: sales overview, payment method, top products, employee report.
- [ ] Build quiet operational dashboard, not marketing hero UI.
- [ ] Add date range and store filters.
- [ ] Add export-ready data shape.

Verification:
- Report totals match POS/accounting test fixtures.
- Dashboard handles empty store without errors.

### Package N - Settings, Notifications, Integrations

Owner: `backend_dev` + `frontend_web`

Source references:
- `js/settings/settings.controller.js`
- `js/receipt-settings.js`
- `netlify/functions/notify.js`
- `notify-server.js`

Steps:
- [ ] Implement store profile settings.
- [ ] Implement users/members/roles settings.
- [ ] Implement admin permission management UI:
  - list employees by store
  - assign role
  - toggle per-user permissions
  - copy permissions from another employee
  - reset to role default
  - show effective permissions after overrides
  - show read-only/disabled state when actor lacks `permissions.manage`
  - show clear forbidden error when server rejects stale or unauthorized changes
  - refresh effective permissions after save or after actor permission is revoked
  - require `permissions.manage` to save changes
- [ ] Write append-only audit log entry for every role/permission change with `organization_id`, `store_id`, `actor_user_id`, `target_user_id`, `action`, `before`, `after`, `reason`, `request_id`, `ip`, `user_agent`, `created_at`.
- [ ] Implement receipt/printer settings.
- [ ] Implement billing settings page:
  - show current plan and subscription status
  - show store/user limits
  - open Stripe Checkout for new subscription
  - open Stripe Customer Portal for self-service management
  - show read-only state for users without billing permission
- [ ] Implement notification service interface.
- [ ] Port notify function behavior into Vercel Route Handler or Vercel Function without secrets.
- [ ] Build settings UX with tabs/sections.

Verification:
- Admin can update store settings.
- Owner/admin with `permissions.manage` can update employee access by store.
- Admin without `permissions.manage` cannot update employee access.
- Employee permission changes affect UI visibility and server-side action access.
- Admin cannot grant `permissions.manage`, modify owner, modify self, or promote staff to admin/owner.
- Permission screen is read-only with disabled save when actor lacks permission.
- Stale permission changes are rejected by server and UI refreshes effective permissions.
- Permission change creates audit log.
- Audit logs cannot be updated or deleted by client roles.
- Owner or billing-authorized user can open Checkout/Portal.
- Unauthorized user cannot open Checkout/Portal even if UI is bypassed.
- Cashier cannot access restricted settings.
- Notification function can be tested with mock endpoint.

### Package N2 - Vercel Deployment Setup

Owner: `devops`

Scope:
- Configure Vercel deployment, preview flow, environment variable policy, and rollback notes.

Files:
- `vercel.json` if needed
- `.env.example`
- `docs/deployment/vercel.md`
- `docs/deployment/env-vars.md`

Steps:
- [ ] Confirm Next.js app builds locally with `npm run build`.
- [ ] Document Vercel project link process; do not commit `.vercel/project.json` unless project policy explicitly allows it.
- [ ] Define required Vercel env vars by environment: Development, Preview, Production.
- [ ] Add Supabase env var mapping:
  - browser: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
  - server only: `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DATABASE_URL`
- [ ] Add deployment workflow:
  - preview: Vercel Git preview deployment on PR/branch
  - production default: promote validated preview deployment
  - direct production deploy: `vercel deploy --prod` only when reason, impact, rollback target, and user approval are documented
- [ ] Add rollback workflow using Vercel rollback or promote previous validated deployment.
- [ ] Add build verification checklist before production.

Verification:
- `vercel build` passes after app scaffold and env placeholders are configured.
- Preview deployment URL is tested before production.
- Production checklist includes preview URL, verification result, production env confirmation, rollback target, and approval.
- Production deploy requires explicit user approval.

### Package O - UX/UI Redesign System

Owner: `frontend_web` + `ui-ux-polisher`

Scope:
- New UX/UI across SaaS.

Rules:
- Operational SaaS style: dense, calm, scan-friendly.
- No oversized marketing hero for app screens.
- No card-inside-card layout.
- Use icons for tool buttons where appropriate.
- Stable dimensions for POS grid/cart/toolbars.
- Verify mobile and desktop overlap.

Steps:
- [ ] Create design tokens: colors, type scale, spacing, radius <= 8px unless component system requires.
- [ ] Create shell layout: sidebar/topbar/store switcher.
- [ ] Create shared components: data table, filter bar, stat strip, modal/sheet, toast, confirm dialog.
- [ ] Create empty/loading/error states.
- [ ] Apply to modules incrementally.
- [ ] Browser verify main flows at desktop and mobile widths.

Verification:
- No text overlap in app shell, POS, catalog, reports.
- Console has no runtime errors in main flows.

### Package P - QA, Security, Production Readiness

Owner: `qa_engineer` + `code_reviewer` + `devops`

Steps:
- [ ] Add unit test suite for domain logic.
- [ ] Add integration tests for repositories/adapters.
- [ ] Add E2E tests:
  - login/store switch
  - create catalog item
  - POS checkout
  - QR order submit
  - attendance clock in/out
  - dashboard/report update
- [ ] Add secret scan check.
- [ ] Add Supabase RLS test suite for cross-tenant isolation.
- [ ] Add Supabase Storage access-control tests for public/private buckets and cross-tenant object paths.
- [ ] Add Stripe Billing tests for Checkout route auth, Portal route auth, webhook signature verification, event idempotency, all subscription status mappings, failed initial payment, trial-ended-without-payment-method behavior, and subscription gating.
- [ ] Run Supabase advisors/security checklist before migrations are accepted.
- [ ] Add build/typecheck/lint scripts.
- [ ] Add Vercel deployment notes and rollback notes.
- [ ] Run code review after each implementation phase.

Verification:
- Build/typecheck/test pass.
- `rg` scan finds no real secrets.
- `code_reviewer` findings resolved or explicitly accepted.

## 5. Recommended Implementation Order

1. Bootstrap target project and docs.
2. Source audit and module map.
3. Core types + validation.
4. Supabase schema, RLS, data adapter + realtime cleanup pattern.
5. Stripe billing/subscription foundation.
6. Auth/tenant/store context.
7. Catalog.
8. POS domain.
9. Printing/receipt preview.
10. QR ordering.
11. Accounting/cashflow.
12. Dashboard/reports.
13. Attendance/payroll.
14. Buffet mode.
15. Settings/notifications/billing UI.
16. Vercel deployment setup.
17. UX polish and full E2E QA.
18. Production readiness and deployment prep.

## 6. Mandatory Context Package Template For Agents

```markdown
Project: Store management system saas (`D:\Store management system saas`)
Goal:
Agent role:
Expected output:
Scope:
Out of scope:
Files changed:
Files to inspect:
Diff/commit:
Tests/verification run:
Known failures/blockers:
Constraints: Thai report, Supabase DB/Auth/Realtime/Storage, Stripe Billing for SaaS subscription, Vercel deploy, no secret copy, no fallback silently, no port 7842, code changes require code_reviewer, Obsidian log required
Risks to focus:
User requirements: copy system structure from `C:\Users\burin\Accounting moojoom`, build full SaaS, redesign UX/UI completely
Obsidian paths:
- `C:\Users\burin\Documents\Obsidian Vault\Projects\Store management system saas\log.md`
- `C:\Users\burin\Documents\Obsidian Vault\Projects\Store management system saas\issue.md`
Plan/spec/checklist: `D:\Store management system saas\IMPLEMENTATION_PLAN.md`
Deadline/priority:
```

## 7. Definition Of Done Per Phase

- Requirements and source references read.
- Minimal implementation or document deliverable completed.
- Tests/verification run or blocker documented.
- Supabase migrations/RLS verified when database changes are involved.
- Stripe webhook/signature/idempotency/subscription gating verified when billing changes are involved.
- Vercel preview/build verified when deployment/runtime changes are involved.
- No secrets copied.
- Obsidian log updated.
- `code_reviewer` run for code/config/runtime changes.
- Version bumped before build/commit when applicable.
