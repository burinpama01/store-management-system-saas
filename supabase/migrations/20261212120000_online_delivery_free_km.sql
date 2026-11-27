-- สั่งออนไลน์: ส่งฟรีในระยะ X กม. แรก (เกินคิดเฉพาะส่วนที่เกิน) — 0 = ไม่มี (พฤติกรรมเดิม)
alter table public.store_online_order_settings
  add column if not exists delivery_free_km numeric(5,2) not null default 0
    check (delivery_free_km >= 0 and delivery_free_km <= 50);

comment on column public.store_online_order_settings.delivery_free_km is
  'ส่งฟรีในระยะกี่ กม. แรก (0 = ไม่มี) — เกินระยะนี้ค่าส่ง = ค่าเริ่มต้น + ค่าต่อ กม. × (ระยะ − delivery_free_km)';
