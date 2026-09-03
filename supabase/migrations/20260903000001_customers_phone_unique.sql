-- ============================================================
-- แก้ audit ระบบสมาชิก 2026-07-19 ข้อ 2 และ 3
--
-- ข้อ 2: เบอร์ลูกค้าถูกเก็บสองรูปแบบ (แดชบอร์ดเก็บ "081-234-5678" ตามที่พิมพ์
--        แต่ member portal normalize ก่อนเทียบ) → ลูกค้าล็อกอินไม่เจอ / แต้มแยกสองบัญชี
-- ข้อ 3: ไม่มี unique (store_id, phone) → เบอร์ซ้ำได้ พอซ้ำแล้ว maybeSingle()
--        คืน error ทำให้ OTP/สมัครสมาชิกของเบอร์นั้นพังถาวร
--
-- ตรวจข้อมูล production ก่อนเขียน migration นี้ (2026-09-03):
--   ลูกค้า 18 ราย · เบอร์ที่ยังไม่ normalize 0 แถว · เบอร์ซ้ำในร้านเดียวกัน 0 กลุ่ม
-- จึงเป็นจังหวะที่ปิดช่องนี้ได้โดยไม่ต้องรวม/ลบข้อมูลของใครเลย
-- ============================================================

-- (1) normalize เบอร์ที่มีอยู่ให้เป็นรูปแบบเดียว (ตัดช่องว่าง วงเล็บ ขีด)
--     idempotent — วันนี้ไม่มีแถวไหนเข้าเงื่อนไข แต่ต้องมีไว้เผื่อ environment อื่น
update public.customers
   set phone = regexp_replace(phone, '[\s()-]', '', 'g'),
       updated_at = now()
 where phone is not null
   and phone <> regexp_replace(phone, '[\s()-]', '', 'g');

-- (2) ถ้ามีเบอร์ซ้ำหลัง normalize ให้หยุดพร้อมบอกว่าซ้ำที่ไหน
--     (ห้ามรวมหรือลบลูกค้าอัตโนมัติ — เป็นข้อมูลจริงของร้าน ต้องให้คนตัดสิน)
do $$
declare
  v_dup text;
begin
  select string_agg(format('store=%s phone=%s (%s แถว)', store_id, phone, cnt), ' | ')
    into v_dup
    from (
      select store_id, phone, count(*) as cnt
        from public.customers
       where phone is not null and phone <> ''
       group by store_id, phone
      having count(*) > 1
    ) d;

  if v_dup is not null then
    raise exception 'พบเบอร์ลูกค้าซ้ำในร้านเดียวกัน ต้องรวมข้อมูลก่อนจึงจะสร้าง unique index ได้: %', v_dup;
  end if;
end $$;

-- (3) unique ต่อร้าน เฉพาะแถวที่มีเบอร์จริง (ลูกค้าที่ไม่มีเบอร์ยังสร้างได้ไม่จำกัด)
create unique index if not exists customers_store_phone_unique
  on public.customers (store_id, phone)
  where phone is not null and phone <> '';

comment on index public.customers_store_phone_unique is
  'กันเบอร์ซ้ำต่อร้าน — ถ้าซ้ำ findCustomerByIdentifier/createOrFindMemberCustomer จะพังถาวรต่อเบอร์นั้น';
