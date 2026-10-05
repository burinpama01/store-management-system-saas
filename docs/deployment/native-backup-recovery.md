# กู้คืน backup ก่อนปล่อย native API

Backup แบบ PostgreSQL custom archive เก็บทั้ง schema และข้อมูลในไฟล์ AES-256-GCM ใต้ `artifacts/private-db-backups/` ซึ่งห้าม commit หรือ upload โดยไม่ได้รับอนุญาต ข้อมูลดิบอยู่ใน RAM ระหว่าง export/verify เท่านั้น

เก็บไฟล์ `.dump.enc` และ `.dump.enc.key.dpapi` ไว้ด้วยกัน key ผูกกับ **บัญชี Windows และเครื่องเดิม** ผ่าน DPAPI CurrentUser ไฟล์สองไฟล์เพียงอย่างเดียวไม่รับรองการกู้บนเครื่องใหม่ ต้องรักษาบัญชี/โปรไฟล์ Windows ที่สร้างไฟล์ไว้ด้วย

ตรวจการถอดรหัสจากไฟล์ที่เก็บจริง:

```powershell
node scripts/native-db-backup-verify.mjs 'artifacts/private-db-backups/<ชื่อไฟล์>.dump.enc'
```

ทดสอบคืน `public` และ `auth` ในฐาน local ใหม่ที่แยกไว้:

```powershell
node scripts/native-db-backup-verify.mjs 'artifacts/private-db-backups/<ชื่อไฟล์>.dump.enc' --restore
```

คำสั่งนี้สร้างฐาน `storeos_native_verify_restore_<timestamp>` ใหม่ทุกครั้ง ไม่เขียน prod และไม่ลบฐานใด ไม่คืน cron/jobs/workers หรือเริ่ม consumer กับฐานที่ทดสอบ ค่า hash ต้องตรงกับตอน export และต้องตรวจจำนวนข้อมูลกับจุด backup ห้ามแสดงข้อมูลส่วนตัวในรายงาน

การทดสอบนี้พิสูจน์การคืน schema/ข้อมูล `public` และ `auth` สำหรับ native release ไม่ใช่การทดสอบ disaster recovery ของ Supabase ทั้งระบบหรือไฟล์ Storage จริง การกู้ prod ต้องวางแผน maintenance และได้รับอนุมัติแยก; ห้ามเรียก `--clean`, reset/drop หรือ restore ทับ prod จาก script นี้

Rollback ปกติของ native release ให้ย้อน deployment และคง additive native schema ไว้ ไม่ลบ tombstone/บิล และไม่ restore ข้อมูลทั้งฐานเพียงเพื่อย้อน API
