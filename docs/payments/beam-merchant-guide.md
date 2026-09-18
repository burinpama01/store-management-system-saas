# Beam (BYO) — คู่มือร้าน

รับเงินผ่าน QR พร้อมเพย์ของ **บัญชี Beam ของร้านเอง** เงินเข้าบัญชี Beam ของร้านโดยตรง ไม่ผ่าน StoreOS
POS จะสร้าง QR ล็อกยอดผ่าน Beam แล้ว **ปิดบิลเองเมื่อ Beam ยืนยันว่าเงินเข้า** พนักงานไม่ต้องตรวจสลิป

ต้องใช้แพ็กเกจที่มีฟีเจอร์ BYO Payment Gateway (Premium / Business เลือกฟีเจอร์ / Enterprise)

## ตั้งค่า

1. เข้า Lighthouse → เมนู **Developers**
   - ทดสอบ: https://playground.beamcheckout.com
   - ใช้จริง: https://lighthouse.beamcheckout.com
2. คัดลอก **Merchant ID** และสร้าง **API key**
3. หน้า **Webhooks** → เพิ่ม URL จากหน้า StoreOS *ตั้งค่า → ชำระเงินลูกค้า → Beam*
   เลือก event `charge.succeeded` และ `charge.failed` → คัดลอก **HMAC key**
4. ใน StoreOS: เลือก Playground/Production → วาง Merchant ID, API key, HMAC key →
   **ทดสอบเชื่อมต่อ** → ติ๊ก *เปิดใช้ "Beam QR" ที่หน้า POS* → **บันทึก Beam**

key ของ Playground กับ Production **ใช้แทนกันไม่ได้** ถ้าเปลี่ยนสภาพแวดล้อมต้องวาง key ใหม่

## ใช้งานที่ POS

เลือกวิธีชำระ **Beam QR** → ลูกค้าสแกน → หน้าจอจะขึ้น "Beam ยืนยันรับเงินแล้ว" แล้วปิดบิลเอง
(ถ้าร้านเปิดจอลูกค้า QR จะแสดงที่จอลูกค้าด้วย เมื่อ Beam ส่ง QR มาเป็นข้อความ EMV)

- ยืนยันผ่าน webhook ทันที ถ้า webhook ไม่มา ระบบจะถาม Beam เองทุก ~3 วินาที
- QR หมดอายุใน 10 นาที → กด "สร้าง QR ใหม่"
- แก้ตะกร้าหรือเปลี่ยนวิธีชำระ = ยกเลิก QR เดิมอัตโนมัติ

## รายการที่ต้องตรวจ (หน้าตั้งค่า → รายการ Beam ล่าสุด)

| สถานะ | ความหมาย | ต้องทำ |
|---|---|---|
| เงินเข้าหลังยกเลิก (`LATE_PAID`) | ลูกค้าจ่ายหลังพนักงานยกเลิก QR หรือหลังหมดอายุ | คืนเงินใน Lighthouse หรือรับชำระบิลนั้นด้วยวิธีอื่น |
| ยอดไม่ตรง (`REVIEW_REQUIRED`) | ยอดที่ Beam รับไม่ตรงกับยอดในระบบ | ตรวจใน Lighthouse |
| รับเงินแล้ว + ยังไม่ผูกบิล | เงินเข้าแต่ POS ปิดหน้าก่อนปิดบิล | คืนเงิน หรือเปิดบิลแล้วรับชำระด้วยวิธีอื่น |

## ก่อนใช้เงินจริง (ตาม go-live checklist ของ Beam)

1. เลือก Production ใช้ key ของ Production และตั้ง webhook ของ Production (HMAC key คนละตัวกับ Playground)
2. ลองจ่ายจริง 1 บาทที่ POS → บิลต้องปิดเอง
3. ดู *ตั้งค่า → ระบบ → Log* ว่ามี `BEAM_WEBHOOK_PAID` (ถ้าเห็นแต่ `BEAM_PAID_VIA_LOOKUP` แปลว่า webhook ยังไม่เข้า ให้ตรวจ URL/HMAC key)
4. คืนเงินรายการทดสอบใน Lighthouse

## สำหรับนักพัฒนา

- โค้ด: `src/modules/payments/beam-*.ts`, `webhook-beam.ts`, route `src/app/api/payments/webhooks/beam`
- ลายเซ็น: `base64(HMAC-SHA256(base64decode(HMAC key), raw body))` ใน header `X-Beam-Signature`
- ปิดบิลได้เฉพาะเมื่อ `gateway_payments.status = PAID` และยังไม่ผูกบิลอื่น (`claimBeamPaymentForOrder`)
- ต้องตั้ง `PAYMENTS_CREDENTIALS_KEK` บน production (ใช้เข้ารหัส key ของร้าน)
- Phase C2 (เครื่อง Bolt+ แบบ Pairing): ใช้ `bolt-intents` + webhook ชุดเดียวกัน — ยังไม่ทำ
