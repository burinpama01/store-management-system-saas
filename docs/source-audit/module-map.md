# Source → Target Module Map

Source: `C:\Users\burin\Accounting moojoom`
Target: `D:\Store management system saas`

| Legacy File | Target Module | Domain Rules to Preserve | UI to Discard | Tests Required |
|---|---|---|---|---|
| `js/pos-types.js` | `src/modules/catalog/types.ts`, `src/modules/pos/types.ts` | Product/variant/modifier shape, cart key logic | None (types only) | Unit: type shapes compile |
| `js/pos-mock-data.js` | `tests/` fixtures only | Sample data shapes | None | Fixture accuracy |
| `js/pos/cart-logic.js` | `src/modules/pos/cart.ts` | Add/update/remove/clear, price calc, modifier selection | Vanilla JS state | Unit: totals, modifier combos |
| `js/pos/order-service.js` | `src/modules/pos/order-service.ts` | Order draft→submit→payment→void lifecycle | jQuery/Firebase calls | Unit + integration |
| `js/pos/print-service.js` | `src/modules/printing/print-service.ts` | Adapter dispatch logic | Browser window calls | Unit: adapter selection |
| `js/pos/print-browser.js` | `src/modules/printing/adapters/browser.ts` | `window.print()` trigger + CSS | Raw HTML manipulation | Unit: output shape |
| `js/pos/print-usb.js` | `src/modules/printing/adapters/usb.ts` | WebUSB capability check + write | None | Unit: capability guard |
| `js/pos/print-bluetooth.js` | `src/modules/printing/adapters/bluetooth.ts` | Web Bluetooth check + write | None | Unit: capability guard |
| `js/pos/print-ip.js` | `src/modules/printing/adapters/ip.ts` | TCP/IP socket write via server action | None | Integration: mock socket |
| `js/pos/print-escpos.js` | `src/modules/printing/escpos.ts` | ESC/POS formatting, Thai text, QR/barcode | None | Snapshot: byte output |
| `js/pos/promptpay-qr.js` | `src/modules/printing/promptpay-qr.ts` | PromptPay QR payload encoding | None | Unit: payload format |
| `js/pos/bill-delete.js` | `src/modules/pos/order-service.ts` | Void reason + permission check | None | Unit: permission guard |
| `js/settings/pos-menu.controller.js` | `src/modules/catalog/` | CRUD for categories/products/modifiers | Legacy form HTML | Unit + integration |
| `js/auth.controller.js` | `src/modules/auth/` | Login, role, store selection flow | Static HTML login | E2E: login/logout |
| `js/utils/auth-storage.js` | Replaced by Supabase SSR cookies | Session persistence pattern | localStorage use | E2E: refresh keeps session |
| `js/utils/firebase-listener.js` | `src/shared/realtime/` | Cleanup/unsubscribe pattern (managedOnValue) | Firebase SDK | Integration: unmount unsubscribes |
| `js/utils/validation.js` | `src/shared/validation/` | Email, phone, price, date rules | Browser-coupled checks | Unit: all validators |
| `js/utils/error-handler.js` | `src/shared/utils/error.ts` | Error mapping, user message generation | Firebase error codes | Unit: error mapping |
| `js/config.js` | `.env.example` + Supabase config | Env var names | Hard-coded keys | Secret scan |
| `js/data-loader.js` | `src/server/integrations/supabase/` | Data access pattern | Firebase RTDB calls | Integration: adapter |
| `js/dashboard.controller.js` | `src/modules/dashboard/` | Summary widgets: income, expense, POS sales | Legacy chart libs | Integration: data shape |
| `js/entry.controller.js` | `src/modules/accounting/` | Income/expense CRUD, category filter | Legacy form | Unit: validation |
| `js/cashflow.controller.js` | `src/modules/cashflow/` | Cash ledger calc, balance snapshot | Legacy chart | Unit: ledger calc |
| `js/reports.controller.js` | `src/modules/reports/` | Sales/payment/employee report queries | Legacy table HTML | Unit: aggregation |
| `js/settings/settings.controller.js` | `src/modules/settings/` | Store profile, users, permissions | Legacy form | Integration: settings save |
| `js/receipt-settings.js` | `src/modules/settings/receipt-settings.ts` | Receipt display fields, paper width | Legacy form | Unit: field validation |
| `js/buffet-service.js` | `src/modules/buffet/` | Session create/add guests/close, package charge | Legacy HTML | Unit: charge calc |
| `js/attendance/attendance.service.js` | `src/modules/attendance/` | Clock in/out, geo evidence | None | Unit: timezone, clock |
| `js/attendance/attendance.controller.js` | `src/modules/attendance/` | UI orchestration | Legacy HTML | E2E: clock flow |
| `js/attendance/geo.utils.js` | `src/modules/attendance/geo.ts` | GPS coord validation, distance calc | None | Unit: coord validation |
| `js/attendance/qr-scanner.js` | `src/modules/attendance/qr-scanner.ts` | QR decode for clock-in | Legacy scanner UI | Integration: decode |
| `netlify/functions/notify.js` | `src/app/api/notify/route.ts` | Notification dispatch logic | Netlify function wrapper | Integration: mock webhook |
| `order.html` + `js/qr-order/qr-main.js` | `src/app/qr/[storeSlug]/[tableId]/` | Public catalog read, order submit flow | Static HTML/CSS | E2E: QR order submit |
| `public-tables.html` + `js/public-tables.js` | `src/app/qr/[storeSlug]/[tableId]/tables` | Table status monitor | Static HTML | E2E: table status update |
| `PRINTING_GUIDE.md` | `docs/source-audit/legacy-reference/` | ESC/POS notes, paper width rules | N/A | N/A |
| `PLAN_BUFFET_QR_ORDERING.md` | `docs/source-audit/legacy-reference/` | Buffet session design notes | N/A | N/A |
| `FIREBASE_DATA_AUDIT.md` | `docs/source-audit/legacy-reference/` | Data shape audit (cross-ref only) | N/A | N/A |
