# ADR-008 — Voice POS / Standby / AI Assistant coexistence

> Status: Accepted for pilot  
> Date: 2026-09-15  
> Related: Plan v2 § ADR-008, ADR-009

## Decision

During pilot, **three systems may coexist** but must not share a microphone capture pipeline or invent separate cart logic:

| System | Role in pilot | UI entry |
|---|---|---|
| Voice POS (`src/modules/voice-pos`) | **Primary** intent → resolver → local cart | Existing Voice POS controls |
| Windows Voice Standby / Launcher TTS | Optional host channel; **not** required for AI Assistant MVP | Standby / Launcher flows (separate plans) |
| AI Assistant (`src/modules/ai-assistant`) | Opt-in overlay; **text first**, then push-to-talk | Separate AI button — does **not** replace Voice POS button |

## Rules

1. **One mic owner at a time.** If AI Assistant PTT is active, Voice POS must not also capture/process the same utterance (and vice versa).
2. **Shared domain only.** Product resolve + cart mutate must go through Voice POS resolver/alias + `pos/cart` (ADR-009). No second catalog searcher inside `ai-assistant`.
3. **No dual execution.** A single user utterance must not run Voice POS pipeline and AI Assistant tool pipeline in parallel.
4. **Standby stays optional.** AI Assistant text mode must work without Windows Standby.
5. **Sunset decision later.** After pilot metrics, choose absorb vs keep separate — do not merge modules in MVP.

6. **Wake word may open Live (amendment 2026-09-17).** คำปลุกของ Windows Standby ที่มีอยู่แล้ว
   (`wake.detected`) เปิดเซสชัน AI Live ได้ ถือว่าเทียบเท่า "แตะปุ่มหนึ่งครั้ง" — ไม่ใช่ always-listening
   (เครื่องยนต์คำปลุกยังเป็นตัวเดิมบนเครื่อง ไม่มีการเปิดไมค์เบราว์เซอร์ค้างไว้)
   ข้อบังคับของเส้นทางนี้:
   - เว็บต้องรายงาน `command.sessionEnded` (`ai_live` / `ai_live_busy`) ให้ native **ทันที**
     เพราะ watchdog ของเครื่องให้เวลารอบละไม่เกิน 20 วินาที ขณะที่เซสชัน Live ยาวเป็นนาที
   - เซสชัน Live เปิดอยู่แล้ว = คำปลุกถูกกลืนทิ้ง (`busy`) ห้ามเปิดไมค์ซ้อน
   - ร้านที่ไม่ได้เปิด Live (ไม่มีปลายทางลงทะเบียน) = คำปลุกเดินเส้นทาง Voice POS เดิมทุกประการ
   - ปุ่ม "พักคำปลุก" และสถานะ `disabled` ของ POS ยังคุมทั้งสองเส้นทางเหมือนเดิม

## Implementation checklist (PR2/PR3 UI)

- [x] Distinct AI entry control on POS
- [x] Mutual exclusion flag/session for mic capture (`voice-pos/mic-ownership.ts`)
- [x] Wake routing to Live (`voice-pos/wake-routing.ts`) + คืนไมค์ให้ native ทันที
- [ ] Clarification/undo UI can reuse Voice POS patterns without importing Standby
- [ ] Documented for staff: which button does what

## Non-goals

- Always-listening (ไมค์เบราว์เซอร์เปิดค้างโดยไม่มีคำปลุก/การแตะปุ่ม)
- คำปลุกตัวใหม่เฉพาะของ AI Live (ใช้ของ Windows Standby ที่มีอยู่เท่านั้น)
- Replacing Voice POS in the same release as AI Assistant MVP
