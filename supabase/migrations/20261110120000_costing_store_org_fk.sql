-- ตารางต้นทุน (C1) ผูก store_id กับ organization_id ให้ตรงกับ stores
--   ช่องโหว่: auth_user_role_in_store() ให้ผ่านเมื่อสมาชิกระดับองค์กร (store_id null) โดยไม่ตรวจว่า store เป็นขององค์กรนั้น
--   → เจ้าของร้าน A เขียนแถวที่ organization_id = A แต่ store_id = ร้านของ B ได้ (ตรวจเจอบน prod 2026-11-10)
--   แนวทางเดียวกับ ISSUE-20260617 (pos_saved_tickets): composite FK ไป stores(id, organization_id)
--   ตารางทั้งหมดยังว่างบน prod ตอนเขียน migration นี้ (ตรวจแล้ว 0 แถวที่ไม่ตรง)
do $$
declare
  t text;
begin
  foreach t in array array[
    'store_cost_settings', 'store_cost_budgets', 'ingredients', 'recipe_lines', 'product_cost_settings', 'cost_allocation_templates'
  ] loop
    begin
      execute format(
        'alter table public.%I add constraint %I foreign key (store_id, organization_id) references public.stores(id, organization_id) on delete cascade',
        t, t || '_store_org_fk'
      );
    exception when duplicate_object then null;
    end;
  end loop;
end $$;
