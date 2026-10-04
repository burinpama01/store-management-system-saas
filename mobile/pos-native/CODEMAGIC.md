# StoreOS POS — เตรียม Codemagic iOS

อัปเดต 4 ตุลาคม 2026: เวอร์ชัน 0.1.2, Bundle ID `com.burin.storeos.pos`, Apple ID ที่ผู้ใช้ให้ `6819038725` เอกสารนี้เป็นข้อมูลใหม่สำหรับ build และให้ใช้แทนค่าที่ยังไม่ระบุใน README snapshot วันที่ 10 กันยายน

## ชุดไฟล์สำหรับสาขา build

- `codemagic.yaml` ที่ repository root
- `mobile/pos-native/` พร้อม `package-lock.json` และ `.gitignore`
- `src/modules/native-pos/contracts.ts` เป็น shared type-only DTO ที่ native app import และไม่มี server imports ต้องส่งไฟล์นี้ด้วยเพื่อให้ typecheck ใน checkout ของ Codemagic ผ่าน
- ไม่รวม backend API, auth/session, POS actions, migration หรือ tests ฝั่ง backend ที่ยังค้างใน worktree

ห้ามส่ง `node_modules`, `dist`, `.expo`, native generated folders, `.env`, private key หรือ certificate เข้า Git

## Workflow

เลือก workflow `storeos-ios-ipa` ในสาขาที่มี config: ติดตั้ง dependencies → TypeScript/tests/Expo check → กำหนด build number จาก `PROJECT_BUILD_NUMBER + 1` → สร้าง iOS project ด้วย Expo → ติดตั้ง pods → ใช้ signing profiles → สร้าง IPA

Workflow ไม่เปิด trigger อัตโนมัติ และไม่อัปโหลด TestFlight/App Store ใช้ manual build ทีละขั้น ผล IPA จะอยู่ใน artifacts เมื่อ native archive สำเร็จ

## Signing ที่ต้องตั้งใน Codemagic ก่อน build

ที่ Team settings → Code signing identities ต้องมี Apple Distribution certificate พร้อม private key และ App Store provisioning profile สำหรับ `com.burin.storeos.pos` ใน Team เดียวกัน ตั้ง/อัปโหลดผ่าน Codemagic UI ไม่ส่ง secret ในแชตหรือ repository

ถ้าใช้ Apple Developer integration ให้ยืนยัน integration และใช้ Fetch/Generate ตามบัญชีจริงก่อน build สคริปต์นี้ไม่เดาชื่อ integration หรือสร้าง certificate เอง

## ข้อจำกัด

Windows ตรวจ TypeScript/tests/Expo dependency check และ iOS JavaScript bundle ได้ แต่ยังไม่ยืนยัน CocoaPods/Xcode/signing/IPA ต้องดูผล build บน Codemagic ก่อนถือว่าขั้น native build ผ่าน

Backend mobile API/migration ยังไม่ได้ปล่อย รุ่นนี้ต้องเริ่มตรวจแอปด้วยโหมดสาธิต; ไม่ถือว่าพร้อมรับเงินจริงหรือเปิดร้านจริง ใบเสร็จ/ฮาร์ดแวร์ยังมี gate เดิม

ก่อนอัปโหลด TestFlight ต้องเทียบ build number กับ App Store Connect จริง และตั้งค่าการเผยแพร่ในขั้นแยก

แหล่งอ้างอิง: [Codemagic React Native/Expo](https://docs.codemagic.io/yaml-quick-start/building-a-react-native-app/), [iOS signing](https://docs.codemagic.io/yaml-code-signing/signing-ios/)
