
## เป้าหมายผู้ใช้ (เจ้าของร้าน) — 2026-09-16
> เป้าหมายฟีเจอร์นี้เพื่อให้พนักงานลดการกดจอ โดยสั่ง AI ด้วยเสียง
- แปลว่า: ขั้นสุดท้ายที่ต้องการคือ **เสียงก่อน จอเป็นรอง** — ข้อความ (PR2) เป็นฐานที่พิสูจน์ท่อ tool/dispatcher/audit/idempotency แล้ว ขั้นถัดไปคือทางเข้าแบบไมค์ (PTT) ที่ยิงเข้าท่อเดิม
- ข้อบังคับเดิมยังใช้: ADR-005 (MVP = Push-to-Talk เท่านั้น ไม่ always-listening), ADR-008 (ไม่แย่งไมค์ Voice POS), ADR-003 (เสียง+ข้อความใช้ dispatcher เดียวกัน)
## สถานะล่าสุด — PR3-Live เสร็จครบ M1–M5 (commit + verify ปิดท้ายโดยผู้ประสานงาน) — 2026-09-17
- Commits บน branch `feat/ai-assistant-voice-goal`: M1 PoC `4e6a3a2` · M2 config `0c0c5f3` · M3 session route `e94723f`+`974902e` · M4 tool relay `a0197f2` · M5 UI one-press Live (commit ล่าสุด) — ยังไม่ push
- **M5:** `ui/live-assistant-core.ts` (state machine + relay client), `ui/live-webrtc.ts` (WebRTC → OpenAI Realtime ผ่าน ephemeral token เท่านั้น — browser ห้าม execute tool, function_call ถูก relay ไป server), `voice-pos/mic-ownership.ts` (ADR-008 สมุดจดเจ้าของไมค์), overlay ปุ่ม AI Live + `page.tsx` คุม liveEnabled/entitlement/pilot org ฝั่ง server, `VoiceCommandButton` งดจับไมค์เมื่อ Live ถือ (fail-closed)
- **Verify (ผู้ประสานงานรันเอง):** targeted tests **274/274 exit 0** · typecheck 0 · e2e text path **6/6** · build 0
- หมายเหตุกระบวนการ: รอบ ZCode ถูก provider ตัดกลางทางหลายครั้ง (server error / empty / network) — ทุก milestone ถูก commit เป็นช่วงจึงไม่เสียงาน; commit M5 + verify ปิดท้ายผู้ประสานงานทำเอง; **Obsidian entry ของ PR3-Live ยังไม่ได้บันทึก (ค้าง)**
- **วิธีปลด Live สำหรับ pilot Each Other:** merge PR → deploy production → ตั้ง env Vercel `AI_ASSISTANT_LIVE_ENABLED=true` + `AI_ASSISTANT_LIVE_PILOT_ORG_IDS=11460ba9-bd2d-48d3-bda6-c5e7ddacacc9` → verify
- **Manual test checklist (เจ้าของร้าน, หลัง deploy):** ① แตะปุ่ม AI Live → ขอไมค์ → สถานะ "ฟังอยู่" ② พูดไทย "เพิ่มลาเต้ 2 แก้ว" → AI ยืนยันเสียง + ตะกร้าเปลี่ยน ③ พูดชื่อคลุมเครือ → AI ถามกลับ → ตอบชื่อเต็ม ④ ปุ่มเสียงเดิม (Voice POS) ระหว่าง Live = งดจับไมค์ (ข้อความแจ้ง) ⑤ จบเซสชันทุกทาง: แตะซ้ำ / นิ่ง 15 นาที / หมด caps / ปิดแท็บ → ไมค์ดับ ⑥ org/บัญชีนอก pilot = ไม่เห็นปุ่ม + API 403
## รอบแก้จากรีวิว PR #46 — เสียงตอบ + entitlement + คำปลุก → AI Live — 2026-09-17
- Branch: `fix/ai-live-audio-and-wake` (ตัดจาก `origin/main` = `e7e01a2`) ใน worktree `.worktrees/ai-assistant-implementation`
- **(1) เสียงตอบของผู้ช่วยไม่ดัง (blocker ของ manual checklist ข้อ ②/③):** `ui/live-webrtc.ts` ไม่เคยต่อ remote track เข้า element เสียง — WebRTC ไม่เล่นเสียงเอง ผลคือ tool วิ่ง/ตะกร้าเปลี่ยนถูกต้องแต่ผู้ใช้ไม่ได้ยินอะไรเลย; เพิ่ม `createRemoteAudioSink` (element ซ่อน + `autoplay` + `playsinline` สำหรับ iPad/Safari) และ `peer.ontrack` ต่อ stream ให้ทันที, `close()` ถอดเสียง/ถอด element ทุกทาง (เรียกซ้ำได้), `play()` ที่ถูกปฏิเสธด้วย autoplay policy ไม่ทำให้เซสชันล้ม
- **(2) entitlement fail-open:** `resolveLiveAccess` และ route ข้อความเดิมใช้ `if (billingState && !canUseFeature(...))` — อ่าน billing ไม่ได้/ไม่มีแถว subscription = **ข้ามด่านแพ็กเกจ**; เปลี่ยนเป็น `?? DEFAULT_BILLING_STATE` แล้วตรวจเสมอ (รูปแบบเดียวกับ `requireFeature` ใน auth/guards.ts) + test ปักหมุดทั้งสอง route
- **(3) คำปลุก → AI Live:** เพิ่ม `voice-pos/wake-routing.ts` (สมุดจดปลายทางคำปลุกแบบเดียวกับ mic-ownership) — overlay ลงทะเบียนเมื่อร้านเปิด Live, `VoiceCommandButton` ส่งคำปลุกให้ก่อนเส้นทางเดิม; **คืนไมค์ให้ native ทันที** ด้วย `commandEnded(ai_live | ai_live_busy)` เพราะ watchdog ของเครื่องคือ 20 วินาที แต่เซสชัน Live ยาวเป็นนาที; เซสชันเปิดอยู่แล้ว = กลืนคำปลุกทิ้ง; ไม่มีปลายทาง = เส้นทาง Voice POS เดิมไม่เปลี่ยนเลย (ADR-008 amendment ใน VOICE_COEXISTENCE.md)
- **(4) คำปลุกจับไม่ติด (Vosk):** ความมั่นใจเดิมคิดจาก "คำที่แย่ที่สุดทั้งประโยค" แต่คำที่เราบอกผู้ใช้ให้พูด ("Hello StoreOS") ถอดได้เป็น `hello store [unk]` เสมอ และ `[unk]` ความมั่นใจต่ำ → คำปลุกจริงถูกปัดตกทุกครั้ง; เปลี่ยนเป็นคิดเฉพาะคำในวลีคำปลุก (`FindWakePhrase` + `ScorePhrase`, ถอยไปเกณฑ์เดิมเมื่อรูปทรง result ไม่ตรง) และเปลี่ยน cooldown มาใช้นาฬิกาเดินหน้า (`Environment.TickCount64`) กันเวลาเครื่องถอยหลังทำให้คำปลุกตายเงียบ
- **(5) เพิ่มคำปลุก + ซิงก์เว็บ↔native:** `VoskPhrases` เพิ่ม `"hey store"` (id `hey_storeos`), เพิ่ม id เดียวกันใน `KNOWN_WAKE_PHRASE_IDS` ฝั่งเว็บ + หมายเหตุคู่แฝด, หน้า standby แสดงคำปลุกทั้งสองแบบ, และ test ใหม่บังคับว่า **ทุกคำใน VoskPhrases ต้องมีรหัส** (ลืมแล้วจะกลายเป็น `unknown` แล้วเว็บทิ้งข้อความ = "ปลุกติดแต่ไม่ขึ้นรับคำสั่ง")
- **Verification (รันจริงรอบนี้):** `npx vitest run tests/unit/ai-assistant tests/unit/voice-pos --project unit` = **446/446 ผ่าน** (33 ไฟล์) · `npm run typecheck` exit 0 · `npx eslint` ไฟล์ที่แตะทั้งหมด exit 0 · `dotnet test StoreOS.VoiceSpike.Tests` = **105/105** · `dotnet test StoreOS.Launcher.Tests` = **116/116**
- **ยังไม่ได้ทำ/ต้องทำต่อ:** ยังไม่ได้รัน e2e, ยังไม่ได้ทดสอบบนเครื่องร้าน (เสียงตอบจริง/ไมค์/คำปลุก `hey store` ยังไม่มีตัวเลข false wake ของรอบใหม่) — `npm run build` รันแล้ว exit 0
- **แก้ขั้นตอนปลด pilot (สำคัญ):** ลำดับเดิมในเอกสารนี้ระบุแค่ 2 ตัวซึ่ง **ไม่พอ** — env ที่ต้องมีครบคือ
  1. `AI_ASSISTANT_ENABLED=true` (ฐานของผู้ช่วยทั้งระบบ — dispatcher ตอบ FEATURE_DISABLED ถ้าไม่มี; ตั้งแต่รอบนี้ route ตรวจตั้งแต่ก่อนเปิดไมค์ = `ai_disabled`)
  2. `AI_ASSISTANT_LIVE_ENABLED=true`
  3. `AI_ASSISTANT_LIVE_PILOT_ORG_IDS=<org id>`
  4. `AI_ASSISTANT_MUTATIONS_ENABLED=true` (ไม่งั้นเพิ่ม/ลบ/ปรับจำนวนโดน `MUTATIONS_DISABLED` เหลือแต่ read tools)
  และควรตั้ง `AI_ASSISTANT_LIVE_TOKEN_SECRET` แยกจาก `OPENAI_API_KEY` (ไม่งั้น rotate key = เซสชันที่เปิดอยู่ใช้ไม่ได้ทันที)
- **residual ที่ยังค้างจากรีวิว (ยังไม่แก้ในรอบนี้):** live session store อยู่ในหน่วยความจำ instance เดียว — `/live/session` กับ `/live/tool` ตกคนละ instance = 403 `live_session_invalid` กลางบทสนทนา (ต้องมีตาราง live session บน Supabase ก่อนขยายเกินร้านนำร่อง) และเสียงจากลำโพงร้าน/เสียงผู้ช่วยเองอาจไปเข้าเครื่องยนต์คำปลุกระหว่างเซสชัน Live — ต้องเฝ้าดูตอน pilot

## รอบแก้ตามรีวิว PR #47 (รอบสอง) — 2026-09-17
- **SDP endpoint ผิดรุ่น (blocker จริง — Live จะต่อไม่ติดเลย):** `live-webrtc.ts` ยิง offer ไป
  `https://api.openai.com/v1/realtime?model=...` ซึ่งเป็นรูปแบบก่อน GA (คู่กับ `/v1/realtime/sessions`
  ที่เลิกใช้ไปแล้วตอน M3) — ยืนยันกับเอกสาร OpenAI ปัจจุบันแล้วว่า WebRTC GA ต้องใช้
  `POST https://api.openai.com/v1/realtime/calls` + `Authorization: Bearer <ephemeral>` +
  `Content-Type: application/sdp` และ **ไม่ต้องมี model ใน URL** (model ผูกกับ client secret แล้ว);
  แยกเป็น `exchangeSdpOffer()` ให้เทสต์ปักหมุด URL/method/headers/body ได้ทั้งชุด
- **DELETE ถูก gate ขวางจนเซสชันค้าง (major):** เดิม DELETE เรียก `resolveLiveAccess()` ทั้งชุด
  ถ้าผู้ดูแลปิด Live กลางคัน จะตอบ `ended:false` โดยไม่ลบเซสชัน → slot ของร้านค้างจน TTL แล้วเปิดใหม่
  เจอ `live_store_busy` ทั้งที่ไม่มีใครใช้; แยก `resolveLiveIdentity()` (auth อย่างเดียว) ให้ DELETE
  แล้วความปลอดภัยมาจาก session token (HMAC) + org/store/user ต้องตรงกับเซสชัน — test ปักหมุดทั้ง
  เคสปิด kill switch กลางคันและเคส org หลุด pilot
- **Config contract (Option A):** Live เป็น sub-feature ของผู้ช่วย AI — `resolveLiveAccess` ตรวจ
  `AI_ASSISTANT_ENABLED` ด้วย (reason ใหม่ `ai_disabled` 503) และปุ่ม AI Live บน `/pos` ซ่อนตามเงื่อนไขเดียวกัน
  เหตุผล: tool ทุกตัวเดินผ่าน dispatcher เดิมที่ปฏิเสธด้วย FEATURE_DISABLED อยู่แล้ว — ต้องหยุดก่อนเปิดไมค์/จ่ายค่าเซสชัน
- **BLOCKER — เซสชันหลุดกลาง instance (แก้แล้ว ด้วย signed stateless session token ตามที่เจ้าของเลือก):**
  session token เปลี่ยนจาก "ลายเซ็นของ sessionId" เป็น **payload ที่เซ็นทั้งก้อน**
  (`v1.<payload base64url>.<hmac>` — org/store/user/activeCartId/allowedTools/maxToolCalls/expiresAt)
  relay จึงไม่ต้องหาเซสชันจากหน่วยความจำอีก: request ที่ตกคนละ instance คุยต่อได้ปกติ
  (test ใหม่จำลอง instance ที่ไม่เคยเห็นเซสชันแล้ว relay ผ่าน)
  - ด่านที่ยังอยู่ครบ: ลายเซ็น timing-safe, sessionId ใน body ต้องตรงกับใน token, org/store/user
    ต้องตรงกับผู้ล็อกอิน, หมดอายุตามเวลาใน token (ต่ออายุเองไม่ได้), tool ต้องอยู่ใน allowlist ของ token
  - แก้ payload แม้แต่ฟิลด์เดียว (ย้ายร้าน/ขยายเพดาน/ต่ออายุ) = ลายเซ็นไม่ผ่าน — มี test ปักหมุด
  - **สิ่งที่เป็น best-effort ต่อ instance (ยอมรับแล้ว, รูปแบบเดียวกับ rate limiter เดิม):**
    (ก) เพดานเซสชันพร้อมกันต่อร้าน (ข) เพดาน tool call ต่อเซสชัน — instance ใหม่ "รับเซสชันเข้ามานับต่อ"
    จากข้อมูลใน token (adopt) worst case คือเพดานถูกนับแยกตามจำนวน instance
    (ค) การเพิกถอนตอนกดปิด — instance ที่ไม่เคยเห็นการปิดจะยังรับคำสั่งจนกว่า token จะหมดอายุ (≤ 15 นาที)
  - ถ้าวันหนึ่งต้องคิดเงินตามนาที/ต้องเพิกถอนทันทีทั้งระบบ ค่อยย้ายตัวนับไปตารางกลางบน Supabase
    (ตอนนั้นรูปแบบ token ไม่ต้องเปลี่ยน — เพิ่มการตรวจสถานะจากตารางอีกชั้นเท่านั้น)

## Diagnostic telemetry ของ AI Live — 2026-09-17
> เป้าหมาย: เมื่อหน้าร้านบอกว่า "พูดแล้ว AI ไม่ตอบ" ต้องตอบได้จาก log ว่าพังตรงไหน โดยไม่เก็บเสียง/transcript/token

- **taxonomy กลาง** `src/modules/ai-assistant/live-telemetry-events.ts` — ชื่อ event เป็น allowlist ปิด (wake / mic / live / provider / webrtc / audio / tool / cart), stage+result มาตรฐาน, ชุด `LiveStopReason` เดียวใช้ทั้ง core และ log, รายการคีย์ต้องห้าม และเพดานรูปทรง payload
- **ฝั่ง browser** `ui/live-telemetry.ts` — ตัวเดียวต่อแท็บ, buffer 100 event ในหน่วยความจำ (เปิด DevTools ดู `window.StoreOSAIDiagnostics`), ส่งเป็นชุดทุก 2 วินาทีด้วย `keepalive`, ความล้มเหลวทุกแบบถูกกลืน (ห้ามทำให้ POS พัง), และมี "ตัวกลางของหน้า" ให้ปุ่มคำปลุกใน shell ใช้ร่วมกับแผงผู้ช่วยได้โดยไม่ผูก component เข้าหากัน
- **endpoint ใหม่** `POST /api/ai-assistant/live/telemetry` — auth (identity จาก session เท่านั้น; schema strict จึงปลอม org/store/user ไม่ได้), flag `AI_ASSISTANT_LIVE_DIAGNOSTICS_ENABLED`, rate limit 120/นาที (env ปรับได้), จำกัดขนาด body 16KB / 50 event / metadata 10 คีย์, และ **ปฏิเสธทั้งก้อน** เมื่อเจอคีย์ต้องห้าม (ไม่ strip เงียบ) → เขียนลง `system_event_logs` action `liveDiag`
- **จุดที่ติด event แล้ว:** คำปลุก (detected/route_started/live/busy/unavailable) · ไมค์ (claim_started/claimed/claim_failed/released) · เซสชัน (requested/access_granted/access_denied พร้อม reason ของทุกด่าน/create_started/created/create_failed/idle_timeout/expired/network_lost/cap_reached/stop_requested/stopped/stop_failed) · provider (client_secret_started/created/failed) · WebRTC (offer_created/sdp_exchange_*/connection_state_changed/ice_state_changed/data_channel_open|closed|error) · เสียง (remote_track_received/attach_started/play_started/play_succeeded/**play_blocked**/play_failed/closed) · tool ฝั่ง server (received/token_verified/token_rejected/rate_limited/cap_reached/not_allowed/dispatch_started/succeeded/denied/failed) · ตะกร้าบนหน้าขายจริง (apply_started/succeeded/failed พร้อม cartVersion ก่อน-หลัง)
- **privacy:** ไม่มี transcript/เสียง/args ดิบ/token/secret ในทุกเส้นทาง — มี test ปฏิเสธ `sessionToken`/`ephemeralToken`/`apiKey`/`authorization`/`transcript`/`userText`/`rawAudio`/`audioBlob`/`args`/`rawArgs`/`modelRawResponse` และ test ที่ยืนยันว่า payload ของ core ไม่มีชื่อเมนูหรือ token ปนอยู่
- **stop reason normalize:** `user | idle | expired | cap | network | provider | webrtc | tab_close | unmount | access_revoked | error` (เดิมเป็น string กระจัดกระจาย `expiry`/`page`)
- **Verification:** vitest ai-assistant+voice-pos **482/482** · typecheck 0 · `npm run build` 0 · eslint ไฟล์ที่แตะทั้งหมด 0 — หมายเหตุ: `npx eslint src` ทั้งโปรเจกต์มี error 2 จุดใน `src/app/pos/PosTerminal.tsx` (react-hooks/set-state-in-effect) ซึ่ง**มีอยู่ก่อนแล้วบน origin/main** (ไฟล์เหมือนกันทุกตัวอักษร) ไม่ได้เกิดจากรอบนี้
- **ยังไม่ได้ทำ:** manual test บน Vercel Preview (Test 1–10 ของแผน) และการทดสอบบนเครื่องร้านจริง — timeline จริงยังไม่เคยถูกอ่านด้วยตา
- **ข้อจำกัดที่ต้องรู้:** ฝั่ง Windows Launcher ยังใช้ log เดิมของตัวเอง (ไม่ได้ทำ telemetry ซ้ำซ้อน) — event `wake.detected` ที่เห็นในระบบคือฝั่งเว็บที่ได้รับข้อความจากเครื่องแล้ว ถ้าคำปลุกไม่ถึงเว็บเลยจะไม่มี event ใด ๆ (ต้องดู log ของ Launcher แทน)

## M1.1 — ถามตัวเลือกให้จบในคำถามเดียว (ลดการกดจอของพนักงาน) — 2026-09-17
> เจ้าของสั่ง: "ถ้าคำตอบกำกวมหรือไม่แน่ใจให้ถามซ้ำได้เลย เพื่อลดการผิดพลาด"

เคสที่จุดชนวน: พูด "อเมริกาโน่หนึ่ง ลาเต้หนึ่ง คาปูชิโน่หนึ่ง" แล้ว**ทั้งสามตัวต้องเลือกร้อน/เย็น**
ของเดิมใน M1 จะ `return` ทันทีที่เจอรายการแรกที่ติด ⇒ ถาม 3 รอบ ยิง tool 4 ครั้ง ตะกร้าว่างจนรอบสุดท้าย
และโมเดลต้องจำส่งรายการเดิมกลับมาครบเองทุกครั้ง (เสี่ยงรายการหาย) — ช้ากว่าพนักงานกดเอง

- **`clarification_batch` (ใหม่):** ตรวจทุกรายการให้จบก่อน แล้วคืน "ของที่ยังขาดทั้งหมด" ในครั้งเดียว
  พร้อม `readyCount` (จำนวนที่ผ่านแล้วแต่ยังไม่ถูกใส่ตะกร้า) — ผู้ช่วยถามรวบรอบเดียว
  "ทั้งสามแก้ว ร้อนหรือเย็น" → ตอบครั้งเดียว → เรียก `pos.add_items` อีกครั้งพร้อม `optionPhrases` ครบ = จบ
- **แนบ "ตัวเลือกที่มีจริง" (`choices`):** ดึงจากสินค้าจริง (variant ที่ active + กลุ่ม modifier ที่ `isRequired`)
  ทั้งในเส้นทางรายการเดียวและแบบชุด — เดิมคืนแค่ชื่อกลุ่ม ผู้ช่วยจึงถามลอย ๆ ได้อย่างเดียว
  และมี branch หนึ่งที่ note เขียนว่า "เลือกบนหน้าจอ" ซึ่งสวนกับเป้าหมายลดการกด
- **คงหลัก "ครบหรือไม่เอาเลย":** ยังไม่ใส่ตะกร้าแม้แต่รายการเดียวจนกว่าจะเลือกครบ (กันตะกร้าครึ่ง ๆ กลาง ๆ)
  เพราะรอบเดียวก็จบแล้ว ไม่ต้องแลกกับความสับสนหน้าร้าน
- **instructions:** ถามรวบครั้งเดียวจาก `clarification_batch`, อ่านตัวเลือกจาก `choices` เท่านั้น,
  **คำตอบกำกวม/ไม่ครบ = ถามซ้ำจนแน่ใจ ห้ามเดาแทนผู้ใช้** (คำสั่งตรงจากเจ้าของ)
- **ไม่ได้ทำ:** ไม่เปิด dialog ตัวเลือกอัตโนมัติในโหมดเสียง (ถามซ้ำแทนตามที่สั่ง) — โหมดข้อความยังเปิด dialog เหมือนเดิม
- **Verification:** ai-assistant **336/336** · unit ทั้งโปรเจกต์ 2671 ผ่าน / 3 ล้ม (baseline เดิมของ main ทั้งสาม)
  · typecheck 0 · build 0 · eslint ไฟล์ที่แตะ 0
- **หมายเหตุความน่าเชื่อถือของเทสต์:** เจอ `live-session.test.ts` (เคส token ถูกแก้ payload) ล้ม **หนึ่งครั้ง**
  ระหว่างรัน แล้วรันซ้ำอีก 3 รอบผ่านหมด — ยังไม่ทราบสาเหตุ บันทึกไว้เฝ้าดู ถ้าเจออีกต้องไล่จริงจัง (เป็นเทสต์ด้านความปลอดภัย)

## M1 — สั่งหลายเมนูในประโยคเดียว + กดปุ่มคิดเงินให้ (Voice Operator เฟสแรก) — 2026-09-17
> ขอบเขตที่เจ้าของล็อกไว้: **AI เน้นเพิ่มสินค้าให้ถูก ส่วนการชำระเงินแค่ "กด action ที่มีอยู่"**
> ห้าม AI สร้าง payment/QR ใหม่ ห้ามยืนยันชำระเงิน และ**ไม่ยกตะกร้าขึ้น server** (เหตุผล: ความเร็วหน้าร้าน + ออฟไลน์)

- **`pos.add_items` (ใหม่, safe_write):** รับได้ถึง 10 รายการต่อคำสั่ง resolve ผ่าน resolver เดิมของ Voice POS ทุกตัว
  - **ครบหรือไม่เอาเลย:** ถ้ามีรายการใดกำกวม/ไม่พบ/ต้องเลือกตัวเลือก/ของหมด → คืน clarification ทั้งชุด **ไม่ใส่ตะกร้าบางส่วน** และบอกด้วยว่าติดที่รายการไหน (ของครึ่ง ๆ กลาง ๆ ในตะกร้าคือสิ่งที่แก้ยากที่สุดหน้าร้าน)
  - ผลสำเร็จคืน `apply_batch` → client แตกเป็นขั้น `apply` เรียงตามที่พูด ใช้ `applyVoiceCartIntent` เส้นทางเดิม
  - instructions ของ Realtime สั่งให้เรียกครั้งเดียวเมื่อพูดหลายเมนู (ลด latency/tool call/token)
- **`pos.open_checkout` (ใหม่, safe_write):** ไม่แตะ payment ใด ๆ — คืน `client_action` ให้หน้าจอยิง `emitPosCommand("open-checkout")`
  ซึ่ง `PosTerminal` จัดการด้วย `setPhase("payment") + setOrderPanelOpen(true)` = **เส้นทางเดียวกับปุ่ม "คิดเงิน" ของพนักงานเป๊ะ ๆ**
  จากนั้นการเตรียม QR / จอลูกค้า / ปุ่มยืนยัน เป็นโค้ดเดิมทั้งหมด
- **instructions ใหม่:** เปิดจอรับชำระได้ แต่ **ห้ามยืนยันการชำระเงินเอง / ห้ามบอกว่าชำระสำเร็จ / ห้ามบอกยอดเงิน**
  (ยอดที่ถูกต้องคือยอดบนหน้าจอ เพราะ server ตีราคาใหม่ตอน `checkoutAndPayAction` ด้วย `buildTrustedCartFromCatalog`)
  — ของเดิมสั่งว่า "ห้ามพูดเรื่องการชำระเงิน" ทั้งหมด จึงแก้ test ที่ปักหมุดข้อความเก่าไว้ด้วย
- **telemetry:** เพิ่ม event `cart.checkout_opened` (stage `cart`) ให้เห็นใน timeline ว่า AI เป็นคนเปิดจอรับชำระ
- **Verification:** `vitest --project unit` ทั้งโปรเจกต์ **2667 ผ่าน / 3 ล้ม** ซึ่ง 3 ตัวที่ล้มเป็น baseline เดิมของ main
  (`no-native-dialogs` 1 + `pos-ticket-ui` 2 — ตรวจแล้วว่า marker/สตริงที่ test มองหาไม่มีอยู่ใน `PosTerminal.tsx` ของ origin/main เช่นกัน)
  · ai-assistant suite **332/332** · typecheck 0 · build 0 · eslint ไฟล์ที่แตะ 0 (เหลือ error เดิม 2 จุดใน PosTerminal.tsx จาก main)
- **ยังไม่ได้ทำ:** ไม่ได้รัน e2e, ไม่ได้ทดสอบกับเสียงจริง/เครื่องร้าน, ยังไม่ได้เปิด env ใด ๆ บน production
- **ข้อจำกัดที่ยังอยู่:** `pos.open_checkout` เป็น safe_write ⇒ ต้องมี `AI_ASSISTANT_MUTATIONS_ENABLED=true` ถึงจะสั่งได้จริง;
  ปุ่ม "คิดเงิน" ของ POS มีเงื่อนไขของมันเอง (เช่น ตะกร้าว่าง/รอบเงินสด) ซึ่งเส้นทางนี้เคารพเหมือนพนักงานกดเอง

# จุดรับช่วง AI Assistant

## ADR note — PR3-Live (2026-09-16, เจ้าของตัดสินใจ)
- **เจ้าของ override ADR-005**: จากเดิม "MVP = Push-to-Talk เท่านั้น" → เปลี่ยนเป็น **one-press Live conversation mode** บนท่อ OpenAI Realtime (แตะปุ่มเดียวเปิดเซสชันเสียงสด พูดหลายประโยค AI ตอบเสียง + execute tools ผ่าน dispatcher เดิม; จบเซสชันด้วยการแตะปุ่มซ้ำ / idle timeout / หมด caps) — **Whisper PTT เลื่อนออก**
- **pilot เฉพาะ org "Each Other"** (`11460ba9-bd2d-48d3-bda6-c5e7ddacacc9`, enterprise) — คนนอก pilot โดน 403 `live_pilot_only` เสมอ
- kill switch `AI_ASSISTANT_LIVE_ENABLED` (default **false** = production พฤติกรรมเดิม 100%) + kill switch กลาง `AI_ASSISTANT_KILL_SWITCH` ยังคุมทุกช่องทาง
- ADR-008 (ไม่แย่งไมค์ Voice POS) และ ADR-003 (dispatcher ชุดเดียว) ยังบังคับครบ — Live ใช้ session-bound signed tool channel ตาม plan v2 §11: OPENAI_API_KEY server เท่านั้น, hard caps (นาที/เซสชัน, tool calls/เซสชัน, concurrent/ร้าน), metering เฉพาะ metadata

## สถานะล่าสุด — ปลด mutation รอบสุดท้าย: wire durable store เข้า route + e2e text path เสร็จ 2026-09-16
- Branch: `feat/ai-assistant-text-e2e` (ตัดจาก `origin/main` = `644b538` ที่รวม PR1+PR2+PR3a แล้ว) ใน worktree `.worktrees/ai-assistant-implementation` — commits: `f87bbaa` (Task A: wiring) → `6d36920` (Task B: e2e spec) → docs หัวข้อนี้; **ยังไม่ push ตามคำสั่ง — ผู้ประสานงาน verify แล้ว push/PR เอง**
- **Task A — wire durable idempotency เข้า route (ขั้นที่ (2) ของลำดับปลด mutation ด้านล่าง)**
  - `src/app/api/ai-assistant/text-command/route.ts`: composition root สร้าง `new DurableIdempotencyStore(client)` จาก `createSupabaseServiceClient()` — helper service client เดิมของ repo (pattern เดียวกับ `connect/pending` + notifications cron) — แล้วส่งเป็น `idempotencyStore` ให้ `createServerAssistantDispatcher`
  - สร้างแบบ lazy + memoize promise ครั้งเดียวต่อ process (`getDispatch()`); `dispatch` เดิมที่เป็น module-level const กลายเป็น `await getDispatch()` หลัง body validation — client สร้างไม่ได้ (env supabase หาย) = throw ตาม convention ของ route อื่นที่ใช้ service client
  - opportunistic sweep ทำงานตาม design ของ durable store เอง (trigger ตอน claim ทุก 60 วิ/instance + ล้มเหลวเงียบไม่พัง request) — ไม่ต้องมีโค้ดเพิ่มใน route
  - พฤติกรรมอื่นไม่เปลี่ยน: safe_write ยังต้องผ่าน env `AI_ASSISTANT_MUTATIONS_ENABLED=true` (default ปิด, re-check ทุก dispatch) — **wiring อย่างเดียวยังไม่ปลด mutation** มี test ปักหมุดทั้งชั้น test/development และ production
  - Tests (`text-command-route.test.ts`): route test เดิม 11 เคสผ่านโดยไม่แก้ logic (เพิ่ม mock `@/server/integrations/supabase/server` ด้วย fake ตาราง `ai_assistant_actions` — pattern เดียวกับ `durable-idempotency.test.ts` ฉบับย่อ) + เพิ่ม 4 เคสใหม่: claim ลง ledger supabase จริง (แถว completed พร้อม identity) + replay ผ่าน ledger ไม่ execute ซ้ำ / production + env เปิด → safe_write execute ได้ (ผ่านเกต DURABLE_STORAGE_REQUIRED) / production ไม่ตั้ง env → MUTATIONS_DISABLED และไม่แตะ ledger / service client พังครั้งแรก → 503 ที่มี reason (assistant_unavailable) และ request ถัดไปสร้าง dispatcher ใหม่สำเร็จ (review fix — memoize ไม่ติด rejection ตลอดอายุ process)
- **Task B — e2e text path (ปิดเกตที่ค้างจาก PR2)**
  - ไฟล์ใหม่ `tests/e2e/ai-assistant-text.spec.ts` 6 เคส (chromium) — **วิธีรัน (env ใน command เท่านั้น ห้ามแตะ .env):** `AI_ASSISTANT_ENABLED=true AI_ASSISTANT_MUTATIONS_ENABLED="" OPENAI_API_KEY="" npx playwright test tests/e2e/ai-assistant-text.spec.ts` (OPENAI_API_KEY="" บังคับปิดทางสำรอง AI และ MUTATIONS_ENABLED="" ปักหมุดว่า mutation ปิด — deterministic ไม่ขึ้นกับ shell env ค้าง; **ห้ามรันขนานกับ unified-pos/voice-ai-pos** เพราะ fixture แชร์แถว seed เดียวกัน — รันเป็นไฟล์เดียวหรือรับความเสี่ยงไว้จนกว่าจะแยก org fixture)
  - เคสที่ pin ไว้: (1) ปุ่มผู้ช่วยข้อความบนแถบหัวของ shell เมื่อ env เปิด + เปิดแผงพิมพ์คำสั่งได้ (2) คำสั่งเขียนผ่าน UI → ข้อความ "การแก้ตะกร้าผ่านผู้ช่วยยังปิดในรอบนี้" (MUTATIONS_DISABLED) + ไม่มีปุ่ม undo — pin fail-closed ปลายทางจริงบน build `next start` (production ผ่านเกต durable แล้วแต่ไม่ตั้ง env) (3) ข้อความที่ parser ไม่เข้าใจ → ตอบ ai_disabled อย่างปลอดภัย (4) read-tool `pos.search_product` ตรงตัว ("ข้าวผัดกุ้ง") → matched พร้อมราคา 120 (5) ชื่อคลุมเครือ "ชา" → ambiguous candidates (ชาเย็น + ชาดำ) → follow-up ชื่อเต็ม "ชาดำ" → matched 35 (6) ยังไม่ login → /pos ไม่มีปุ่มผู้ช่วย + เรียก API ตรงโดน middleware redirect ไป /login (307, fail-closed ปลายทางเบราว์เซอร์ — route 401 อยู่ใต้ middleware)
  - ข้อค้นพบสำคัญจากการเขียน e2e: (ก) entitlement `aiAssistant` มีเฉพาะแพ็ก **enterprise** (PLAN_FEATURES — premium ก็ไม่มี) fixture จึงตั้ง enterprise ชั่วคราว (ข) เชลล์ POS หลัง U13-U21 เปลี่ยนไปจาก U9 มาก — **ไม่มี tablist "ส่วนของ POS รวม" แล้ว** (ปุ่มเสียง/ผู้ช่วยอยู่แถวหัว, โต๊ะ/ครัว/บิลเป็น dialog) ⇒ `tests/e2e/unified-pos.spec.ts` ชุด U9 shell assertions เก่ากว่า UI ปัจจุบันและจะไม่ผ่านถ้ารันตอนนี้ — นอก scope รอบนี้จึงยังไม่แก้ (บันทึกไว้ให้ทีมรู้) (ค) seed ตั้งชื่อสินค้าไม่ให้ซ้อนกันเลย ไม่มีวลีจริงที่ทำ ambiguous ได้ — spec เพิ่ม fixture product "ชาดำ" ชั่วคราว (ลบใน afterAll) (ง) `resolveVoiceProductPhrase("ผัด")` → matched ผัดกะเพราหมูสับ ไม่ใช่ ambiguous เพราะ layer startsWith ตัดสินก่อน includes (looseName ตัดวรรณยุกต์: ข้าวผัดกุ้ง → ขาวผัดกง)
  - fixture ของ spec (fail-loud ตาม pattern เดิม): อ่านค่าเดิมของ flag/subscription → ตั้ง flag true + enterprise + เปิด cash session + insert ชาดำ → afterAll คืนค่าเดิมทั้งหมด + ลบชาดำ + เก็บกวาด `ai_assistant_actions` ของ org (wiring durable เขียนแถวจริงตอน read-tool) + requestId ทุกดอกผูก `runId` ต่อรอบรัน กัน IDEMPOTENCY_CONFLICT จากแถวค้างของรอบก่อน
  - ตั้งใจไม่ทำใน e2e: 403 `ai_not_in_plan` (route unit test pin ไว้แล้ว — ทำ e2e ต้องแก้ subscriptions ที่ unified-pos.spec ใช้ร่วม เสี่ยง flake เมื่อรันชุดเต็มแบบขนาน)
- **Verification (ตัวเลขจริง):** `npx vitest run tests/unit/ai-assistant --project unit` = **188/188 ผ่าน exit 0** (เดิม 184 + wiring 4 รวม review fix); `npm run typecheck` exit 0; `npx eslint` ไฟล์ที่แตะ exit 0; `npx playwright test tests/e2e/ai-assistant-text.spec.ts` = **6/6 passed ผ่านซ้ำ 2 รอบติด** (1.7m และ 1.3m — พิสูจน์ fixture restore/rerun ได้); `npm run build` ด้วย env local exit 0; หลังรันตรวจ local DB แล้ว fixture คืนครบ (flag=false, subscription=free/active, ชาดำถูกลบ, ai_assistant_actions=0 แถว, ไม่มี cash session ค้าง)
- **สถานะลำดับปลด mutation (หัวข้อเดิมด้านล่าง) หลังรอบนี้:** (1) deploy migration `20260916000000` ขึ้น production — **เสร็จแล้วโดยผู้ประสานงาน** (2) wire durable store ที่ composition root — **เสร็จใน branch นี้ (Task A)** (3) ตั้ง env `AI_ASSISTANT_MUTATIONS_ENABLED=true` บน production — **รอผู้ประสานงานหลัง merge** (4) verify production (safe_write ผ่าน, แถวลง ai_assistant_actions, replay ใน instance เดียวได้ผลเดิม, audit/rate-limit ยังทำงาน) — หลังข้อ 3
  - **ขอบเขตของ durability ที่ต้องเข้าใจตรงกันตอน verify ข้อ (4)** (จาก code review รอบนี้): atomic claim กัน execute ซ้ำข้าม instance/restart ได้ครบ, แต่ replay ข้าม instance = **IDEMPOTENCY_CONFLICT แบบ fail-closed** (ไม่ execute ซ้ำ — ปลอดภัย) เพราะ session_id เป็นต่อ process เนื่องจากยังไม่มี device registry — client ที่ retry ข้าม instance จะเห็น conflict ไม่ใช่ผลเดิม อย่าตีความว่าเป็นบั๊ก; replay ได้ผลเดิมจริงเฉพาะ instance เดียวกัน
  - residual ก่อนเปิดใช้จริงยังคงเดิมจากหัวข้อ PR2: device registry (บัญชีเดียว 2 แท็บ = แท็บที่สองโดน CONTEXT_UNAVAILABLE), rate limit ต่อ process, format ยอดเงิน announcement, latent bug เสียง remove_item
  - residual เพิ่มจาก code review รอบนี้: (ก) read-tool เขียน ledger 2 writes/request (~1 แถว/req, retention session TTL+24ชม., sweep 100 แถว/รอบ 60 วิ) — ถ้า read หนักเกิน ~100 แถว/นาที/instance sweep ตามไม่ทันแบบเงียบ พิจารณา cron เรียก `sweepExpired` หรือ monitor จำนวนแถวหลังเปิดจริง (ข) e2e fixture แชร์แถว seed กับ unified-pos/voice-ai-pos — ห้ามรันขนาน (หมายเหตุอยู่ใน spec แล้ว), ทางแก้ถาวรคือ org fixture แยก หรือล็อก workers=1 ใน playwright.config (ตัดสินใจที่ทีม)
- ข้อจำกัดที่รักษาครบ: ไม่แตะ .env/.env.local, ไม่ deploy, ไม่ run migration กับ remote, additive เท่านั้น (ไม่แก้ pinned tests เดิม — unified-pos.spec/voice-ai-pos.spec ไม่ถูกแตะ), ไม่ commit `Plan/AI Assistant Implementation Progress v1.html`, ไม่ push

## สถานะก่อนหน้า — PR3 (Durable idempotency) M1+M2+M3 เสร็จ 2026-09-16
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
