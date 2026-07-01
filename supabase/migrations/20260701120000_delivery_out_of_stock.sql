-- #6 ของหมดเดลิเวอรี: ร้านกดปิดเอง (ไม่ auto จากสต็อก) → เมนู JDC แสดง is_available=false
-- โดยไม่ต้องปิดสินค้าทั้งระบบ (is_active คงเดิม)
alter table products add column if not exists delivery_out_of_stock boolean not null default false;
