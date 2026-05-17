# Store Management System SaaS

โปรเจกต์ SaaS ใหม่สำหรับระบบจัดการร้าน โดยใช้โครงสร้าง business/domain จาก `C:\Users\burin\Accounting moojoom` และทำ UX/UI ใหม่ทั้งหมด

Stack target:

- App: Next.js App Router + TypeScript
- Database/Auth/Realtime/Storage: Supabase
- SaaS Billing: Stripe
- Deploy: Vercel

เริ่มอ่านตามลำดับ:

1. `PROJECT_CONTEXT.md`
2. `IMPLEMENTATION_PLAN.md`
3. `docs/source-audit/` เมื่อสร้างแล้ว

ข้อห้ามหลัก:

- ห้ามก๊อป `.env`, API key, token, credential
- ห้ามใช้ `node_modules/` หรือ `graphify-out/` จาก source
- ห้ามใช้ legacy HTML/CSS เป็น final UI
- ห้ามใช้ port `7842`
