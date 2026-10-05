# StoreOS POS — อัปโหลด TestFlight v0.1.3

5 ตุลาคม 2026 · เอกสารนี้ใช้สำหรับ workflow ใหม่ แยกจาก CODEMAGIC.md ของขั้น build-only v0.1.2

## เป้าหมาย
อัปโหลด signed IPA เข้า App Store Connect เพื่อเตรียมทดสอบภายในผ่าน TestFlight ไม่ส่ง beta review หรือ App Store review อัตโนมัติ

## Configuration
- Workflow ID เดิม `storeos-ios-ipa` ชื่อแสดงใหม่ `StoreOS POS iOS TestFlight`
- Branch `feat/pos-native-ipad`; Bundle ID `com.burin.storeos.pos`; Apple ID `6819038725`
- Integration `Apple Key JDC` คือชื่อที่ผู้ใช้เลือกและใช้ Fetch signing identities สำเร็จ ต้องมีสิทธิ์ App Manager หรือสูงกว่าสำหรับ upload; สิทธิ์ upload ยังไม่ได้พิสูจน์จริง
- `publishing.app_store_connect.auth: integration` เปิด upload; `submit_to_testflight: false` ปิด beta review อัตโนมัติ ไม่ปิด upload; `submit_to_app_store: false` ปิด App Store review
- เลข build ใหม่เป็นค่าสูงสุดระหว่าง Codemagic project counter+1, latest Apple build+1 และ buildNumber ใน app.json หากอ่าน Apple API ไม่สำเร็จหรือผลไม่ใช่ตัวเลขให้หยุด ไม่ใช้ค่าทดแทนเงียบ ๆ

## ขั้นตอน
1. หลัง config ผ่าน review และ push ให้ refresh Codemagic branch แล้วเลือก commit ล่าสุดและ workflow ชื่อใหม่
2. Manual build จะสร้าง IPA และอัปโหลดด้วย integration; ต้องดู publishing log และหน้า App Store Connect จริง ไม่ใช้สถานะ build-success แทน upload-success
3. ใน StoreOS POS → TestFlight รอ Apple processing แล้วตรวจ build/version พร้อมตอบ export compliance ตามจริงหาก Appleถาม
4. เพิ่มตัวเองในกลุ่ม Internal Testing และเลือก build เมื่อพร้อมทดสอบ ต้องกำหนดผู้ทดสอบจริง ไม่เดาชื่อกลุ่ม
5. ติดตั้ง TestFlight บน iPad และทดลองโหมดสาธิตก่อน Backend mobile API/migration ยังไม่ได้ปล่อย รุ่นนี้ยังไม่ถือว่าพร้อมรับเงินจริง

## หลักฐาน
รอบก่อน v0.1.2 มี screenshot cloud signed IPA สำเร็จ ไม่ได้อัปโหลด; รอบ v0.1.3 ยังต้องพิสูจน์การอ่านเลข build/สิทธิ์ API/publishing/Apple processing/ติดตั้งจริง

อ้างอิง: [Codemagic publishing](https://docs.codemagic.io/yaml-publishing/app-store-connect/), [Build versioning](https://docs.codemagic.io/knowledge-codemagic/build-versioning/)
