# Store Management System SaaS - Project Context

> เอกสารนี้คือ context package สำหรับ agent ทุกตัวก่อนเริ่มงานใน `D:\Store management system saas`.

## Source Project

- Source: `C:\Users\burin\Accounting moojoom`
- Target: `D:\Store management system saas`
- Goal: สร้างระบบ Store Management SaaS เต็มรูปแบบ โดยย้ายโครงสร้างระบบ/logic/domain จาก source แต่ทำ UX/UI ใหม่ทั้งหมด
- ห้ามก๊อป secret: `.env`, Firebase key, Google Maps key, token, credential, customer/private data
- ห้ามก๊อป output ชั่วคราว: `node_modules/`, `graphify-out/`, `out.txt`, backup ที่ไม่ใช้จริง, test scratch ที่ไม่ใช่ regression suite

## Source Overview จาก Graphify

- Graphify run: `graphify update .` ที่ `C:\Users\burin\Accounting moojoom`
- Result: 669 nodes, 1421 edges, 33 communities
- Core hubs:
  - `showToast()` ใช้ข้าม dashboard, attendance, auth, reports, cashflow
  - `handleFirebaseError()` เป็น error boundary ของ Firebase operations
  - `managedOnValue()` และ `cleanupViewListeners()` จัดการ Firebase listener lifecycle
  - `initApp()` เป็น entry bootstrap
  - `getStore()` ใช้กับ multi-store context
  - `doClockAction()` เป็น attendance core action
  - `generateSalesReports()` เป็น reports core
  - `printViaBrowser()` เป็น printing core

## Existing Business Modules

| Area | Source files | Purpose | SaaS target |
|---|---|---|---|
| App shell/auth/store select | `index.html`, `js/main.js`, `js/auth.controller.js`, `js/utils/auth-storage.js` | login, auto-login, role, store selection | Auth + tenant/store switcher |
| Firebase config/data access | `js/config.js`, `js/data-loader.js`, `js/utils/firebase-listener.js` | Firebase RTDB access and listener cleanup | migrate concepts to Supabase Postgres/Auth/Realtime through service layer |
| Dashboard | `js/dashboard.controller.js`, `js/views.js` | income/expense/POS summary, charts | SaaS dashboard widgets |
| Entry/accounting | `js/entry.controller.js` | income/expense transaction entry | transactions module |
| Cashflow | `js/cashflow.controller.js` | cash balance, cashflow history | cash ledger module |
| POS | `js/pos.js`, `js/pos-view.controller.js`, `js/pos/*` | cart, orders, payment, printing, delete/refund | POS workspace module |
| POS menu | `js/settings/pos-menu.controller.js`, `js/pos-types.js`, `js/pos-mock-data.js` | categories, products, variants, modifiers | catalog module |
| QR ordering | `order.html`, `public-tables.html`, `js/qr-order/qr-main.js`, `js/public-tables.js` | customer self-order/table status | public ordering app |
| Buffet | `js/buffet-service.js`, `PLAN_BUFFET_QR_ORDERING.md` | buffet sessions, guest count, package charge | optional restaurant mode |
| Attendance | `js/attendance/*` | clock in/out, GPS/map, payroll reports | staff time tracking |
| Reports | `js/reports.controller.js` | sales/payment/employee reports | analytics module |
| Settings | `js/settings/settings.controller.js`, `js/receipt-settings.js` | store, employees, receipts, printer/settings | tenant admin/settings |
| Printing | `js/pos/print-*`, `PRINTING_GUIDE.md` | browser, USB, Bluetooth, IP, ESC/POS, PDF fallback | print adapter layer |
| Utilities | `js/utils/*` | logger, validation, notify, errors, image compression | shared packages/hooks/services |
| Netlify notify | `netlify/functions/notify.js`, `notify-server.js` | notification integration | Vercel Route Handler / Vercel Function reference |

## Source Risks To Preserve/Fix

- Current app has hard-coded Firebase and Google Maps keys in frontend. New project must not reuse them; Supabase/Vercel environment variables must be configured through `.env.local` and Vercel project settings.
- Current app is static HTML + large JS files. New project should split by bounded modules.
- Current data is Firebase RTDB shaped around stores. SaaS must redesign it as relational Supabase Postgres tables with tenant/account/workspace boundary before store data.
- Current UI text appears Thai but some files show mojibake when read in current shell. Preserve source encoding carefully; do not blindly rewrite Thai text from corrupted output.
- Existing printing and QR ordering are complex; migrate logic with adapter tests before redesigning UI.
- Listener cleanup (`managedOnValue`, `cleanupViewListeners`) is important. Do not recreate realtime subscriptions without cleanup.

## Target Product Definition

SaaS สำหรับจัดการร้านหลายสาขา/หลายธุรกิจ รองรับ:

- Organization / tenant / store management
- Role-based access: owner, admin, manager, cashier, staff
- Admin/owner permission management: ตั้งสิทธิ์พนักงานรายคน แยกตาม store และแยกเป็น module/action ได้
- Dashboard: sales, expense, profit, cashflow, stock alert, staff status
- POS: cart, product modifiers, payment methods, receipt, refund/delete, held tickets
- SaaS billing: subscription plans, trial/payment status, customer portal, invoice/payment lifecycle through Stripe
- Catalog: category, product, variant, modifier group, stock setting
- QR ordering: public table ordering, order status, buffet/table mode
- Cashflow/accounting: income, expense, cash ledger, category filter
- Attendance/payroll: clock in/out, location evidence, timesheet, payroll summary
- Reports: sales overview, payment method, top products, employee report, export-ready summaries
- Settings: store profile, users, receipt, printer, integrations, notification
- Notifications: admin/store events through serverless function or integration provider

## Permission Model

ระบบสิทธิ์ต้องมี 2 ชั้น:

1. Role default
   - `owner`: เข้าถึงทุก organization/store, billing, subscription, users, permissions, reports, destructive actions
   - `admin`: จัดการ store, users, permissions, catalog, reports, settings; ไม่แตะ billing เว้นแต่ owner เปิดสิทธิ์
   - `manager`: ดูรายงาน, จัดการ POS/catalog/attendance บางส่วน, อนุมัติ refund/delete bill ตาม permission
   - `cashier`: ใช้ POS, รับชำระเงิน, พิมพ์ใบเสร็จ, ดู order/table ที่ได้รับอนุญาต
   - `staff`: clock in/out, ดูงานที่เกี่ยวข้อง, ใช้ public/staff workflow ที่ได้รับอนุญาต

2. Per-user permission overrides
   - owner/admin สามารถเปิด/ปิด permission รายคนและราย store ได้
   - permission ต้องครอบคลุมอย่างน้อย:
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
   - RLS และ server-side authorization ต้องเช็คจาก membership/permission tables ไม่ใช่แค่ UI guard
   - ต้องป้องกัน privilege escalation:
     - เฉพาะ `owner` เท่านั้นที่ grant/revoke owner-level, billing/subscription, `permissions.manage`, และการเลื่อน role เป็น `owner`/`admin`
     - `admin` ห้ามแก้ `owner`, ห้ามแก้สิทธิ์ตัวเอง, ห้าม grant permission ที่ตัวเองไม่มี, และห้าม assign role สูงกว่าสิทธิ์ตัวเอง
     - `admin` จัดการได้เฉพาะพนักงานใน organization/store scope ที่ตัวเองมีสิทธิ์
   - ทุก action สำคัญ เช่น refund, delete bill, permission change ต้องมี audit log แบบ append-only
   - `audit_logs` ต้องห้าม update/delete จาก client และต้องเก็บอย่างน้อย `organization_id`, `store_id`, `actor_user_id`, `target_user_id`, `action`, `before`, `after`, `reason`, `request_id`, `ip`, `user_agent`, `created_at` ถ้ามีข้อมูล

## Recommended Target Architecture

ใช้ architecture ใหม่ แต่ย้าย domain rules จาก source:

```text
src/
  app/                 app router/pages/layout
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
    utils/
    validation/
    realtime/
  server/
    api/
    jobs/
    integrations/
  tests/
```

Recommended stack:

- Frontend: Next.js App Router/React + TypeScript
- UI: shadcn/ui or equivalent component system; UX/UI ใหม่ทั้งหมด
- State/data: TanStack Query/SWR + realtime adapter where needed
- Backend/runtime: Next.js Route Handlers, Server Actions where appropriate, and Vercel Functions
- Database: Supabase Postgres เป็น primary database
- Auth: Supabase Auth wrapped behind `authService`
- Realtime: Supabase Realtime for POS/table/order/status updates where needed
- Storage: Supabase Storage for product images, receipt assets, and optional staff evidence files
- Deployment: Vercel preview/production deployments
- SaaS Payments: Stripe Billing + Checkout Sessions + Customer Portal
- Tests: unit for domain logic, integration for service adapters, Playwright for POS/QR/admin flows

## Stripe Billing Requirements

- ใช้ Stripe เป็นระบบชำระเงินของ SaaS subscription เท่านั้น แยกจาก POS payment methods ของร้าน
- ใช้ Stripe Billing APIs + Checkout Sessions `mode: 'subscription'` สำหรับสมัครแพ็กเกจ
- ใช้ Stripe Prices ไม่ใช้ deprecated `plan` object
- ใช้ Stripe Customer Portal สำหรับ upgrade/downgrade/cancel/update payment method แบบ self-service
- Webhook ต้องอยู่ใน Vercel Route Handler / Vercel Function และ verify signature ด้วย `STRIPE_WEBHOOK_SECRET`
- ห้าม expose `STRIPE_SECRET_KEY` หรือ webhook secret ไป client หรือ `NEXT_PUBLIC_*`
- Supabase ต้องเก็บเฉพาะ billing state ที่จำเป็น เช่น `stripe_customer_id`, `stripe_subscription_id`, `price_id`, `subscription_status`, `current_period_end`
- Billing/subscription permission เป็น owner-level โดย default; admin แตะได้เฉพาะเมื่อ owner เปิดสิทธิ์ชัดเจน
- Subscription status ต้อง gate tenant features เช่น จำนวน store, user seats, QR ordering, reports, advanced permissions ตาม plan

## Supabase / Vercel Architecture Requirements

- ก่อน implement Supabase จริง ต้องตรวจ Supabase changelog/docs ปัจจุบัน โดยเฉพาะ Auth, RLS, Realtime, Storage, migrations และ SSR integration
- Supabase table ทุกตัวใน exposed schema ต้องเปิด RLS และมี policy ตาม tenant/store boundary
- ห้ามใช้ `user_metadata` เป็นข้อมูล authorization; ใช้ membership/app metadata หรือ table-based authorization
- ห้าม expose `service_role` key ใน client หรือ `NEXT_PUBLIC_*`
- Supabase client/server SDK ต้อง lazy initialize เพื่อให้ `next build` บน Vercel ไม่พังจาก env ที่ยังไม่พร้อม
- Supabase Auth ใน Next.js ต้องใช้ SSR/cookie-based session ผ่าน `@supabase/ssr`; ห้ามทำ protected app ด้วย localStorage-only session
- Authenticated routes ต้องป้องกัน cross-user cache โดยกำหนด dynamic/no-store strategy ตาม route ที่อ่าน session/user data
- Supabase Storage ต้องมี bucket policy และ path isolation ตาม organization/store; staff evidence เป็น private bucket เท่านั้น
- Vercel ใช้ Git integration/preview deployment เป็น default; production deploy ต้องมี approval และ env พร้อม
- Production deploy default คือ verify preview deployment แล้ว promote artifact นั้น; direct `vercel deploy --prod` ใช้เฉพาะกรณีมีเหตุผลและ approval ชัดเจน
- Vercel env แยก Development, Preview, Production และห้าม commit `.env`

## Agent Rules For This Project

- Conversation/report/docs: Thai
- Technical names/path/command: English as-is
- Start every implementation task by reading:
  - `PROJECT_CONTEXT.md`
  - `IMPLEMENTATION_PLAN.md`
  - Obsidian `Projects/Store management system saas/current.md`
- Use Graphify for project overview.
- Use SocratiCode/`rg` for symbol/call-flow impact.
- Do not copy `.env`, secret, token, API key.
- Do not use port `7842`; use `18889` only for Codex Dashboard if explicitly needed.
- After code/config changes: run verification, spawn `code_reviewer`, then document Obsidian.

## Initial Success Criteria

- Target project has clean app scaffold, no source secrets, no legacy UI copied as final UX.
- Core domain modules have typed models and tests before UI integration.
- MVP can run tenant/store login, POS order, receipt preview, QR order, dashboard summary, and settings flow.
- Each module can be assigned to an agent without needing to reread the whole source project.
