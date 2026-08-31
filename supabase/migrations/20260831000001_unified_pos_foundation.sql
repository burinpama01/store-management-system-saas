-- ============================================================
-- Task U2 (v0.35.2) — Unified POS Foundation
-- ตามแผน: Plan/QR Order Voice Unified POS Implementation Plan v2.html (Task U2)
--
-- เนื้อหา:
--   a) stores flags 3 ตัว: unified_pos_enabled / kitchen_queue_enabled / voice_command_enabled
--      (คอลัมน์ธรรมดาบน stores — staff อ่านได้ตาม RLS เดิม จึงใช้เช็คฝั่ง server ได้ทันที)
--   b) orders.revision — optimistic concurrency (client ห้ามเขียนทับ trigger override เสมอ)
--   c) order_items.fulfillment_status / fulfillment_version — canonical void ยังเป็น
--      voided/voided_reason เดิม (ไม่แตะ) ตาม U1 contracts (FULFILLMENT_STATUSES ห้ามมีค่า voided)
--   d) triggers: กัน client เขียนทับ revision/version + bump revision ของ parent order ทุกเส้นทาง
--   e) unified_pos_operation_receipts — idempotency tombstone (retention 30 วัน, purge เฉพาะ
--      result/payload ห้ามลบแถว) + purge function
--   f) voice_aliases — alias ต่อ store, unique lower(alias_text) (ห้ามเก็บ captured
--      phrase/transcript — ตารางนี้เก็บเฉพาะ alias ที่ร้านสร้างเอง)
--   g) grants ตาม convention เดิมของ repo
-- ============================================================

-- ------------------------------------------------------------
-- (a) Store flags
-- ------------------------------------------------------------
alter table public.stores
  add column if not exists unified_pos_enabled   boolean not null default false,
  add column if not exists kitchen_queue_enabled boolean not null default false,
  add column if not exists voice_command_enabled boolean not null default false;

-- ------------------------------------------------------------
-- (b) orders.revision — optimistic concurrency
-- ------------------------------------------------------------
alter table public.orders
  add column if not exists revision bigint not null default 0;

-- ------------------------------------------------------------
-- (c) order_items fulfillment columns
-- ------------------------------------------------------------
alter table public.order_items
  add column if not exists fulfillment_status  text not null default 'new',
  add column if not exists fulfillment_version bigint not null default 0;

-- enum ตรงกับ FULFILLMENT_STATUSES ใน src/modules/unified-pos/contracts.ts
-- (new | preparing | ready | served) — ห้ามเพิ่มค่า voided ลง enum นี้
alter table public.order_items
  add constraint order_items_fulfillment_status_check
  check (fulfillment_status in ('new','preparing','ready','served'));

-- ------------------------------------------------------------
-- (d) Triggers
-- ------------------------------------------------------------
-- orders.revision: INSERT -> 1, UPDATE -> OLD + 1
-- (client พยายาม set revision เองจะถูกเขียนทับด้วยค่าที่ถูกต้องเสมอ)
create or replace function public.unified_pos_orders_revision_bu()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.revision := 1;
  else
    new.revision := old.revision + 1;
  end if;
  return new;
end;
$$;

drop trigger if exists unified_pos_orders_revision_bu on public.orders;
create trigger unified_pos_orders_revision_bu
  before insert or update on public.orders
  for each row execute function public.unified_pos_orders_revision_bu();

-- order_items.fulfillment_version: INSERT -> 1, UPDATE -> OLD + 1
create or replace function public.unified_pos_items_version_bu()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.fulfillment_version := 1;
  else
    new.fulfillment_version := old.fulfillment_version + 1;
  end if;
  return new;
end;
$$;

drop trigger if exists unified_pos_items_version_bu on public.order_items;
create trigger unified_pos_items_version_bu
  before insert or update on public.order_items
  for each row execute function public.unified_pos_items_version_bu();

-- parent bump: เปลี่ยนแปลงใดๆ ของ order_item (INSERT/UPDATE/DELETE) ต้องบวก
-- revision ของ order แม่ +1 ทุกเส้นทาง (direct SQL / RPC / action)
-- SECURITY DEFINER เพื่อให้ bump สำเร็จแม้ caller ไม่มี UPDATE grant/policy บน orders
create or replace function public.unified_pos_items_parent_bump()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order_id uuid;
begin
  v_order_id := case when tg_op = 'DELETE' then old.order_id else new.order_id end;
  update public.orders
     set revision = revision + 1
   where id = v_order_id;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists unified_pos_items_parent_bump on public.order_items;
create trigger unified_pos_items_parent_bump
  after insert or update or delete on public.order_items
  for each row execute function public.unified_pos_items_parent_bump();

-- ------------------------------------------------------------
-- (e) unified_pos_operation_receipts — idempotency tombstone
--     การเขียนเกิดผ่าน SECURITY DEFINER RPC ใน U4-U7 เท่านั้น
--     (client ไม่มี policy เขียน — อ่านได้เฉพาะ store member)
-- ------------------------------------------------------------
create table public.unified_pos_operation_receipts (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null,
  store_id           uuid not null references public.stores(id) on delete cascade,
  operation_type     text not null,
  operation_key      text not null,
  request_hash       text not null,
  result             jsonb,
  targets            jsonb,
  payload            jsonb,
  payload_expires_at timestamptz not null default (now() + interval '30 days'),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint unified_pos_operation_receipts_store_operation_key_unique unique (store_id, operation_key)
);

alter table public.unified_pos_operation_receipts enable row level security;

create policy "unified_pos_operation_receipts: store member can read"
  on public.unified_pos_operation_receipts for select
  using (store_id in (select auth_user_store_ids()));

-- ไม่สร้าง policy INSERT/UPDATE/DELETE สำหรับ client (deny by default ภายใต้ RLS)

create trigger set_updated_at
  before update on public.unified_pos_operation_receipts
  for each row execute function set_updated_at();

-- purge เก่ากว่ากำหนด: เคลียร์เฉพาะ result/payload (tombstone: key/hash/type/targets คงอยู่)
-- คืนจำนวนแถวที่ purge — ห้ามลบแถว
create or replace function public.purge_expired_unified_pos_receipt_payloads()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_purged integer;
begin
  update public.unified_pos_operation_receipts
     set result = null,
         payload = null,
         updated_at = now()
   where payload_expires_at < now()
     and (result is not null or payload is not null);
  get diagnostics v_purged = row_count;
  return v_purged;
end;
$$;

-- ------------------------------------------------------------
-- (f) voice_aliases — alias ต่อ store (ร้านสร้างเอง, ไม่เก็บ transcript)
-- ------------------------------------------------------------
create table public.voice_aliases (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  store_id        uuid not null references public.stores(id) on delete cascade,
  alias_text      text not null,
  intent_type     text not null,
  slots           jsonb default '{}'::jsonb,
  is_active       boolean not null default true,
  created_by      uuid not null references auth.users(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- alias ซ้ำใน store เดียวกันไม่ได้ (case-insensitive)
create unique index voice_aliases_store_alias_text_lower_unique
  on public.voice_aliases (store_id, lower(alias_text));

alter table public.voice_aliases enable row level security;

create policy "voice_aliases: store member can read"
  on public.voice_aliases for select
  using (store_id in (select auth_user_store_ids()));

create policy "voice_aliases: manager+ can insert"
  on public.voice_aliases for insert
  with check (auth_user_role_in_store(organization_id, store_id, 'manager'));

create policy "voice_aliases: manager+ can update"
  on public.voice_aliases for update
  using (auth_user_role_in_store(organization_id, store_id, 'manager'))
  with check (auth_user_role_in_store(organization_id, store_id, 'manager'));

create policy "voice_aliases: manager+ can delete"
  on public.voice_aliases for delete
  using (auth_user_role_in_store(organization_id, store_id, 'manager'));

create trigger set_updated_at
  before update on public.voice_aliases
  for each row execute function set_updated_at();

-- ------------------------------------------------------------
-- (g) Grants ตาม convention เดิมของ repo
--     - receipts: anon ไม่เห็นเลย, authenticated อ่านได้ (เขียนผ่าน RPC เท่านั้น)
--     - voice_aliases: authenticated อ่าน/เขียนได้ตาม policy ข้างบน
--     - purge function: สำหรับ service_role (cron) เท่านั้น — ไม่ grant ให้ anon/authenticated
-- ------------------------------------------------------------
revoke all on public.unified_pos_operation_receipts from anon;
grant select on public.unified_pos_operation_receipts to authenticated;
grant select, insert, update, delete on public.voice_aliases to authenticated;
grant execute on function public.purge_expired_unified_pos_receipt_payloads() to service_role;
