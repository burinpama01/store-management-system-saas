-- ISSUE-20261105-PAY-003: เดิม policy SELECT ของ employee_profiles / payroll_adjustments คือ
-- "store member can read" ⇒ พนักงานทุกคนที่ล็อกอินแล้ว query ตรง (anon key + session) อ่านเงินเดือน
-- ค่าปรับ โบนัส ของเพื่อนร่วมสาขาได้ทั้งหมด แม้ UI จะไม่แสดง
--
-- ใหม่: อ่านได้เฉพาะแถวของตัวเอง หรือผู้ที่มีสิทธิ์ attendance.manage ในสาขานั้น
-- (สิทธิ์เดียวกับที่หน้า /staff และ /payslip ใช้ — auth_user_has_permission รวม role default
--  และ membership_permission_overrides แล้ว)
-- ไม่แตะ policy เขียน (manager+ ตามเดิม); service role ไม่ผ่าน RLS อยู่แล้ว

drop policy if exists "employee_profiles: store member can read" on employee_profiles;
drop policy if exists "employee_profiles: own row or attendance manager can read" on employee_profiles;
create policy "employee_profiles: own row or attendance manager can read"
  on employee_profiles for select
  using (
    user_id = auth.uid()
    or auth_user_has_permission(organization_id, store_id, 'attendance.manage')
  );

drop policy if exists "payroll_adjustments: store member can read" on payroll_adjustments;
drop policy if exists "payroll_adjustments: own row or attendance manager can read" on payroll_adjustments;
create policy "payroll_adjustments: own row or attendance manager can read"
  on payroll_adjustments for select
  using (
    user_id = auth.uid()
    or auth_user_has_permission(organization_id, store_id, 'attendance.manage')
  );
