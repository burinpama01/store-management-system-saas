# จุดรับช่วง AI Assistant

## สถานะล่าสุด — PR3 (Durable idempotency) M1+M2+M3 เสร็จ 2026-09-16
- Branch: `feat/ai-assistant-durable-idempotency` (stacked ต่อจาก `feat/ai-assistant-text-pos`, base bbde87b) — commits: `0603c75` (M1 migration + durable store + unit tests) → `8938661` (M2 wiring + config env + tests) → M3 (integration test + หัวข้อนี้); **ยังไม่ push/merge/deploy ตามคำสั่ง — ผู้ประสานงาน verify แล้ว push เอง**
- **M1 — Migration + DurableIdempotencyStore**
  - Migration `supabase/migrations/20260916000000_ai_assistant_actions.sql` (additive เท่านั้น): ตาราง `ai_assistant_actions` — `UNIQUE (organization_id, idempotency_key)` ทำ atomic claim ข้าม process/instance (ตามแผน v2 หัวข้อ 13) + คอลัมน์ org/store/user/session ids, idempotency_key (pattern เดียวกับ envelope), tool, fingerprint (sha256 hex 64), status (pending/completed/failed), result jsonb, created_at, expires_at; FK organization/stores on delete cascade, **user_id ไม่ใส่ FK** เพราะเป็น ledger ปฏิบัติการที่ถูกกวาดตามอายุ และการลบ user ไม่ควรผูกกับ sweep; RLS เปิด + policy read org-scoped (store member) ตาม pattern ตารางอื่น **และ revoke all privileges จาก anon/authenticated** (เส้นทางจริงผ่าน service client เท่านั้น เหมือน print_hub_device_tokens); **trigger guard = append-only เท่าที่ทำได้**: อัปเดตได้เพียง pending → completed/failed ครั้งเดียว, ห้ามแก้ identity/fingerprint/tool/key, แถวที่จบแล้วห้ามแก้ (ลบเพื่อ retention ยังทำได้); index `expires_at` สำหรับการกวาด
  - `src/modules/ai-assistant/durable-idempotency.ts`: `DurableIdempotencyStore implements IdempotencyStore` (durability `"supabase"`) — **atomic claim = insert แถว pending ก่อนแตะ execute เสมอ** (สำเร็จ = ได้คีย์, ชน unique 23505 = มีคนกำลัง/เคยทำ — ไม่มีช่องว่าง check-then-insert); replay เฉพาะแถว completed/failed ที่ **fingerprint เดิม + identity เดิม (store/user/session)** — ต่างอย่างใดอย่างหนึ่ง = `IDEMPOTENCY_CONFLICT` (กันผลลัพธ์ไหลข้าม user/session ภายใน org เดียวกันด้วย); **pending ที่ยังไม่หมดอายุ → `IDEMPOTENCY_PENDING` (ErrorCode ใหม่ additive) fail-closed ไม่ execute ซ้ำแน่นอน**; pending หมดอายุ → reclaim ด้วย conditional delete (id + status=pending + expires_at<=now) แล้วจองใหม่ — ลบได้เฉพาะแถวที่ยืนยันหมดอายุ ณ ตอนลบ กันลบแถวใหม่ที่คนอื่นเพิ่งจอง; `sweepExpired()` กวาดแบบ batch (select id หมดอายุ → delete ซ้ำด้วยเงื่อนไข expires_at เดิม) + **opportunistic sweep ทุก 60 วิ/instance** (ล้มเหลวไม่กระทบ claim เพราะ atomicity มาจาก unique) — เรียกจาก cron ได้; **retention = expiresAt ของ session + retentionGraceMs (default 24 ชม.)**; ถ้าบันทึกผลหลัง execute ล้ม (DB สะดุด) = คืนผลจริงให้ผู้เรียกแต่แถวค้าง pending → replay โดน PENDING จนหมดอายุ (ไม่ลบแถวทิ้ง เพราะจะเปิดช่อง execute ซ้ำ)
  - Unit tests ด้วย **scripted fake supabase client** (ไม่แตะ DB): จำลอง unique constraint/filter eq-lte-in/maybeSingle/delete คืน id + inject error ราย operation — ครอบ atomic claim, replay ข้าม "restart" (instance ใหม่จาก DB เดิม), conflict, identity mismatch, pending fail-closed, expiry reclaim, ผล failed ถูก replay ไม่ execute ซ้ำ, update ล้ม = แถวค้าง pending, sweep เฉพาะแถวหมดอายุ (รวมข้าม org), infra outage → throw, ตรวจ identity/options
- **M2 — Wiring ที่ปลอดภัย (พฤติกรรมเดิม 100% เมื่อไม่ตั้งค่าใหม่)**
  - `foundation.ts`: `DispatcherOptions.idempotencyStore?` — ไม่ให้ = `MemoryIdempotencyStore` เดิมเสมอ; เกต production safe_write ผ่านได้ **เฉพาะ `store.durability !== "memory"`** ไม่งั้นยังติด `DURABLE_STORAGE_REQUIRED` เหมือนเดิม; dispatcher ส่ง `tool` + `identity` เพิ่มใน `IdempotencyClaimMeta` (additive — memory store ไม่สนใจ); `IdempotencyStore.durability` ขยาย type เป็น `"memory" | "supabase"`
  - `config.ts`: เพิ่ม env `AI_ASSISTANT_MUTATIONS_ENABLED` — เปิดเฉพาะค่า "true" ตรงตัว; **production จะเขียนได้จริงก็ต่อเมื่อ (1) durable store ถูก wire ที่ dispatcher (2) env เป็น true ทั้งสองชั้น** — env เดียวไม่พอ
  - `server.ts`: pass-through `idempotencyStore` — **route `text-command` ยังไม่ wire durable store = production วันนี้เหมือนเดิมทุกอย่าง (mutation ยังโดนปฏิเสธ)**; durable path พิสูจน์ผ่าน tests ทั้งหมดใน PR นี้
  - `text-assistant-ui.ts`: `describeDenialCode` เพิ่มข้อความไทยสำหรับ `IDEMPOTENCY_PENDING` (additive)
  - Tests: dispatcher wiring 3 cases (safe_write ผ่านเมื่อ durable + mutations on / ยังต้อง MUTATIONS_DISABLED เมื่อไม่เปิดและไม่แตะ DB / infra outage → CONTEXT_UNAVAILABLE) + `config.test.ts` เพิ่ม assertion env ใหม่ (ตามที่ตกลงไว้ — pinned tests อื่นทั้งหมดไม่ถูกแก้)
- **M3 — Integration-gated test:** `tests/integration/ai-assistant-durable-idempotency.test.ts` ตาม pattern `print-hub-queue-recovery.test.ts` (skip ถ้าไม่มี LOCAL_SUPABASE_*) — 5 cases กับ DB จริง: atomic claim ข้าม 2 connection (คีย์เดียว execute ครั้งเดียว อีกฝั่งได้ IDEMPOTENCY_PENDING), replay หลัง "restart" (store ใหม่จาก client/แถวเดิม), conflict, pending fail-closed แล้ว reclaim เมื่อหมดอายุ, sweep เฉพาะแถวหมดอายุ
- **Recovery story ของ pending ค้าง (handler ตายกลางทาง):** แถวค้าง pending จนกว่า `expires_at` (= หมดอายุ session + grace) เพราะ session ไม่ต่ออายุ ระหว่างนั้น replay ทุกเส้นทางได้ `IDEMPOTENCY_PENDING` — ไม่มีทาง execute ซ้ำโดยไม่ตั้งใจ; พ้นกำหนดแล้ว reclaim อัตโนมัติเมื่อมีการ claim คีย์เดิมใหม่ หรือถูก `sweepExpired` กวาด (แถว completed/failed ก็ถูกกวาดตาม retention เช่นกัน) — ไม่บังคับมี cron
- **ขั้นตอนปลด mutation จริงในอนาคต (ต้องทำครบตามลำดับ):** (1) deploy migration `20260916000000` ขึ้น production (2) แก้ composition root `src/app/api/ai-assistant/text-command/route.ts`: สร้าง `new DurableIdempotencyStore(await createSupabaseServiceClient(), { retentionGraceMs? })` แล้วส่งเป็น `idempotencyStore` ให้ `createServerAssistantDispatcher` (3) ตั้ง env `AI_ASSISTANT_MUTATIONS_ENABLED=true` (4) verify: safe_write ผ่านใน production, แถวลง `ai_assistant_actions`, replay ข้าม instance จริง, audit/rate-limit ยังทำงาน — เงื่อนไขร่วมอื่นของ PR3 Live ยังค้างตาม residual risks ด้านล่าง (device registry, e2e text path)
- **Verification (ตัวเลขจริง):** `npx vitest run tests/unit/ai-assistant --project unit` = **184/184 ผ่าน exit 0** (เดิม 170 + durable store 10 + dispatcher wiring 3 + config env 1); `npm run typecheck` exit 0; eslint ไฟล์ที่แตะ exit 0; build + full suite รอบสุดท้าย = ด้านล่าง (อัปเดตหลังรอบสุดท้าย)
- **Integration test ยังไม่ได้รันจริง — เหตุผล:** Docker daemon ไม่ทำงานในเครื่องนี้ (`npx supabase status` ล้มเหลว เหมือน PR2) และไม่มี env LOCAL_SUPABASE_* — test จะ skip ตาม design; **วิธีรัน:** เปิด Docker Desktop → `supabase start` → `supabase migration up --local` → ตั้ง `LOCAL_SUPABASE_URL` / `LOCAL_SUPABASE_PUBLISHABLE_KEY` / `LOCAL_SUPABASE_SERVICE_KEY` → `npx vitest run tests/integration/ai-assistant-durable-idempotency.test.ts --project integration` (ต้องมี seed ORG_A/STORE_A เดียวกับ print-hub test)
- ข้อจำกัดที่รักษาครบ: ไม่ run migration กับ Supabase จริง/production, ไม่แตะ .env, ไม่ deploy, additive เท่านั้น (ไม่แก้ migration/RLS/payment เดิม), pinned tests เดิมผ่านโดยไม่แก้, ไม่ commit `Plan/AI Assistant Implementation Progress v1.html`

## สถานะก่อนหน้า — PR2 (Text POS) สมบูรณ์: M1+M2+M3+M4 เสร็จ + review ผ่าน (แก้ findings ครบ) 2026-09-16
- Branch: `feat/ai-assistant-text-pos` — commits ตามลำดับ: `2bfc28d` (M1) → `cac591f` (M2) → `c9b21ce` (M3) → M4 fix commit (ด้านล่าง) — ยังไม่ push/merge/deploy
- **M4 เสร็จ — verify เต็ม + code review + แก้ findings + ปิดงาน**
  - Verification (ตัวเลขจริง): `npx vitest run tests/unit/ai-assistant tests/unit/ai-credit-topup.test.ts --project unit` = **178/178 ผ่าน exit 0**; suite เต็ม `npx vitest run --project unit --maxWorkers=4` = **2,497 tests: 2,494 ผ่าน / 3 ล้ม** — 2 ล้มเป็น baseline เดิมที่ผู้ใช้ยอมรับแล้ว (`no-native-dialogs.test.ts:34` PaymentIntegrationsManager, `pos-ticket-ui.test.ts:453` QR string) อีก 1 คือ regression ที่ PR2 สร้างเองและแก้แล้ว (ด้านล่าง); `npm run typecheck` exit 0; `npx eslint` ไฟล์ที่แตะทั้งหมด exit 0; `npm run build` ผ่าน exit 0
  - **Regression ที่ suite เต็มจับได้และแก้แล้ว:** `ai-credit-topup.test.ts` pin รายชื่อ quota feature ไว้ตายตัว — M2 เพิ่ม `aiAssistantText` ใน `quota.ts` แต่ไม่ได้แก้ pin → แก้ pin ให้รวม `aiAssistantText` (feature นี้เรียก reserveQuota จริงผ่าน route)
  - **code review (fallback spawned reviewer, review-only) 2 รอบ — รอบ 1: ไม่พบ Critical / Major 1 / Minor 4 / Suggestion 3; รอบ 2 (ตรวจเฉพาะ fix diff) จับช่องโหว่ที่เหลือของ Major แล้วแก้ปิดครบ ผลสุดท้ายไม่มี Critical/Major คงเหลือ:**
    - **Major (cart binding lifecycle) — แก้ครบ 2 รอบ:** (1) `foundation.ts` ย้ายเกต `DURABLE_STORAGE_REQUIRED`/`MUTATIONS_DISABLED` มาก่อนการเรียก `resolveCartBinding` — คำสั่งเขียนที่ถูกปฏิเสธไม่ผูก cartId เข้า session (+test ปักหมุด) (2) `TextAssistantOverlay` เก็บ binding ต่อแท็บใน sessionStorage (`ai-assistant:active-cart-binding` = JSON `{cartId, cartVersion}`, ตรวจรูปแบบก่อนใช้, try/catch โหมดส่วนตัว) — reload/กลับมาหน้าเดิมใช้ id **และ version เดิม** ไม่โดนปฏิเสธ 30 นาที (review รอบ 2 จับว่าแก้เฉพาะ id แต่ version รีเซ็ตเป็น 0 ทุก mount ก็ยังโดน `CONTEXT_UNAVAILABLE` เพราะ server ปฏิเสธ version ย้อนหลัง — จึงเพิ่มการจด version กลับ storage ทุกจังหวะ state เปลี่ยน + core รับ `initialCartVersion` validate ก่อนใช้ +tests simulate reload) (3) ข้อความ `CONTEXT_UNAVAILABLE` บอกความจริงเรื่องแท็บ/อุปกรณ์อื่น (4) pattern ของ cartId เป็น single source ที่ `ASSISTANT_CART_ID_PATTERN` ใน text-assistant-ui.ts
    - **Minor (คำ dialog เปลืองโควตา AI) — แก้แบบจำกัดขอบเขต:** `orchestrator.ts` ตอบ deterministic ทันทีเฉพาะ `navigate`/`pos.confirm_selection`; **ไม่**ดัก `pos.choose_option`/`pos.change_option` เพราะ parser อ่านคำสั่งสั่งของ "ขอชาเขียวมะนาวหนึ่งแก้ว" เป็น choose_option และต้องถึง AI เพื่อแปลงเป็น add_item (ตาม design เดิมของ M2) — มี test กัน regression จุดนี้แล้ว (รอบแรกลองดักทุก intent แล้ว suite ล้ม 5 ตัวจึงพบ)
    - **Minor (route 500 เมื่อ infra ล่ม) — แก้แล้ว:** `route.ts` ครอบ reserve/settle/log ด้วย try-catch + helper `safely()` — quota store ล่ม = 200 + failure `ai_error` ไม่ใช่ 500 (log warn เฉพาะ reason ทั้งเส้นทาง reserve-throw และ interpret-throw) (+test)
    - **Minor (pin ความยาวข้อความ) — แก้แล้ว:** test ใหม่ pin `TEXT_COMMAND_MAX_LENGTH === VOICE_INTENT_MAX_UTTERANCE`
    - **Minor (read-tool mode ไม่มี consumer) — รับไว้เป็นเอกสาร:** โหมด direct read-tool ยังไม่มีผู้เรียกจาก UI (ไว้ให้ PR3 ทำ "สรุปตะกร้าตอนเปิดแผง") — ทุกด่าน dispatcher ยังครอบและมี test ครบ
    - **Suggestion (format ยอดเงินใน announcement) — ไม่รับใน PR2:** ไม่มี shared formatter ให้ reuse (PosTerminal ประกาศ inline) และ announcement ถูก pin — ทำพร้อม consumer ของ get_current_order ใน PR3
    - **Suggestion (เอกสาร 2 แท็บ) + (cleanup undo token) — บันทึกใน residual risks ด้านล่าง / ไม่จำเป็นตามความเห็น reviewer เอง**
    - **Suggestion (test ระดับ overlay ของ sessionStorage) — ไม่ทำใน PR2:** unit project รัน environment node ไม่มี jsdom/React test infra — ไปทำรวมกับ e2e ของ text path ใน PR3 (พฤติกรรม pattern-guard ถูกคุมผ่าน test ฝั่ง core แล้ว)
  - **e2e ไม่ได้รัน — เหตุผล:** Playwright config fail-closed ที่ local Supabase ผ่าน Docker ซึ่ง Docker daemon ไม่ทำงานในเครื่องนี้ (`npx supabase status` ล้มเหลว) และ repo ยังไม่มี spec e2e ของ text path (มีแค่ unified-pos/voice-ai-pos/infrastructure-smoke) **วิธีรัน:** เปิด Docker Desktop → `supabase start` → `npx playwright test` (webServer ประกอบ `next start` เองที่ port 3100) — PR3 ต้องเพิ่ม spec ของ text command + overlay ก่อนเปิด mutation
  - **Residual risks สำหรับ PR3 (Live):**
    1. บัญชีเดียวเปิดผู้ช่วย 2 แท็บ/2 เครื่องพร้อมกัน = แท็บที่สองโดน `CONTEXT_UNAVAILABLE` จนครบ TTL 30 นาที (session ผูกต่อ identity, ยังไม่มี device registry — ข้อความ UI บอกเหตุผลแล้ว) ต้องแก้ด้วย device/terminal registry ก่อนเปิด mutation
    2. In-memory ทั้งสามชั้น (session 500, idempotency ledger, rate limit 20/นาที) ต่อ process — PR3 ต้องมี durable idempotency ก่อนปลด `mutationsEnabled`
    3. ไม่มี e2e ของ text path + ไม่มี React test ของ overlay — pure modules ครอบครัว 177 tests แต่ integration บนหน้าจอจริงยังไม่มีหลักฐาน
    4. Voice POS latent bug (remove_item → needs_quantity) ยังค้างตามเดิม — แก้ต้นน้ำใน PR ของทีมเสียง
    5. Announcement ของ `pos.get_current_order` แสดงตัวเลขดิบ (ยังไม่ format คั่นพัน) — จัดการพร้อม consumer ใน PR3

## สถานะก่อนหน้า — PR2 (Text POS): M1+M2+M3 เสร็จ 2026-09-16 (ค้าง M4 = verify เต็ม + review)
- Branch: `feat/ai-assistant-text-pos` (stacked ต่อจาก `feat/ai-assistant-tool-foundation`) ใน worktree เดิม
- **M3 เสร็จ — commit `feat(ai-assistant): add text assistant overlay on unified POS` (ด้านล่าง)**
  - `src/modules/ai-assistant/ui/text-assistant-ui.ts` (pure): parse ผล tool จาก route → fail closed เมื่อรูปทรงไม่รู้จัก; ข้อความ denial (`describeDenialCode` — MUTATIONS_DISABLED/DURABLE_STORAGE_REQUIRED บอกตรงว่า "การแก้ตะกร้าผ่านผู้ช่วยยังปิดในรอบนี้") + failure reason ระดับ route (`describeFailureReason` — note ของ server ชนะเสมอ); `planAssistantTurn` แปลง outcomes → ขั้นตอน (apply/message/clear_search/open_product) ตามลำดับเดิม; `createAssistantCartId`/`createAssistantRequestId` ตรง schema ของ route; `cartFingerprint` สำหรับกัน undo ทับ
  - `src/modules/ai-assistant/ui/text-assistant-core.ts` (pure controller, ไม่มี React): ส่งคำสั่ง → เดินแผนผ่าน bridge mock ได้; apply = คำสั่งที่ server อนุมัติเท่านั้น ผลักเข้าตะกร้าผ่าน `applyVoiceCartIntent` ตัวจริง (ต่อยอด workingCart ระหว่างคำสั่งในข้อความเดียว); **undo 6 วิ ใช้ token เดิมของเสียง แต่ครอบทั้งคำสั่ง (1 รอบพิมพ์ = 1 token) และตรวจ fingerprint ตะกร้าก่อนย้อน — ตะกร้าถูกแก้ด้วยมือ/คำสั่งใหม่แทรก = ปฏิเสธ ไม่ commit ทับ**; bridge null = fail closed เป็นข้อความ; cartVersion ไต่ขึ้นอย่างเดียว (apply/undo ครั้งละ 1)
  - `src/app/pos/unified/TextAssistantOverlay.tsx` (ใหม่, JSX): ปุ่ม 🤖 แยกจากปุ่มเสียง (ไม่มีไมค์) บนแถบหัวของ Unified POS; แผง = bottom sheet บนมือถือ / popover ใต้ปุ่มบนเดสก์ท็อป; แสดง log ผล (ไม่ echo ข้อความผู้ใช้), candidate chips (ส่งชื่อเป็นคำสั่งถัดไปตาม pipeline เดิม), ปุ่ม undo พร้อมนับถอยหลัง; สร้าง core ใน effect ครั้งเดียวต่อ mount (กฎ react-hooks/refs ของ repo ห้ามส่ง closure อ่าน ref เข้า factory ตอน render); fail closed แสดง "หน้าขายยังไม่พร้อม" เมื่อ bridge null
  - จุดเชื่อม: `UnifiedPosWorkspace.tsx` mount overlay บนแถบหัวหลัง VoicePosController (prop `aiAssistantTextEnabled`, default false); `types.ts` เพิ่ม prop; `page.tsx` ส่ง `readAssistantConfig(process.env).enabled` (kill switch ปิด = ไม่มีปุ่มเลย) — สิทธิ์/แพ็กเกจ/rate limit ตรวจซ้ำที่ route ทุกครั้ง
  - Tests: `tests/unit/ai-assistant/text-assistant-ui.test.ts` (20) + `text-assistant-core.test.ts` (19) — bridge mock + resolver จริงกับ fixture สินค้า (pattern เดียวกับ pos-tools test): fail closed bridge null, undo restore/reject เมื่อแก้ด้วยมือ/expired, follow-up (requestId ใหม่ + cartVersion ไต่ขึ้น), multi-command undo ครอบทั้งคำสั่ง, locked cart, needs_option → openProduct, clear_search, denial messages
- Verification สะสม หลัง M3: `npx vitest run tests/unit/ai-assistant --project unit` = **163/163 ผ่าน exit 0** (config 3, foundation 44, server 10, binding 6, session 15, pos-tools 18, orchestrator 17, rate-limit 4, route 7, text-assistant-ui 20, text-assistant-core 19); `npm run typecheck` exit 0; `npx eslint` 8 ไฟล์ที่แตะ exit 0
- จุดรับช่วงต่อไป: M4 = verify เต็ม (build, e2e ถ้า env พร้อม) + code review diff ทั้ง PR2 + แก้ Critical/Major + checkpoint สรุป PR2/residual risks สำหรับ PR3

## สถานะก่อนหน้า — PR2 (Text POS) ระหว่างทำ: M1+M2 เสร็จ 2026-09-16
- Branch: `feat/ai-assistant-text-pos` (stacked ต่อจาก `feat/ai-assistant-tool-foundation`) ใน worktree เดิม — งาน PR2 ทำเป็น milestone พร้อม commit ทีละส่วน
- **M1 เสร็จ — commit `2bfc28d` `feat(ai-assistant): add server-validated cart binding and POS tools on shared resolver`**
  - `foundation.ts`: เพิ่ม `CartBinding` + option `resolveCartBinding` ให้ dispatcher — tool ที่ `requiresActiveCart` จะได้ binding ที่ server ตรวจแล้วเท่านั้น (args parse ก่อนแล้วส่งให้ resolver); ไม่มี resolver/ตรวจไม่ผ่าน/throw = `CONTEXT_UNAVAILABLE` ก่อน execute เสมอ; execute รับ param ที่ 3 เป็น binding (null สำหรับ tool ที่ไม่ต้องผูกตะกร้า) — pinned tests ของ PR1 ทั้งหมดไม่ถูกแก้และผ่าน
  - `session.ts` (ใหม่): session store ในหน่วยความจำ keyed ด้วย org|store|user — session id คงเส้นตาย (TTL คงที่ 30 นาที ไม่ต่ออายุด้วย id เดิม ตาม contract ที่ค้างจาก PR1), ผูกตะกร้าได้ 1 ใบต่อ session (สลับใบ = ปฏิเสธ), cart version ห้ามย้อนหลัง, identity mismatch ปฏิเสธ, เต็ม `maxSessions` (500) แล้ว fail closed (evict เฉพาะ session หมดอายุ)
  - `tools/pos-tools.ts` (ใหม่): MVP tools 6 ตัว (`pos.search_product`, `catalog.search`, `pos.get_current_order`, `pos.add_item`, `pos.remove_item`, `pos.change_quantity`) — จับคู่สินค้าผ่าน `resolveVoiceProductPhrase`/`resolveAiVoiceCommand` ของ Voice POS เป็นทางเดียว (ADR-009); ผลลัพธ์ = "คำสั่งที่อนุมัติให้ client ผลักเข้าตะกร้าผ่าน applyVoiceCartIntent เดิม" หรือ clarification (ambiguous/needs_option/needs_quantity/not_found/unavailable) พร้อม candidates จาก resolver; ไม่มี id จากโมเดล (args schema ไม่รับ productId)
  - **เจอ latent bug ของ Voice POS (ไม่แก้ — additive only):** `resolveAiVoiceCommand` ปัด `pos.remove_item` เป็น `needs_quantity` เสมอ เพราะ `normalizeAiCommandQuantity` คืน null สำหรับ remove — tool remove_item ของ PR2 จึงเรียก `resolveVoiceProductPhrase` (resolver ชั้นล่างเดียวกัน) ตรง พร้อมจำลองเกตเดิมของ resolver; ทีมเสียงควรแก้ต้นน้ำภายหลัง
  - `tools/pos-tools-server.ts` (ใหม่): composition root โหลด catalog จาก repository เดิม (`listProducts` + `listVoiceAliases` — ชุดเดียวกับหน้าขาย)
- **M2 เสร็จ — commit `feat(ai-assistant): add text command orchestrator, rate limiting, and API route` (ด้านล่าง)**
  - `text-intent.ts` (ใหม่): text→intent adapter reuse `interpretVoiceIntent` ทั้งก้อน (payload allowlist ไม่ส่งบริบทร้าน/ตะกร้า, store:false, timeout, parse fail-closed ด้วย schema เดิม)
  - `orchestrator.ts` (ใหม่, pure): `createTextInterpreter` — deterministic parser ของเสียงมาก่อน (ไม่เสียโควตา), AI เฉพาะ no_match และผ่าน `validateAiProposalAgainstAllowlist` (denylist เดิม) ก่อนใช้; `runTextCommand` — เดินคำสั่งตามลำดับ → dispatch ผ่าน dispatcher ของ PR1 ด้วย idempotencyKey `${requestId}-${index}`; `pos.clear_search` = client_action, navigate = skipped, add/set ที่ไม่ระบุจำนวน = clarification needs_quantity (inc/dec null = 1 ตาม contract เดิม)
  - `rate-limit.ts` (ใหม่): fixed window ต่อ process (default 20 คำสั่ง/นาที ปรับด้วย `AI_ASSISTANT_TEXT_RATE_LIMIT_PER_MINUTE`) — **rate limit ที่ route layer ตาม residual risk ของ PR1**; กวาดหน้าต่างหมดอายุก่อน evict เก่าสุด คุมหน่วยความจำด้วย maxKeys
  - `src/app/api/ai-assistant/text-command/route.ts` (ใหม่): auth (`getResolvedCurrentPermissions`) → `pos.use` → entitlement `canUseFeature(...aiAssistant)` → rate limit → kill switch → body (2 โหมด: ข้อความ หรือ direct read-tool 3 ตัวที่ allowlist ไว้เท่านั้น — ห้าม generic execute) → dispatcher เดิมทุกด่าน; ความล้มเหลวระดับเนื้อหา (คำต้องห้าม/AI ล่ม/โควตาหมด) = HTTP 200 พร้อม failure reason + คำแนะนำ, non-200 เฉพาะ 401/403/429/400/503; **ข้อความของผู้ใช้ไม่ถูก echo/log ทุกจุด**; dispatcher + session store + rate limiter เป็น module-level singleton เพื่อให้ replay ข้าม request ยัง dedupe ได้
  - `quota.ts`: เพิ่ม label `aiAssistantText` (additive)
  - สถานะ mutation ยังปิดตามคำสั่ง: `config.ts` `mutationsEnabled: false` ไม่ถูกแตะ — ผ่าน route จริง `pos.add_item` จะตอบ `MUTATIONS_DISABLED` (dev) / `DURABLE_STORAGE_REQUIRED` (production); การเดิน mutation พิสูจน์ผ่าน tests เท่านั้น (dispatcher test env)
- Verification สะสม (ตัวเลขจริง): `npx vitest run tests/unit/ai-assistant --project unit` = **124/124 ผ่าน exit 0** (config 3, foundation 44, server 10, binding 6, session 15, pos-tools 18, orchestrator 17, rate-limit 4, route 7); `npm run typecheck` exit 0; `npx eslint` เฉพาะไฟล์ที่แตะ exit 0
- จุดรับช่วงต่อไป: M3 = UI overlay บน POS (ปุ่ม/ช่องแยกจาก Voice POS ตาม ADR-008, apply ผ่าน voice-cart-bridge เดิม, undo 6 วิ + กัน undo ทับการแก้ด้วยมือ, follow-up ใช้ pending candidates) → M4 = verify เต็ม + review + checkpoint สรุป

## สถานะล่าสุด — แก้ Major ledger capacity เสร็จ (per-scope + expired eviction + global backstop) + commit ในเครื่อง — 2026-09-16 (รอบ 3)
- แก้ Major finding จาก review รอบก่อน (user ที่ผ่าน auth เติม idempotencyKey จน `CAPACITY_EXCEEDED` ทั้ง process): `MemoryIdempotencyStore` เปลี่ยนเป็น ledger แยกตาม scope `Map<scope, Map<key, entry>>` — scope = `JSON.stringify([organizationId, storeId, userId, sessionId])`, entry เก็บ `fingerprint + result + expiresAt`
- `claim(key, fingerprint, meta: IdempotencyClaimMeta { scope, expiresAt }, execute)` — `createDispatcher` ส่ง scope + `ctx.expiresAt` เข้า store เอง จึง **ไม่ต้องแก้ server.ts**; session หมดอายุถูกปัด `CONTEXT_UNAVAILABLE` ก่อนเข้า store เหมือนเดิม
- ตัวเลข capacity: `scopeCapacity` default **128 ต่อ session** (เพิ่ม option `scopeCapacity` ใน DispatcherOptions), global backstop default **1000** (คงความหมายเดิมของ `capacity`) — session เดียวเต็มโควตาตัวเองแล้ว fail-closed `CAPACITY_EXCEEDED` เฉพาะ session นั้น ไม่กระทบ session อื่น
- จุด evict: ตัดสินความจุทั้ง 2 ระดับต้อง evict entry ที่ `expiresAt <= now` ก่อนเสมอ (evictExpired ระดับ scope / evictExpiredAll ระดับ global พร้อมลบ ledger ว่าง); replay ที่ผ่าน gate จะต่ออายุ entry (delete+set ด้วย expiresAt ใหม่) กันโดน evict ก่อนเวลา; atomic claim คงเดิม (ไม่มี await ระหว่าง check กับ insert)
- Replay/conflict semantics เดิมครบ: same key+same fingerprint → cached structuredClone, ต่าง fingerprint → `IDEMPOTENCY_CONFLICT`, concurrent dedupe execute ครั้งเดียว — pinned tests เดิมทั้งหมดไม่ถูกแก้และผ่าน
- ผล verify (ตัวเลขจริง หลัง fix findings): targeted `npx vitest run tests/unit/ai-assistant --project unit` = **57/57 ผ่าน exit 0** (config 3, foundation 44 = 35 เดิม + 9 ใหม่, server 10); `npm run typecheck` exit 0; `npx eslint` เฉพาะ foundation.ts + foundation.test.ts exit 0
- code_reviewer (fallback spawned reviewer) ตรวจ diff: **ไม่พบ Critical/Major**; รับแก้ Minor "refresh expiry on replay" (session ถูกต่ออายุแล้ว entry เก่าต้องไม่โดน evict ก่อนเวลา) + Minor "test timing margin" (+200ms/300ms) + Suggestion เพิ่ม test backstop bind ก่อน scopeCapacity — แก้ครบแล้ว; ไม่รับ Suggestion totalSize counter (O(#scopes) ยังไม่ใช่ hot path)
- Residual risk ก่อนเปิด endpoint (PR2 ต้องคุม): (1) attacker สร้าง assistant session ใหม่ได้เรื่อย ๆ = scope ใหม่ที่แชร์ global backstop — ต้อง rate limit ที่ route layer ตามข้อ 3 เดิม (2) ไม่มี proactive/background sweep — entry หมดอายุถูก reclaim เมื่อมี pressure เท่านั้น (bounded โดย capacity แล้ว) (3) หน้าต่าง evict ระหว่าง session ถูกต่ออายุโดยไม่มี replay เลยระหว่างนั้น — contract ของ `resolveSession` ควรเลี่ยง extend expiry ด้วย session id เดิมถ้าไม่ยอมรับ re-execute
- Commit `fix(ai-assistant): bound per-scope idempotency ledger with expired-session eviction` บน branch นี้แล้ว (ไม่ push/merge/deploy)

## สถานะก่อนหน้า — PR1 implementation เสร็จ + รีวิวผ่าน + commit ในเครื่องแล้ว — 2026-09-16 (รอบ 2)
- `src/modules/ai-assistant/server.ts` เสร็จแล้ว: `createServerAssistantDispatcher({ registry, resolveSession })` + `writeAssistantAudit` — derive identity จาก `getResolvedCurrentPermissions` + billing จาก `getOrganizationBillingState`, ปฏิเสธ browser runtime ก่อนแตะ auth, ตรวจ session mismatch ทุก field, re-read kill switch + re-check permission ทุก dispatch รวม replay, audit allowlist `{ tool, risk, outcome }` ผ่าน `logSystemEvent` เท่านั้น
- แก้ `foundation.ts` ตามที่ test spec บังคับ: เพิ่ม `MUTATIONS_DISABLED` + `mutationsEnabled` switch (ปิด default, re-check ทุกครั้ง), `canonical()` ปฏิเสธ non-JSON (NaN/Infinity/Date/Map/undefined)
- แก้ `config.ts`: เพิ่ม `mutationsEnabled: false` ล็อกถาวรใน PR1 ไม่มี env ปลดล็อก
- ผล verify (ตัวเลขจริง): targeted tests `npx vitest run tests/unit/ai-assistant --project unit` = 48/48 ผ่าน exit 0 (config 3, foundation 35, server 10); `npm run typecheck` exit 0; `npm run lint` exit 1 แต่ error ทั้ง 2 เป็น pre-existing ใน `src/app/pos/PosTerminal.tsx:2217,2243` (ไฟล์ไม่ได้แตะ) — eslint เฉพาะ ai-assistant files ผ่าน exit 0; full unit suite = 2380 ผ่าน / 2 ล้ม (2 ที่ล้มคือ baseline เดิม no-native-dialogs + pos-ticket-ui ที่ผู้ใช้ยอมรับแล้ว)
- code_reviewer (fallback spawned Explore agent) ตรวจแล้ว: ไม่พบ Critical, ผ่าน audit gate ทั้ง 5 ข้อ, reuse foundation ถูกต้อง; แก้ finding Minor เรื่อง wire `mutationsEnabled` จาก config ลง server adapter แล้ว
- AutoCoder รีวิวอิสระแล้ว (อ่านโค้ดทั้งหมด + รัน targeted tests 48/48 และ typecheck exit 0 ซ้ำเอง) และ commit ในเครื่องบน branch นี้; ยังไม่ push/merge/deploy — รอผู้ใช้ตัดสินใจ

## สิ่งที่เบี่ยงเบน / การตัดสินใจรอ PR2 (จาก review)
1. **Major รอตัดสินใจก่อน PR2 — แก้เรียบร้อยแล้ว (รอบ 3, commit ใหม่ด้านบน):** `MemoryIdempotencyStore` ไม่มี eviction — ทางแก้ที่ใช้คือ capacity ต่อ scope + evict entry ของ session หมดอายุ + global backstop (ไม่ใช่แนวข้าม claim เมื่อ risk=read เพราะทลาย replay semantics); ห้ามเปิด endpoint จนกว่าจะมี route-layer rate limit ตามข้อ 3
2. **Test gap รอ PR2:** ยังไม่มี test พิสูจน์ server adapter derive environment จาก NODE_ENV (stub NODE_ENV=production + safe_write → DURABLE_STORAGE_REQUIRED); ยังไม่มี audit assertion ฝั่ง failure outcome; การเพิ่ม test ไม่ได้รับอนุญาตใน scope รอบนี้จึงบันทึกไว้
3. Denial paths ก่อนรู้ context (INVALID_REQUEST/FEATURE_DISABLED/UNKNOWN_TOOL) ไม่ถูก audit — ให้ PR2 คุมที่ route layer (rate limit/monitoring)
4. ควรพิจารณา `import "server-only"` ใน server.ts เป็น build-time guard เสริม (ตอนนี้มี runtime check `typeof window`)

## หยุดและส่งต่อ — 2026-09-16 (รอบ 1, ประวัติ)
- ผู้ใช้สั่งปิดงานเพราะโควต้าหมด; หยุด implementation แล้ว
- backend_dev จบด้วย usage limit; ไม่มีผลส่งมอบสุดท้าย
- ไฟล์ใหม่ที่ตรวจพบจริง: `src/modules/ai-assistant/{config.ts,foundation.ts}` และ `tests/unit/ai-assistant/{config.test.ts,foundation.test.ts,server.test.ts}`
- ยังไม่มี `server.ts` หรือ audit adapter: เริ่มรับช่วงโดยอ่าน `server.test.ts` และทำ implementation ให้ครบก่อนทดสอบ
- ผล 32 tests ผ่านเป็น milestone ก่อน patch สุดท้ายจาก implementer ไม่ใช่ผลยืนยันไฟล์ปัจจุบัน; ต้องรันใหม่
- ทุกไฟล์งานนี้ยัง untracked/uncommitted; ไม่มี build, push, merge หรือ deploy
- Reviewer ตรวจเฉพาะ Phase 0 audit แล้ว ยังไม่ได้ตรวจ implementation PR1
- รอบปิดงานอ่าน status และบันทึกเท่านั้น ไม่แก้โค้ดหรือรัน tests เพิ่ม
- คำสั่งเริ่มรับช่วง: เข้า worktree ด้านล่าง อ่านไฟล์นี้กับแผน v2 ตรวจ diff/untracked แล้วทำ PR1 ต่อ; อย่าเริ่ม PR2/Live จน PR1 ผ่าน review

## คำสั่งล่าสุด
- ผู้ใช้อนุญาตทำต่อโดยแยก baseline เดิมที่ล้ม 2 tests
- ไม่ต้องหยุดรอตัวอ่านโควต้า: บันทึกหลังแก้แต่ละส่วนเพื่อให้ agent อื่นรับช่วงได้ และทำต่อจนเสร็จหรือติด limit
- ยังไม่มีอนุญาต deploy production หรือ migration production

## พื้นที่ทำงาน
- Worktree: `D:\Store management system saas\.worktrees\ai-assistant-implementation`
- Branch: `feat/ai-assistant-tool-foundation`; base `00e1374`
- งานเดิมของผู้ใช้อยู่ root checkout ห้ามแตะหรือรวมไฟล์นอก scope

## สถานะ PR1
- มี `src/modules/ai-assistant/foundation.ts` และ `tests/unit/ai-assistant/foundation.test.ts` แบบยังไม่เสร็จ
- ประวัติแรก targeted 13/14; fixture unknown tool และ pos.use แก้แล้วก่อน milestone 32 tests
- กำลังเพิ่ม trusted server adapter/config/audit wrapper และ tests โดย backend_dev
- Milestone core/config: backend_dev รายงาน targeted 32 tests ผ่าน exit 0 หลังแก้ fixture, เพิ่ม atomic `IdempotencyStore`/`MemoryIdempotencyStore`, scoped isolation และ replay copy; main ยังไม่ตรวจชุดสุดท้ายซ้ำ
- แก้ null context ให้อยู่ใน try แล้ว; กำลังทำ server adapter/audit และปฏิเสธ non-JSON canonical input
- ห้ามเปิด API/UI หรือ production mutation ก่อนผ่าน review; memory ledger ไม่ใช่ durable idempotency
- ยังไม่ได้ typecheck/lint/final review/build/commit/push

## หลักฐาน baseline
- `npm ci --ignore-scripts --no-audit --no-fund` ผ่าน
- `npm test -- --project unit --maxWorkers=4`: 2332 ผ่าน / 2 ล้ม, 210 files ผ่าน / 2 ล้ม
- `tests/unit/no-native-dialogs.test.ts:34`: native dialog ใน PaymentIntegrationsManager.tsx
- `tests/unit/pos-ticket-ui.test.ts:453`: assertion QR verification string ไม่ตรงซอร์สเดิม
- ผู้ใช้ยอมรับให้แยก failure เดิมแล้วทำ PR1 ต่อ ไม่ต้องซ่อม payment นอก scope

## เกต audit ที่ต้องรักษา
1. Audit metadata allowlist เท่านั้น ห้าม raw args/result/error/free text
2. Production mutation ปิดจนมี durable idempotency; atomic dedupe ในหน่วยความจำใช้ dev/test
3. Active cart server binding ยังไม่มี; tool ที่ต้อง binding ปฏิเสธ จนมี trusted resolver

## ขั้นถัดไป
1. ทำ PR1 targeted tests ให้ผ่านพร้อม server adapter tests และ typecheck/lint
2. ให้ code_reviewer ตรวจ diff ใหม่ แก้ findings และตรวจซ้ำ
3. บันทึกผลทุก milestone ในไฟล์นี้และ Obsidian
4. PR2 ต้อง reuse Voice POS resolver/cart/queue/undo และพิสูจน์ server/cart binding ก่อน mutation
5. PR3 เริ่มได้หลัง PR2 e2e ผ่าน ต้องตรวจ API ปัจจุบันและ credentials/caps/coexistence

## เอกสาร
- จุดเชื่อม PR2 ที่ตรวจแล้ว: `docs/ai-assistant/PR2_REUSE_NOTES.md`; ยังไม่เปิด mutation
- แผนหลัก: `Plan/StoreOS AI Assistant OpenAI Live Implementation Plan v2.html`
- Progress: `Plan/AI Assistant Implementation Progress v1.html`
- Obsidian: `C:\Users\burin\Documents\Obsidian Vault\Projects\Store management system saas\`
