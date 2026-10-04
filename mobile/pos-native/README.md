# StoreOS POS Native — รุ่นพัฒนา iPad first

สถานะ 10 กันยายน 2026: เปิดโหมดสาธิตได้ โค้ดผ่าน source review แต่ยังไม่พร้อมรับเงินจริงหรือเผยแพร่ App Store

## ที่ทำงาน

- Worktree: `D:\Store management system saas\.worktrees\pos-native-ipad`
- Branch: `feat/pos-native-ipad`; base `d24d0c5`
- React Native 0.86.3, Expo 57, React 19.2.3, TypeScript 6.0.3
- ยังไม่มี commit, build, native signing, migration apply หรือ deploy
- root main มีงานอื่นต่อจาก base นี้ ต้องตรวจ conflict และ regression อีกครั้งก่อนรวมงาน

## เปิดหน้าขายสาธิต

รันจากโฟลเดอร์นี้:

```powershell
npm ci
npm run web
```

เปิด http://localhost:19007 แล้วเลือก “ลองหน้าขายด้วยข้อมูลสาธิต” การจบบิลในโหมดนี้ไม่รับเงินจริงและไม่สร้างออเดอร์ในเซิร์ฟเวอร์

การทดสอบ iOS/Android ต้องใช้ development build เพราะมี native TCP module; ไม่มี signing/project identifier ที่ยืนยันแล้ว จึงยังไม่ได้สร้าง IPA/APK และไม่ถือว่า Expo Go เป็นผลทดสอบเครื่องพิมพ์

## ฟีเจอร์ที่มีโค้ดแล้ว

| ส่วน | พฤติกรรม |
|---|---|
| หน้าขาย | ค้นหา/หมวดสินค้า ตัวเลือก/หมายเหตุ จำนวน และยอดเงินแบบสตางค์ |
| บิล | เก็บ draft แยกผู้ใช้/ร้านใน AsyncStorage; สลับหน้าและเปิดแอปใหม่กู้บิลได้ |
| เข้าสู่ระบบ | HTTPS + Supabase password login, token ใน SecureStore บน native; เว็บใช้โหมดสาธิต |
| เซสชัน | หมดอายุให้เข้าสู่ระบบใหม่โดยเก็บ draft; ยังไม่มี refresh token อัตโนมัติ |
| รับชำระ | เงินสด/โอนใช้กฎเดิม เปิดรอบเงินสดผ่านเว็บก่อน; ตรวจราคาใหม่ก่อนสร้างบิล |
| JDC | โหลดคิวแบ่งหน้า สินค้า/ตัวเลือก/หมายเหตุ ตรวจ organization+store+link ก่อนเปลี่ยนสถานะ |
| AI | ข้อความ → API AI เดิม → เสนอเพิ่มสินค้าเท่านั้น ชื่อ/ตัวเลือกต้องตรงแค็ตตาล็อก ผู้ใช้ยืนยัน; ยังไม่มี microphone |
| เครื่องพิมพ์ระบบ | เปิด system print/AirPrint สำหรับเอกสารทดสอบภาษาไทย |
| LAN | TCP ส่ง ESC/POS raster จากภาพข้อความไทย เลือก 384/576 dots, cut ปิดโดยปริยาย, ส่งครั้งเดียว |
| คำขอค้าง | เก็บ operation/payload ก่อนส่ง ตรวจบิลเดิม; terminal cancelled/voided/refunded แสดงผลตามจริง |
| ยุติคำขอ | server-only RPC ใช้ lock เดียวกับสร้างบิล และ tombstone ป้องกัน delayed create |

## ส่วนที่ยังไม่เสร็จ

- ใบเสร็จจริงบน native ยังไม่เปิดใช้: ต้องเชื่อมรูปแบบร้านและ QR รับแต้มตาม authoritative orderId ให้ครบก่อน ห้าม fallback เป็นใบเสร็จไม่มี QR ที่จำเป็น
- Bluetooth/BLE, USB/COM, Print Hub และ vendor SDK ยังไม่มี adapter ที่เปิดใช้งาน; ไม่มีการรับรองเครื่องพิมพ์ทุกรุ่น
- ไม่มีพิมพ์ครัวอัตโนมัติ เพราะยังต้องทำ ownership/dedup ระหว่างเว็บกับหลาย iPad
- การรับเงินจริง/JDC/AI/login ใช้งานจริงยังไม่ผ่าน UAT
- รายการบิลใน demo เก็บใน memory; draft เก็บในเครื่อง ส่วนบิลจริงโหลดจากเซิร์ฟเวอร์
- native session refresh, printer profile persistence/discovery และ kiosk/device management ยังไม่ได้ทำ

## API และขอบเขตสิทธิ์

`src/app/api/mobile/pos/[operation]/route.ts`:

- GET `config` ส่งเฉพาะ public Supabase configuration
- GET `bootstrap`, `orders`, `delivery?page=0`
- POST `checkout`, `cancel-operation`, `delivery-status`, `voice`
- ตรวจ Bearer ด้วย Supabase auth.getUser; X-Store-Id ต้องอยู่ในร้านที่เข้าถึงได้
- permission, subscription และ suspension ใช้กฎเดิม; ไม่ใช้ cookie fallback เมื่อมือถือระบุร้าน
- service client อยู่เซิร์ฟเวอร์เท่านั้น; actor ของ RPC มาจาก request ที่ตรวจแล้ว ไม่รับ actor จาก body

## Migration ที่ต้องตรวจและทดสอบก่อนใช้ API รับชำระ

`supabase/migrations/20260910000001_native_pos_operation_cancellation.sql`

ไฟล์นี้ยังไม่ apply ใน environment ใด ขาด migration แล้ว native checkout/cancel ต้อง fail closed ไม่กลับไปใช้เส้นทางที่ไม่ป้องกันบิลซ้ำ

- RPC create/cancel ให้เฉพาะ service_role; anon/authenticated ต้องเรียกตรงไม่ได้
- API ตรวจสิทธิ์/retail catalog ก่อนส่ง actor ที่ตรวจแล้วให้ RPC
- wrapper ตั้ง actor claims แบบ transaction-local เพื่อให้ RPC เดิมตรวจ actor จาก auth.uid แล้วคืนค่าหลังจบ
- create/cancel ใช้ advisory lock เดียวกับ POS idempotency key
- cancel ถ้ามีบิลแล้วคืน orderId โดยไม่ยกเลิกยอดขาย; ถ้ายังไม่มีให้เก็บ tombstone ก่อนปลด draft
- ไม่ลบ tombstone เพื่อ cleanup จนมีหลักฐานว่าคำขอเก่าไม่สามารถ replay ได้
- ถ้าจะ rollback ต้องหยุด native checkout ก่อน ห้ามลบตารางเพื่อให้คำขอเก่ากลับมาสร้างบิล

ต้องทดสอบ staging: role grants, actor spoof/store mismatch, claims restoration success/error, create-before-cancel, cancel-before-create, concurrent replay, timeout ก่อน/หลังจ่าย, รายการเปลี่ยนหลัง timeout และ paid/cancelled/voided/refunded reconciliation

## ผลตรวจที่ยืนยันแล้ว

- root tests 102/102: native API/operation/scope/catalog + Connect + Printing
- native tests 15/15: cart recovery, AI allowlist/stale proposals, storage error recovery, raster byte packing, private LAN validation, TCP one-write/timeout
- root และ native TypeScript ผ่าน; Expo dependency check ผ่าน
- browser CUA: เพิ่มลาเต้หวานน้อย/หมายเหตุ เพิ่มจำนวน สลับ JDC แล้วกลับมา โหลดแอปใหม่กู้บิล และจบบิลสาธิต 150 รับ 200 ทอน 50 ผ่าน
- DOM viewport iPad 1194×834 และ 834×1194 ไม่มี document overflow หลังแก้ flex
- screenshot API ใช้ไม่ได้ (`Unable to capture screenshot`): ยังไม่ผ่าน visual screenshot QA และไม่เท่ากับ native iPad test
- `npm audit`: คงเหลือ 10 moderate ในสาย Expo/xcode/uuid; ไม่มี high/critical ในผลล่าสุด แก้ Vitest advisory โดยใช้ 4.1.11 แล้ว; ไม่ใช้ force downgrade Expo
- source review ผ่านรอบแก้; ยังไม่มี DB concurrency/runtime verification

## คำสั่งตรวจซ้ำ

จากโฟลเดอร์นี้:

```powershell
npm test
npm run typecheck
npm run check
```

จาก root worktree:

```powershell
node 'D:\Store management system saas\node_modules\vitest\vitest.mjs' run --project unit tests/unit/native-pos-operation.test.ts tests/unit/native-pos-api.test.ts tests/unit/native-pos.test.ts tests/unit/connect.test.ts tests/unit/printing.test.ts
node 'D:\Store management system saas\node_modules\typescript\bin\tsc' --noEmit --pretty false --incremental false
```

## ขั้นถัดไปที่ต้องระบุ environment

1. ระบุ staging project/URL แล้วอนุมัติ apply migration ใน staging
2. ทดสอบ API ด้วยร้าน/ผู้ใช้ทดสอบอย่างน้อยสองสาขาและ role ที่ต่างกัน
3. ระบุ Mac หรือ Expo/EAS project, bundle identifier, signing และ iPad สำหรับ development build
4. ทดสอบ LAN/ระบบพิมพ์จริง ภาษาไทย กระดาษหมด ตัดการเชื่อมต่อ และแอปเข้า background
5. ต่อใบเสร็จจริง/QR รับแต้มและ adapters ที่เหลือก่อน release

ก่อน build หรือ commit ต้องขยับ version ตาม AGENTS.md; production migration/deploy/App Store submission ต้องอนุมัติแยก

แหล่งข้อมูลเครื่องพิมพ์: [react-native-tcp-socket](https://github.com/Rapsssito/react-native-tcp-socket), [Expo Print](https://docs.expo.dev/versions/latest/sdk/print/).
