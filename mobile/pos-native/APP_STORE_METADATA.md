# StoreOS POS 1.0.0 — App Store Connect metadata

ข้อความที่จะกรอกใน App Store Connect สำหรับรุ่น 1.0.0 (แผน: `Plan/StoreOS iOS App Store Review Release v1.html`)
ห้ามเขียนรหัสผ่านบัญชีรีวิวลงไฟล์นี้ — กรอกใน App Store Connect เท่านั้น

## App Information
- Name: StoreOS POS
- Subtitle (TH, ≤30): ขายหน้าร้าน รับเงิน ออกใบเสร็จ
- Primary category: Business · Secondary: Productivity
- Age rating: 4+ (ไม่มีเนื้อหาที่ต้องจำกัด)
- Privacy Policy URL: https://www.store-os.online/privacy-policy
- Support URL: https://www.store-os.online
- Marketing URL: https://www.store-os.online

## Version 1.0.0 (ภาษาไทย)
**Promotional text**
แอปขายหน้าร้านสำหรับร้านที่ใช้ StoreOS — ขายเร็ว รับเงินสดหรือ QR และดูบิลได้จาก iPhone และ iPad

**Description**
StoreOS POS คือแอปขายหน้าร้านสำหรับร้านกาแฟ ร้านอาหาร และร้านค้าที่ใช้ระบบ StoreOS

• ขายสินค้าเร็ว: ค้นหาเมนู เลือกขนาดและตัวเลือก ใส่หมายเหตุ
• รับชำระเงินสด พร้อมคำนวณเงินทอน หรือรับผ่าน QR พร้อมเพย์ (สำหรับร้านที่เปิดใช้)
• ใบเสร็จบนหน้าจอ และพิมพ์ผ่านเครื่องพิมพ์ใบเสร็จ WiFi (ESC/POS)
• เปิด–ปิดกะเงินสด ตรวจส่วนต่างเงินในลิ้นชัก
• พักบิลและเรียกบิลกลับมาทำต่อ
• ประวัติบิลวันนี้และรายละเอียดการชำระ
• ค้นหาลูกค้าด้วยเบอร์โทร ใช้คูปองและส่วนลดท้ายบิล สะสมแต้ม

ต้องมีบัญชี StoreOS ของร้าน เจ้าของร้านสมัครและเพิ่มพนักงานได้ที่ store-os.online

**Keywords** (≤100)
POS,ขายหน้าร้าน,แคชเชียร์,ใบเสร็จ,ร้านกาแฟ,ร้านอาหาร,พร้อมเพย์,คูปอง,สะสมแต้ม,StoreOS

**What's New**: รุ่นแรก

## App Review Information
- Sign-in required: Yes
- User name: appreview@store-os.online
- Password: (ผู้ใช้ตั้งเองผ่านลิงก์ตั้งรหัส แล้วกรอกใน App Store Connect)
- Contact: ชื่อ/เบอร์/อีเมลของผู้ดูแล (ผู้ใช้กรอกเอง)

**Notes (English)**
StoreOS POS is a business (B2B) point-of-sale app for merchants who already use the StoreOS web back office (https://www.store-os.online). Store owners create their business account and add staff on the website; the app does not offer account sign-up or any digital purchases.

Demo account: the credentials above sign in to an isolated demo store "StoreOS Review Café" with sample products. Nothing is charged.

Suggested test flow:
1. Sign in → choose "StoreOS Review Café" → "เปิดหน้าขาย" (Open sales).
2. Tap products to add them (ลาเต้ has hot/iced options, ชาไทยเย็น has a sweetness choice).
3. Optional: "ลูกค้า / ส่วนลด / คูปอง" → coupon code REVIEW10 gives 10% off.
4. "รับชำระเงิน" (Take payment) → Cash → enter amount → confirm. The receipt is shown on screen.
5. "เพิ่มเติม" (More) → cash shift, parked bills, printers, settings (privacy policy, terms, account deletion link).

Payments: the app records in-store payments for physical goods and services sold by the merchant (cash, or a PromptPay QR from the merchant's own payment provider when the store enables it). It is not used to buy digital content. QR payment is disabled for the demo store.
Printing is optional: receipts are always visible on screen; a LAN (Wi-Fi) ESC/POS receipt printer can be configured under More → Printers if available. The Local Network permission is requested only when the user prints to a LAN printer.
Bluetooth: the binary includes a Bluetooth library reserved for receipt printers in a future version. In 1.0.0 the Bluetooth printer feature is disabled at build time, so the app never initializes Bluetooth or shows the Bluetooth permission prompt.
Account deletion: Settings → "ขอลบบัญชีและข้อมูล" opens https://www.store-os.online/account-deletion.
The app UI is in Thai.

## App Privacy (Data types)
| Data | Linked to user | Tracking | Purpose |
|---|---|---|---|
| Contact Info: Email Address (บัญชีพนักงาน) | Yes | No | App Functionality |
| Contact Info: Name, Phone Number (ลูกค้าของร้านที่พนักงานบันทึก) | Yes | No | App Functionality |
| Purchases: Purchase History (บิลขาย) | Yes | No | App Functionality |
| User ID | Yes | No | App Functionality |
ไม่ใช้ข้อมูลเพื่อโฆษณาหรือ tracking · ไม่มี third-party analytics SDK ในแอป

## Screenshots ที่ต้องมี
- iPhone 6.9" (1320×2868 หรือ 1290×2796) อย่างน้อย 3 รูป: หน้าขาย, ชำระเงิน, ใบเสร็จ/ประวัติบิล
- iPad 13" (2064×2752 หรือ 2048×2732) อย่างน้อย 3 รูป
- ถ่ายจาก build 1.0.0 ด้วยบัญชีรีวิวเท่านั้น
