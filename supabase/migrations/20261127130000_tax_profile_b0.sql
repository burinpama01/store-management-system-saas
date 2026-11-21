-- ============================================================
-- เฟส B0 — ข้อมูลภาษีของร้าน + เลขที่เอกสาร + สมุดคู่ค้า
-- (Plan/Tax Documents and Accounting Pack Plan v1.html หัวข้อ 4–5)
--
-- หลักการ
--   * ข้อมูลผู้ขายตามกฎหมาย (ม.86/4) แยกจาก receipt_settings — receipt_settings คือ "หน้าตาใบเสร็จ"
--     store_tax_profiles คือ "ตัวตนทางภาษี" ที่เอกสารภาษีจะ snapshot ไปเก็บ
--   * เลขที่เอกสารต้องไม่มีช่องว่าง: reserve_document_number() ใช้ row lock และ
--     ไม่ให้ผู้ใช้เรียกตรง (เรียกได้จาก RPC ออกเอกสารในเฟส B1 ซึ่งอยู่ในธุรกรรมเดียวกันเท่านั้น)
--   * ไม่แตะเส้นทางขาย/ใบเสร็จเดิม — ตารางใหม่ทั้งหมด
-- ============================================================

-- 1) ตัวตนทางภาษีต่อสาขา
create table if not exists public.store_tax_profiles (
  store_id           uuid primary key references public.stores(id) on delete cascade,
  organization_id    uuid not null references public.organizations(id) on delete cascade,
  legal_name         text not null check (btrim(legal_name) <> '' and char_length(legal_name) <= 200),
  tax_id             text not null check (tax_id ~ '^[0-9]{13}$'),
  branch_code        text not null default '00000' check (branch_code ~ '^[0-9]{5}$'),
  address            text not null check (btrim(address) <> '' and char_length(address) <= 500),
  vat_registered     boolean not null default false,
  vat_registered_at  date,
  -- เลขอนุมัติเครื่องบันทึกการเก็บเงิน (ภ.พ.06) — มีเมื่อร้านได้รับอนุมัติให้ออกใบกำกับภาษีอย่างย่อจาก POS
  pos_approval_no    text check (pos_approval_no is null or (btrim(pos_approval_no) <> '' and char_length(pos_approval_no) <= 60)),
  prices_include_vat boolean not null default true,
  vat_rate           numeric(5,2) not null default 7 check (vat_rate >= 0 and vat_rate <= 30),
  updated_by         uuid,
  updated_at         timestamptz not null default now(),
  check (vat_registered or vat_registered_at is null)
);

-- 2) ชุดเลขที่เอกสาร (หนึ่งแถว = ชนิดเอกสาร × งวดเดือน พ.ศ. ของสาขา)
create table if not exists public.document_sequences (
  store_id        uuid not null references public.stores(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  doc_type        text not null check (doc_type in (
    'tax_invoice', 'receipt_tax_invoice', 'credit_note', 'debit_note',
    'quotation', 'invoice', 'receipt', 'receipt_substitute', 'payment_voucher', 'wht_certificate'
  )),
  period          text not null check (period ~ '^[0-9]{4}-[0-9]{2}$'),  -- ปี พ.ศ.-เดือน เช่น 2569-11
  prefix          text not null check (prefix ~ '^[A-Z]{1,6}$'),
  next_no         int not null default 1 check (next_no >= 1),
  updated_at      timestamptz not null default now(),
  primary key (store_id, doc_type, period)
);

-- 3) สมุดคู่ค้า/ผู้ซื้อที่ขอใบกำกับภาษี
create table if not exists public.tax_parties (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  store_id        uuid not null references public.stores(id) on delete cascade,
  party_type      text not null default 'company' check (party_type in ('company', 'individual')),
  name            text not null check (btrim(name) <> '' and char_length(name) <= 200),
  tax_id          text check (tax_id is null or tax_id ~ '^[0-9]{13}$'),
  branch_code     text check (branch_code is null or branch_code ~ '^[0-9]{5}$'),
  address         text check (address is null or char_length(address) <= 500),
  email           text check (email is null or char_length(email) <= 200),
  phone           text check (phone is null or char_length(phone) <= 40),
  customer_id     uuid references public.customers(id) on delete set null,
  is_active       boolean not null default true,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists tax_parties_store_idx on public.tax_parties (store_id, is_active, name);
-- เลขผู้เสียภาษี + สาขา ซ้ำในร้านเดียวกันไม่ได้ (คนละสาขาของบริษัทเดียวกันได้)
create unique index if not exists tax_parties_store_tax_branch_unique_idx
  on public.tax_parties (store_id, tax_id, coalesce(branch_code, '00000'))
  where tax_id is not null;

-- ------------------------------------------------------------
-- กันข้ามร้าน
-- ------------------------------------------------------------
create or replace function public.enforce_tax_same_tenant()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid;
begin
  select organization_id into v_org from public.stores where id = new.store_id;
  if v_org is null or v_org is distinct from new.organization_id then
    raise exception 'store must belong to organization';
  end if;
  if tg_op = 'UPDATE' and (new.store_id is distinct from old.store_id or new.organization_id is distinct from old.organization_id) then
    raise exception 'store_id and organization_id are immutable';
  end if;
  if tg_table_name = 'tax_parties' and new.customer_id is not null and not exists (
    select 1 from public.customers c where c.id = new.customer_id and c.organization_id = new.organization_id
  ) then
    raise exception 'customer must belong to the same organization';
  end if;
  return new;
end;
$$;

drop trigger if exists store_tax_profiles_same_tenant on public.store_tax_profiles;
create trigger store_tax_profiles_same_tenant before insert or update on public.store_tax_profiles
  for each row execute function public.enforce_tax_same_tenant();
drop trigger if exists tax_parties_same_tenant on public.tax_parties;
create trigger tax_parties_same_tenant before insert or update on public.tax_parties
  for each row execute function public.enforce_tax_same_tenant();

-- ------------------------------------------------------------
-- RLS
-- ------------------------------------------------------------
alter table public.store_tax_profiles enable row level security;
alter table public.document_sequences enable row level security;
alter table public.tax_parties enable row level security;

-- ตัวตนทางภาษีพิมพ์บนเอกสารที่แคชเชียร์ออก → สมาชิกร้านอ่านได้ · แก้ได้เฉพาะ owner/admin (ข้อมูลทางกฎหมาย)
drop policy if exists "store_tax_profiles_member_select" on public.store_tax_profiles;
create policy "store_tax_profiles_member_select" on public.store_tax_profiles for select
  using (auth_user_role_in_store(organization_id, store_id, 'staff'));
drop policy if exists "store_tax_profiles_admin_insert" on public.store_tax_profiles;
create policy "store_tax_profiles_admin_insert" on public.store_tax_profiles for insert
  with check (auth_user_role_in_store(organization_id, store_id, 'admin'));
drop policy if exists "store_tax_profiles_admin_update" on public.store_tax_profiles;
create policy "store_tax_profiles_admin_update" on public.store_tax_profiles for update
  using (auth_user_role_in_store(organization_id, store_id, 'admin'))
  with check (auth_user_role_in_store(organization_id, store_id, 'admin'));
-- ไม่มี policy ลบ: เอกสารที่ออกไปแล้วอ้างอิงตัวตนนี้

-- ชุดเลข: manager อ่านได้ (ดูเลขล่าสุด) · ไม่มี policy เขียน — เลื่อนเลขผ่าน reserve_document_number() เท่านั้น
drop policy if exists "document_sequences_manager_select" on public.document_sequences;
create policy "document_sequences_manager_select" on public.document_sequences for select
  using (auth_user_role_in_store(organization_id, store_id, 'manager'));

-- สมุดผู้ซื้อ: แคชเชียร์ขึ้นไปใช้ตอนออกใบกำกับภาษีจากบิลขาย (B1) · ไม่มีการลบ (ปิดใช้งานแทน)
drop policy if exists "tax_parties_cashier_select" on public.tax_parties;
create policy "tax_parties_cashier_select" on public.tax_parties for select
  using (auth_user_role_in_store(organization_id, store_id, 'cashier'));
drop policy if exists "tax_parties_cashier_insert" on public.tax_parties;
create policy "tax_parties_cashier_insert" on public.tax_parties for insert
  with check (auth_user_role_in_store(organization_id, store_id, 'cashier'));
drop policy if exists "tax_parties_cashier_update" on public.tax_parties;
create policy "tax_parties_cashier_update" on public.tax_parties for update
  using (auth_user_role_in_store(organization_id, store_id, 'cashier'))
  with check (auth_user_role_in_store(organization_id, store_id, 'cashier'));

-- ------------------------------------------------------------
-- เลขที่เอกสาร: PREFIX + ปี พ.ศ. 2 หลัก + เดือน + "-" + ลำดับ 4 หลัก เช่น TIV6911-0001
-- งวดตามเวลาไทย (Asia/Bangkok) · row lock ทำให้ออกพร้อมกันหลายเครื่องไม่ชน/ไม่ข้าม
-- ไม่ grant ให้ authenticated: ถ้าเรียกตรงได้ เลขจะถูกจองโดยไม่มีเอกสาร = เลขขาดช่วง
-- RPC ออกเอกสาร (security definer, เฟส B1) เรียกฟังก์ชันนี้ในธุรกรรมเดียวกับการ insert เอกสาร
-- ------------------------------------------------------------
create or replace function public.document_default_prefix(p_doc_type text)
returns text
language sql
immutable
as $$
  select case p_doc_type
    when 'tax_invoice' then 'TIV'
    when 'receipt_tax_invoice' then 'RTV'
    when 'credit_note' then 'CN'
    when 'debit_note' then 'DN'
    when 'quotation' then 'QT'
    when 'invoice' then 'IV'
    when 'receipt' then 'RC'
    when 'receipt_substitute' then 'RS'
    when 'payment_voucher' then 'PV'
    when 'wht_certificate' then 'WHT'
  end;
$$;

create or replace function public.reserve_document_number(
  p_store_id uuid,
  p_doc_type text,
  p_at timestamptz default now()
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid;
  v_local timestamp := p_at at time zone 'Asia/Bangkok';
  v_be_year int := extract(year from v_local)::int + 543;
  v_month int := extract(month from v_local)::int;
  v_period text := v_be_year::text || '-' || lpad(v_month::text, 2, '0');
  v_prefix text := public.document_default_prefix(p_doc_type);
  v_no int;
begin
  if v_prefix is null then
    raise exception 'unknown document type';
  end if;
  select organization_id into v_org from public.stores where id = p_store_id;
  if v_org is null then
    raise exception 'store not found';
  end if;

  insert into public.document_sequences (store_id, organization_id, doc_type, period, prefix)
  values (p_store_id, v_org, p_doc_type, v_period, v_prefix)
  on conflict (store_id, doc_type, period) do nothing;

  update public.document_sequences
     set next_no = next_no + 1, updated_at = now()
   where store_id = p_store_id and doc_type = p_doc_type and period = v_period
  returning next_no - 1, prefix into v_no, v_prefix;

  if v_no > 9999 then
    -- เกิน 4 หลักยังออกได้ (ไม่ตัดเลข) แต่ความยาวเปลี่ยน — เลขยังเรียงและไม่ซ้ำ
    return v_prefix || right(v_be_year::text, 2) || lpad(v_month::text, 2, '0') || '-' || v_no::text;
  end if;
  return v_prefix || right(v_be_year::text, 2) || lpad(v_month::text, 2, '0') || '-' || lpad(v_no::text, 4, '0');
end;
$$;

revoke all on function public.reserve_document_number(uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.reserve_document_number(uuid, text, timestamptz) to service_role;
