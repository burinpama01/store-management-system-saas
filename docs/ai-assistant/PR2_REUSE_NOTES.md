# หลักฐานจุดเชื่อม PR2

ตรวจซอร์สใน worktree `00e1374` เมื่อ 15 กันยายน 2026; เอกสารนี้เป็นบันทึกผลสำรวจ ไม่ใช่หลักฐานว่าทำ PR2 แล้ว

## Cart เดียวกับหน้าขาย
- `src/app/pos/unified/voice-cart-bridge.tsx` เป็น client provider; `VoiceCartApi.getSnapshot()` ให้ cart/products/locked และ `commit()` กลับเข้าหน้าขายเดิม
- `useRegisterVoiceCart()` ถอน registration เมื่อ unmount; API เป็น null เมื่อ POS ไม่พร้อม ต้อง fail closed
- มี `openProduct`, `getPicker`, `selectPickerChoice`, `confirmPicker` ใช้ dialog ตัวเลือกเดิมได้
- Provider นี้ไม่มี server session identity, version หรือ durable idempotency; ห้ามเรียกว่า trusted server cart binding

## Resolver เดิม
- `src/modules/voice-pos/intent-resolver.ts` ฟังก์ชัน `resolveAiVoiceCommand()` รับ semantic command และ catalog snapshot ล่าสุด
- คืน apply/needs_option/needs_quantity/ambiguous/not_found/unavailable/unsupported; ไม่สร้าง side effect เอง
- ใช้ `resolveVoiceProductPhrase()` จาก `voice-pos/cart.ts` รวม aliases เดิม
- จำนวนที่ไม่ระบุจะถาม ไม่ตั้งเป็น 1 เอง; ตัวเลือกที่ไม่รู้ต้องเลือกบนจอ
- ฝั่ง AI Assistant ห้ามค้น catalog คนละชุดหรือเชื่อ product ID จาก model

## Undo เดิม
- `src/modules/voice-pos/undo.ts`: `createVoiceUndoToken`, `consumeVoiceUndoToken`, `VOICE_UNDO_WINDOW_MS=6000`
- การคืน cart ต้องรักษา current cart/version เพื่อป้องกัน undo ทับการแก้ด้วยมือหรือคำสั่งใหม่

## เกตที่ต้องทำก่อน PR2 mutation
1. กำหนดและทดสอบ session/cart binding กับ authenticated org/store/user และ cart generation ปัจจุบัน
2. กำหนดการเก็บ idempotency ที่ไม่สูญเสียเมื่อ worker restart; ห้ามปลด production mutation gate ด้วย memory ledger
3. Re-check permissions และ entitlement ที่ server แม้ replay
4. UI ใช้ cart/queue/picker/undo เดิม และไม่แย่งไมค์ Voice POS ใน text phase
5. ไม่มี route หรือ UI ของ PR2 ถูกเพิ่มจากการสำรวจนี้
