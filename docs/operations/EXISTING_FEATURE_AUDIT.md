# EXISTING_FEATURE_AUDIT — StoreOS Operations (ไม่รวม AI)

- วันที่ตรวจ: 2026-10-15
- ฐานโค้ดที่ตรวจ: `origin/main` @ `59083e3` (package `0.55.2`) — worktree `.worktrees/store-operations`
- อ้างอิง blueprint: `StoreOS_Operations_Blueprint.md` v1.0 (13 ต.ค. 2026), ร้านนำร่อง Each Other II
- วิธีตรวจ: อ่าน migration ใน `supabase/migrations/` (164 ไฟล์) และ module ใน `src/modules/` โดยตรง **ยังไม่ได้ query ฐาน production** — ข้อมูลจำนวนแถว/flag ของร้านอ้างจากบันทึก Obsidian `pilot-only-flags-2026-09-12.md`

สัญลักษณ์: ✅ มีแล้ว · 🟡 มีบางส่วน · ❌ ไม่มี · ⚠️ เสี่ยงชนของเดิม

---

## 1. สรุปภาพรวม

| โมดูลใน blueprint | สถานะ | สรุป |
|---|---|---|
| M1 เช็กลิสต์เปิด/ระหว่างวัน/ปิดร้าน + readiness | ❌ | ไม่มี table/route ใด ๆ; มีแค่ `stores.closing_time` ที่ใช้กับสรุปยอด |
| M2 วัตถุดิบ / lot / expiry / ของเสีย | 🟡 ⚠️ | มี `stock_pools` + `stock_movements` (ledger) แต่ **จำนวนเป็น integer**, ไม่มี lot/expiry/waste/storage zone |
| M3 ขอซื้อ + แหล่งเงินหลายแบบ | ❌ | ไม่มี purchase; มีรายรับ-รายจ่าย `transactions` + `cash_ledger_entries` ที่ใช้บันทึกค่าใช้จ่ายได้ปลายทาง |
| M4 งาน / corrective action | ❌ | ไม่มี task; `notifications` มีแค่สถานะ `new/acknowledged` |
| M5 Incident + SOP + safety gate | ❌ | ไม่มี; มี `products.out_of_stock` สำหรับปิดขายเมนูชั่วคราว (ใช้เป็นปลายทาง restriction ได้) |
| M6 Dashboard เจ้าของ + แจ้งเตือน + รายงานวัน | 🟡 | มี in-app notification center, push FCM, LINE/Telegram, daily summary + pg_cron; ยังไม่มี outbox แบบ dedupe/retry ทั่วไป |
| สิทธิ์/บทบาท | 🟡 | role 6 ระดับ + permission override; **ไม่มี KITCHEN_STAFF/BAR_STAFF** แต่มี `kitchen_station_staff` ผูกคนกับสถานี |
| Audit | ✅ | `audit_logs` (append-only) + `system_event_logs` |
| Feature flag ต่อร้าน | ✅ | pattern คอลัมน์ boolean บน `stores` (เช่น `unified_pos_enabled`) + `PlanFeatures` ตามแพ็กเกจ |
| ไฟล์หลักฐาน | 🟡 | bucket private `staff-evidence` มีอยู่แล้ว แต่ policy อ่านได้เฉพาะ owner/admin/manager |
| Scheduler | 🟡 | pg_cron + pg_net เปิดบน prod (2026-10-04); Vercel Hobby cron เต็ม (2 ตัว) |

---

## 2. รายละเอียดตามหัวข้อ

### 2.1 Multi-tenant / RLS / สิทธิ์
- ✅ ทุก table ธุรกิจมี `organization_id` + `store_id` (blueprint เรียก `tenant_id` = `organization_id` ของเรา) — `supabase/migrations/20260518000001_initial_schema.sql`
- ✅ RLS helper: `auth_user_role_in_store(org, store, min_role)` (`20260519000001_super_admin_role.sql:35`), `auth_user_has_permission(org, store, key)` (`20260623000001_cash_session_net_cash_and_pos_gate.sql:4`)
- ✅ Role: `super_admin | owner | admin | manager | cashier | staff` — `src/modules/tenants/types.ts:4`
- ✅ PermissionKey + `ROLE_DEFAULT_PERMISSIONS` + override ต่อ membership + กัน escalation — `src/modules/auth/permission-resolver.ts`
- 🟡 **ไม่มี role ครัว/บาร์** → แมป `KITCHEN_STAFF`/`BAR_STAFF` = role `staff` + ผูกสถานีผ่าน `kitchen_station_staff` (`20260624000001_qr_kitchen_staff_notifications.sql`) และใช้ `resolveKitchenStationScope()` ใน `src/modules/qr-ordering/kitchen-stations.ts` (กติกา: ผูกแล้ว = เห็นเฉพาะสถานีตัวเอง)
- ⚠️ `kitchen_stations` เป็นสถานีของ **การพิมพ์/คิวครัว** (ชื่ออิสระต่อร้าน) ไม่มี `code` KITCHEN/BAR — ถ้าใช้ร่วมต้องเพิ่ม `ops_code` แบบ nullable ไม่กระทบ routing เดิม
- ❌ PermissionKey สำหรับ ops (`ops.checklist`, `ops.incident.report`, `ops.verify`, `ops.purchase.request`, `ops.purchase.approve`, `ops.settle`) — ต้องเพิ่มทั้ง TypeScript และฝั่ง SQL `auth_user_has_permission`

### 2.2 Stock / วัตถุดิบ
- 🟡 สต๊อกระดับ variant: `product_variants.stock_quantity int` + `track_stock` ตัดใน RPC ขาย (`20260601000004_pos_payment_close_rpc.sql:96` และรุ่นต่อ ๆ มา)
- 🟡 Stock Pool: `stock_pools`, `variant_stock_links (consumption_quantity int)`, `stock_movements` (immutable delta, before/after, reference, actor) — `20260905000001_stock_pools.sql`; RPC ปรับยอด `20260905000002`, ใช้กับ unified POS `20260905000006`, จอง QR `20260918030000`
- ⚠️ **ข้อจำกัดสำคัญ:** `quantity integer`, `consumption_quantity integer` → วัตถุดิบหน่วย กก./ลิตร ทศนิยมไม่ได้ (ขัด blueprint ข้อ "decimal เลี่ยง float")
- ⚠️ movement_type มีแค่ `receive | set_balance | sale | cancel_restore | item_void_restore | migration` — ไม่มี `WASTE/TRANSFER/RETURN`
- ❌ lot/batch, expiry, opened_at, FEFO, storage zone, supplier, reorder_point แยกจาก low_stock_threshold
- ✅ แจ้ง low stock: `src/modules/stock/notify.ts`, `listLowStockAlerts()` ใน `src/modules/stock/repository.ts:65`, `stock_movement_notification_claims` (`20260905000005`)
- ✅ ปิดขายเมนู: `products.out_of_stock` (`20260709000000_notifications_service_buttons_stock.sql:146`)
- ℹ️ ข้อมูล prod 2026-09-12: `stock_pools` = 0 แถวทุกร้าน → ปรับ schema ได้โดยแทบไม่มีความเสี่ยงข้อมูลเดิม (ต้อง query ยืนยันใหม่ก่อน migration)
- **ข้อเสนอ:** ไม่สร้างสต๊อกซ้ำ — Phase 2 ขยาย `stock_pools` เป็น "วัตถุดิบ" (เพิ่ม `kind`, `storage_zone`, `track_lot/expiry`, `reorder_point`, เปลี่ยนเป็น `numeric(12,3)`) + เพิ่ม movement_type `waste/transfer/return/adjustment` + table `stock_lots`, `waste_records`

### 2.3 การเงิน / ค่าใช้จ่าย
- ✅ `accounting_categories` (income/expense/cash_adjustment), `transactions numeric(12,2)` — `initial_schema.sql:274`
- ✅ `cash_ledger_entries` + `cash_sessions` (กะเงินสด) — `20260607000001_cash_sessions.sql`, variance ledger `20260712000000`
- ✅ สิทธิ์บันทึก: `cashflow.record` RLS (`20260626150000_cashflow_record_rls.sql`)
- ❌ เงินทดรองพนักงาน / payable / settlement / โอนล่วงหน้าแล้วเคลียร์ยอด
- **ข้อเสนอ:** `SHOP_CASH` เขียน `cash_ledger_entries` type `expense` ผ่าน RPC เดิมเมื่อ settle (ไม่สร้างลิ้นชักใหม่); ค่าใช้จ่ายลง `transactions` ครั้งเดียวตอน settle เพื่อกันนับซ้ำ; ส่วน advance/reimburse เก็บใน `purchase_fund_movements` ใหม่

### 2.4 Notification / Scheduler
- ✅ in-app: `notifications` (`status new|acknowledged`, RLS อ่านได้ manager+) — `20260709000000`
- ✅ ช่องทาง: LINE (`line_notification_targets`), Telegram (`notification_targets`), push FCM (`src/modules/notifications/push.ts`), email Resend, SMSKUB — dispatcher `src/modules/notifications/dispatcher.ts:378`
- ✅ template: `notification_templates` (`20260707000000`)
- 🟡 dedupe มีเฉพาะกรณี (`daily_summary_notification_log`, `stock_movement_notification_claims`) — **ไม่มี outbox กลาง + delivery status ต่อผู้รับ**
- ⚠️ `notifications` RLS = manager+ → พนักงานครัว/บาร์ (role staff) มองไม่เห็น; งาน ops ต้องมีกล่องงานของตัวเอง ไม่ควรแก้ policy เดิม
- ✅ pg_cron/pg_net ใช้แล้วกับสรุปปิดร้าน (`20261004120000_store_closing_summary.sql:134`) → ใช้รูปแบบเดียวกันสำหรับ checklist overdue / incident no-ack
- ⚠️ Vercel cron เต็ม (`vercel.json` 2 ตัว, Hobby) และเคยโดนระงับจาก CPU/Invocations → **ห้ามเพิ่ม polling/cron ถี่บน Vercel**; ให้ pg_cron คำนวณใน DB และเรียก API เฉพาะเมื่อมีสิ่งต้องส่ง

### 2.5 Audit / Log
- ✅ `audit_logs` append-only (actor, before/after, reason, request_id) — `initial_schema.sql:95`
- ✅ `system_event_logs` + หน้า `/system/logs` — `20260903000003`; กฎถาวรโปรเจค: ฟีเจอร์ใหม่ต้อง log รวมเส้นทางสำเร็จ

### 2.6 Storage / หลักฐาน
- ✅ bucket private `staff-evidence`, `receipt-assets`; `product-images` public — `20260518000003_storage_buckets.sql`
- ✅ อัปโหลดฝั่ง server ผ่าน service client — `src/modules/storage/image-actions.ts`
- 🟡 policy `staff-evidence` อ่านได้เฉพาะ owner/admin/manager → ต้องเพิ่ม path prefix `ops/` ที่ผู้แนบเห็นไฟล์ตัวเองได้ และใช้ signed URL อายุสั้น

### 2.7 เวลา / ร้าน
- ✅ `stores.timezone`, `stores.closing_time` (`20261004120000`) และ helper `shared/utils/datetime.ts`
- ❌ เวลาเปิดร้าน / deadline เช็กลิสต์ต่อกะ — ต้องเพิ่ม (เช่น `ops_settings.open_checklist_due_time`)

### 2.8 Client / UX
- ✅ เว็บ Next.js 16 App Router (`src/app/(dashboard)`), แอป Android Capacitor (`mobile/`), แอป iOS React Native แยก branch `feat/pos-native-ipad`
- **ข้อเสนอ:** Phase 1 ทำเป็นหน้าเว็บ mobile-first `/ops` (ใช้ได้ทั้งเว็บและ Android shell ทันที) ยังไม่แตะ native RN

### 2.9 Test pipeline
- ✅ vitest (`npm test`), `npm run typecheck`, `npm run build`, Playwright e2e, `npm run risk:check`
- ⚠️ test บางส่วนเป็น source-assertion (grep ก่อนแก้ไฟล์ POS), full suite parallel เคย flaky (ใช้ `--maxWorkers=2`)
- ⚠️ ไม่มี staging DB — remote = prod; migration ต้องทดสอบบนฐาน local แยกก่อน

---

## 3. จุดเสี่ยงชนของเดิม (ต้องระวัง)

1. **RPC ขาย POS/QR** — ห้ามแก้ใน Phase 1; Phase 2 ถ้าเปลี่ยน `stock_pools` เป็น numeric ต้อง regression `verify:stock-pool` และ RPC ทุกตัวที่อ่าน `quantity`
2. **`notifications` RLS** — อย่าขยายให้ staff อ่าน (มีข้อมูลยอด/ออเดอร์); ทำ inbox ops แยก
3. **`kitchen_stations`** — ใช้สำหรับ routing การพิมพ์; ถ้าผูก ops ให้เพิ่มคอลัมน์ nullable เท่านั้น
4. **Vercel quota** — ห้าม polling ถี่จากหน้า `/ops`; ใช้ revalidate ตอน action + realtime เฉพาะที่จำเป็น
5. **`products.out_of_stock`** — safety gate ปิดเมนูต้องจำว่า "ใครปิดเพราะอะไร" ไม่ให้เปิดคืนทับการปิดด้วยมือของเจ้าของ

## 4. Assumption ที่ยังต้องให้เจ้าของตัดสิน
- เวลาเปิด/ปิดครัวและบาร์ของ Each Other II, deadline เช็กลิสต์แต่ละรอบ
- รายการ checklist จริง + ข้อไหนเป็น critical / ต้องวัดอุณหภูมิ / ต้องมีรูป
- เกณฑ์อุณหภูมิตู้เย็น/ช่องแช่แข็งที่ร้านใช้ (ระบบไม่ตั้งค่าความปลอดภัยอาหารเอง)
- SLA incident (ack ภายในกี่นาที) และเบอร์ฉุกเฉิน
- วงเงินที่พนักงานซื้อได้โดยไม่ต้องอนุมัติ (Phase 2)
- รายชื่อวัตถุดิบสำคัญ + จุดสั่งซื้อ (Phase 2)
