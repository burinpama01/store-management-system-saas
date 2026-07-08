-- Fix: staff/cashier clock-out was denied by RLS (Postgres error 42501,
-- "You do not have permission to perform this action").
--
-- The "attendance: staff can clock out own record" UPDATE policy declared only a
-- USING clause. For UPDATE policies, when WITH CHECK is omitted Postgres reuses
-- the USING expression as the WITH CHECK. Clock-out flips status 'active' ->
-- 'completed', so the *new* row failed the implicit check `status = 'active'`
-- and the update was rejected. Managers/owners were unaffected because a
-- separate "manager+ can adjust" policy allowed them.
--
-- Give the policy a proper WITH CHECK: a user may complete (update) their own
-- record. USING still limits which rows are updatable to the user's own active
-- record, so this does not let anyone touch another employee's attendance.

drop policy if exists "attendance: staff can clock out own record" on attendance_records;

create policy "attendance: staff can clock out own record"
  on attendance_records for update
  using (user_id = auth.uid() and status = 'active')
  with check (user_id = auth.uid());
