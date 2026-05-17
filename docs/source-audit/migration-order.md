# Migration Order

Matches the recommended implementation order from `IMPLEMENTATION_PLAN.md §5`.

| Phase | Package | Key Deliverables | Status |
|---|---|---|---|
| 1 | A - Bootstrap | Next.js scaffold, .gitignore, .env.example, dir structure | ✅ Done |
| 2 | B - Source Audit | module-map.md, secret-risk.md, migration-order.md | ✅ Done |
| 3 | C - Core Types | TypeScript types: org, store, catalog, POS, accounting, attendance; validation; unit tests | ✅ Done |
| 4 | D - Supabase Schema | Migrations, RLS, repository interfaces, realtime subscription | ✅ Done (migrations written; apply to Supabase project when created) |
| 5 | E - Auth/Tenant/Store | Supabase SSR auth, permission resolver, login UI, store switcher | 🔄 Partial (middleware + permission resolver done; auth UI pending Supabase project) |
| 6 | F - Catalog | Category/product/variant/modifier CRUD, repository, UI | ⬜ Pending |
| 7 | G - POS Domain | Cart, order lifecycle, payment, POS UI | ⬜ Pending |
| 8 | H - Printing | PrintAdapter interface, browser preview, ESC/POS formatter | ⬜ Pending |
| 9 | I - QR Ordering | Public route, customer cart, table monitor | ⬜ Pending |
| 10 | K - Accounting/Cashflow | Transaction CRUD, cash ledger, POS integration | ⬜ Pending |
| 11 | M - Dashboard/Reports | Query contracts, widgets, date/store filters | ⬜ Pending |
| 12 | L - Attendance/Payroll | Clock actions, GPS evidence, payroll report | ⬜ Pending |
| 13 | J - Buffet | Feature flag, session lifecycle, billing | ⬜ Pending |
| 14 | N - Settings/Notify | Store profile, permissions UI, notify handler | ⬜ Pending |
| 15 | N2 - Vercel Deploy | vercel.json, env docs, preview/prod workflow | ⬜ Pending |
| 16 | O - UX Polish | Design tokens, shell layout, shared components | ⬜ Pending |
| 17 | P - QA/Security | Full test suite, RLS verification, secret scan, E2E | ⬜ Pending |
