-- U0.5 — pgTAP smoke test สำหรับ Supabase local stack
-- รันด้วย: supabase test db --local
-- มาตรฐาน pgTAP: เปิด transaction, plan จำนวน assert, ปิดด้วย finish() + ROLLBACK
BEGIN;
SELECT plan(3);
SELECT has_schema('public');
SELECT has_table('stores', 'public');
SELECT has_table('orders', 'public');
SELECT * FROM finish();
ROLLBACK;
