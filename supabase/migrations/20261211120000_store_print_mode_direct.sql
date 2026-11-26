-- วิธีพิมพ์ระดับร้าน + กันตั๋วครัวซ้ำเมื่อพิมพ์ตรง (แผน POS Launcher Direct IP Printing v2 — เฟส D3)
--
-- print_mode:
--   'hub'    = เดิม: ทุกงานพิมพ์เข้าคิวคลาวด์ ให้ Print Hub บนเครื่องแคชเชียร์ดึงไปพิมพ์ (ค่าเริ่มต้นทุกร้าน)
--   'direct' = พิมพ์จากโปรแกรม StoreOS POS ตรงเข้าเครื่องพิมพ์ IP เท่านั้น — /api/print/enqueue ปฏิเสธทุกงาน
--              (iPad/มือถือ/จออื่นพิมพ์ไม่ได้ ตามที่ผู้ใช้เลือก)
--
-- print_direct_claims: ตั๋วครัว (ออเดอร์+สถานี) ถูกจอไหน "จอง" ไปพิมพ์แล้ว — แทน print_jobs.source_key
-- เดิมที่ใช้กันซ้ำในคิวคลาวด์ (เปิดหลายจอ/ยิงซ้ำก็ออกใบเดียว)

alter table public.stores
  add column if not exists print_mode text not null default 'hub'
    check (print_mode in ('hub', 'direct'));

comment on column public.stores.print_mode is
  'hub = คิวคลาวด์ + Print Hub (ค่าเริ่มต้น) / direct = พิมพ์ตรงจากโปรแกรม StoreOS POS เท่านั้น';

create table if not exists public.print_direct_claims (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  store_id        uuid not null references public.stores(id) on delete cascade,
  source_key      text not null check (length(source_key) <= 200),
  printer_id      uuid references public.printers(id) on delete set null,
  status          text not null default 'claimed' check (status in ('claimed', 'printed', 'unknown')),
  claimed_by      uuid references auth.users(id) on delete set null,
  claimed_at      timestamptz not null default now(),
  finished_at     timestamptz,
  error           text check (error is null or length(error) <= 300),
  unique (store_id, source_key)
);

comment on table public.print_direct_claims is
  'ตั๋วครัวที่ถูกจองพิมพ์ตรงจากโปรแกรม StoreOS POS (กันซ้ำข้ามจอ) — service role เท่านั้น';

create index if not exists print_direct_claims_store_time_idx on public.print_direct_claims (store_id, claimed_at desc);

alter table public.print_direct_claims enable row level security;
revoke all on public.print_direct_claims from anon, authenticated;
