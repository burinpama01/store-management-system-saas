# Migration Order

Matches the recommended implementation order from `IMPLEMENTATION_PLAN.md §5`.

| Phase | Package | Key Deliverables | Status |
|---|---|---|---|
| 1 | A - Bootstrap | Next.js scaffold, .gitignore, .env.example, dir structure | ✅ Done |
| 2 | B - Source Audit | module-map.md, secret-risk.md, migration-order.md | ✅ Done |
| 3 | C - Core Types | TypeScript types: org, store, catalog, POS, accounting, attendance, billing; validation; unit tests | ✅ Done |
| 4 | D - Supabase Schema | Migrations, RLS, clients, realtime | 🔄 90% — ขาด integration tests (RLS cross-tenant, unsubscribe pattern, storage policy) |
| — | D2 - Stripe Billing | Stripe Checkout, Webhook, subscription gating | ✅ Done locally — ยังต้อง verify Stripe env/webhook จริง |
| 5 | E - Auth/Tenant/Store | Supabase SSR auth, session resolver, login UI, store switcher | 🔄 95% — ขาด browser verified (ยังไม่มี test user ใน Supabase project) |
| 6 | F - Catalog | Category/product/variant/modifier CRUD, repository, UI | ✅ Done |
| 7 | G - POS Domain | Cart, order lifecycle, payment, POS UI | ✅ Done |
| 8 | H - Printing | PrintAdapter interface, browser preview, ESC/POS formatter | ✅ Done |
| 9 | I - QR Ordering | Public route, customer cart, table monitor | ✅ Done |
| 10 | K - Accounting/Cashflow | Transaction CRUD, cash ledger, POS integration | ✅ Done locally |
| 11 | M - Dashboard/Reports | Query contracts, widgets, date/store filters | ✅ Done locally |
| 12 | L - Attendance/Payroll | Clock actions, GPS evidence, payroll report | ✅ Done locally |
| 13 | J - Buffet | Feature flag, session lifecycle, billing | ✅ Done locally |
| 14 | N - Settings/Notify | Store profile, permissions UI, notify handler | ✅ Done locally |
| 15 | N2 - Vercel Deploy | vercel.json, env docs, preview/prod workflow | ✅ Docs ready — ยังไม่ได้ link/deploy Vercel |
| 16 | O - UX Polish | Design tokens, shell layout, shared components | ✅ Done — CDP visual QA ผ่านเฉพาะ unauth/design artifact |
| 17 | P - QA/Security | Full test suite, RLS verification, secret scan, E2E | 🔄 Local QA done — ยังขาด Supabase RLS/E2E/live browser user |

## Gap Detail — Packages A-E

### Package C (done)
- ✅ Organization, Store, Membership, Role, Permission, AuditLog, Subscription types
- ✅ 19 permission keys + role defaults (owner/admin/manager/cashier/staff)
- ✅ Catalog, POS, Accounting, Attendance types
- ✅ Validation (isValidEmail, isValidThaiPhone, isValidISODate, validateProduct, etc.)
- ✅ 48 unit tests pass
- ✅ Billing plan/status/features covered by Package D2 types and tests

### Package D (90%)
- ✅ 3 migrations applied to Supabase (schema, RLS, storage)
- ✅ Supabase browser/server/service/middleware clients
- ✅ Realtime subscription helper (cleanup pattern, DELETE payload support)
- ✅ Error mapping utility (shared/utils/error.ts)
- ✅ RLS helper functions (auth_user_organization_ids, auth_user_store_ids, auth_user_role_in_org, auth_user_role_in_store)
- ✅ `src/modules/catalog/repository.ts` — listCategories, createCategory, updateCategory, deleteCategory, listProducts, getProduct, createProduct, updateProduct, deleteProduct
- ✅ `src/modules/tenants/repository.ts` — getOrganization, listUserOrganizations, listUserMemberships, getMembershipPermissionOverrides, upsertPermissionOverride, appendAuditLog
- ✅ `src/modules/stores/repository.ts` — getStore, listActiveStores, updateStore, listStoreTables, getTableByNumber, updateTableStatus
- ✅ `src/shared/services/data-client.ts` — withDataClient() typed wrapper
- ✅ `supabase/seed.sql` — org, store, membership, tables, accounting categories, catalog (6 products, variants, modifiers)
- ❌ Integration tests (RLS cross-tenant denial, unsubscribe pattern, storage policy) — defer; need live Supabase project
- ❌ billing_customers, billing_events, plan_limits tables — defer to Package D2

### Package E (95%)
- ✅ Supabase SSR auth + cookie-based session + PKCE (handled by @supabase/ssr)
- ✅ Browser/server Supabase clients แยกกัน
- ✅ Middleware session refresh + route protection (middleware.ts — manifest verified populated)
- ✅ force-dynamic สำหรับทุก layout ที่อ่าน session
- ✅ Session state: getCurrentUser(), getUserStores(), resolveCurrentStore() (fail-closed)
- ✅ Permission resolver: resolvePermissions(), validatePermissionMutation() + 14 security tests
- ✅ setCurrentStore() server action (ตรวจ membership ก่อนตั้ง cookie)
- ✅ signOut() server action
- ✅ Login form UX (email/password, generic error, loading state)
- ✅ Store switcher UX (header dropdown, useTransition)
- ✅ Role guard utility (`requireRole(role)`) — src/modules/auth/guards.ts; redirects to /login if unauth, throws AuthorizationError if role insufficient
- ✅ Action guard utility (`requirePermission(key)`) — same file; loads overrides from DB, resolves full permission set, throws if key missing; 8 unit tests passing
- ❌ Browser verified (ยังไม่มี test user ใน Supabase project)

## 2026-05-31 Status Sync

- Packages D2, K, L, M, J, N, N2, O และ P มี implementation/docs/tests ใน repo แล้ว จึงปรับ table จาก `Pending` เป็นสถานะปัจจุบันตาม evidence ใน codebase และ Obsidian log/current.
- Verification ล่าสุดหลัง UI/UX review fixes:
  - `npm test -- tests/unit/ui-regressions.test.ts` ผ่าน 20/20
  - `npm run typecheck` ผ่าน
  - `npm run lint` ผ่าน
  - `npm test` ผ่าน 9 files / 145 tests
- Visual QA:
  - Browser plugin ยัง fail ด้วย `windows sandbox failed: spawn setup refresh`
  - ใช้ Edge CDP fallback แทน และได้ภาพ `login/reset/update/design-system` ที่ viewport 375px โดย `scrollWidth=375`
- Gaps ที่ยังไม่ปิด:
  - Supabase live test user/data สำหรับ authenticated dashboard/reports/settings browser QA
  - RLS/E2E integration tests บน Supabase project จริง
  - Stripe live webhook/env verification
  - Vercel link/deploy verification
