-- หมวดวัตถุดิบ (ข้อความอิสระ) — ใช้แบ่งกลุ่ม/กรองในหน้า /costing/ingredients
-- null = ยังไม่ระบุหมวด; ไม่กระทบการคำนวณต้นทุน
alter table public.ingredients
  add column if not exists category text
  constraint ingredients_category_length
  check (category is null or char_length(btrim(category)) between 1 and 40);

create index if not exists ingredients_store_category_idx
  on public.ingredients (store_id, category);
