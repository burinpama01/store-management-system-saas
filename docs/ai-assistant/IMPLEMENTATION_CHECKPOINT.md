# จุดรับช่วง AI Assistant

## สถานะล่าสุด — PR2 (Text POS) ระหว่างทำ: M1+M2 เสร็จ 2026-09-16
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
