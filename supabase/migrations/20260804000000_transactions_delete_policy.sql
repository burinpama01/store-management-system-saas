-- การลบรายการรายรับ-รายจ่ายไม่เคยทำงานจริงบน production: ตาราง transactions เปิด RLS ไว้ตั้งแต่
-- 20260518000002 แต่มี policy แค่ select / insert / update — ไม่มี `for delete` เลย Postgres จึงลบได้
-- 0 แถวโดยไม่คืน error แอปเลยรายงานว่าลบสำเร็จทั้งที่รายการยังอยู่ (และเขียนรายการกลับลง cash ledger
-- ไปแล้ว = ยอดเงินสดในลิ้นชักเพี้ยน)
--
-- เปิดสิทธิ์ลบให้เฉพาะคนที่มี cashflow.manage (owner / admin / super_admin ตามค่าเริ่มต้น และเคารพ
-- permission override) และกันรายการที่ผูกกับออร์เดอร์ POS ไว้ที่ระดับฐานข้อมูลด้วย — เดิมกันไว้แค่ใน
-- แอป (MN-01 ที่ accounting/actions.ts) รายได้จาก POS ต้องยกเลิกผ่านการ void ออร์เดอร์เท่านั้น

drop policy if exists "transactions: cashflow.manage can delete" on transactions;
create policy "transactions: cashflow.manage can delete"
  on transactions for delete
  using (
    auth_user_has_permission(organization_id, store_id, 'cashflow.manage')
    and order_id is null
  );
