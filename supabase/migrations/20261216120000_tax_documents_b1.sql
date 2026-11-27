-- ============================================================
-- เฟส B1 — ใบเสร็จรับเงิน/ใบกำกับภาษี (เต็มรูป) จากบิลขาย + ใบลดหนี้ + ยกเลิกเอกสาร
-- (Plan/Tax Documents and Accounting Pack Plan v1.html หัวข้อ 4–5)
--
-- หลักการ
--   * สิทธิ์แพ็กเกจ: Enterprise (PlanFeatures.taxDocuments) + สวิตช์ต่อสาขา stores.tax_documents_enabled ปิดทุกร้าน
--   * เอกสารออกผ่าน RPC เท่านั้น (ไม่มี policy เขียน) — ตัวเลขทุกตัวคำนวณจากบิลใน DB ไม่เชื่อค่าจาก client
--   * เลขที่จองด้วย reserve_document_number() ในธุรกรรมเดียวกับ insert เอกสาร → ไม่ขาดช่วง
--   * เอกสารที่ออกแล้วแก้ไม่ได้: แก้ผิด = ยกเลิก (เลขยังอยู่) · คืนเงิน = ใบลดหนี้ (ม.86/10)
--   * บิลที่มีใบกำกับภาษีผูกอยู่: ห้าม void/คืนเงิน/แก้ยอด/void รายการ จนกว่าจะออกใบลดหนี้หรือยกเลิกเอกสาร
--   * B1 นี้รองรับเฉพาะราคารวม VAT (ร้านอาหาร) — ราคาแยก VAT ใช้กับเอกสาร B2B ในเฟส B2
--
-- ⚠ ตั้ง trigger บน orders/order_items (ตารางที่ทุกการขายเขียน) — ใช้ lock_timeout ให้ล้มเร็ว
--   แทนการรอ lock นานจนคิว checkout ค้าง ถ้าล้มให้รันซ้ำช่วงร้านปิด
-- ============================================================

set lock_timeout = '5s';

-- 1) สวิตช์ต่อสาขา
alter table public.stores
  add column if not exists tax_documents_enabled boolean not null default false;
comment on column public.stores.tax_documents_enabled is
  'เปิดออกใบกำกับภาษีเต็มรูป/ใบลดหนี้ (เฟส B1) — ปิดทุกร้าน เปิดหลังนักบัญชีตรวจแบบฟอร์มแล้ว';

-- 2) สิทธิ์แพ็กเกจฝั่ง DB — ให้ตรงกับ getPlanFeatures (taxDocuments = Enterprise เท่านั้น)
create or replace function public.organization_has_tax_documents(p_organization_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.subscriptions s
    where s.organization_id = p_organization_id
      and s.plan = 'enterprise'
      and s.status in ('active', 'trialing', 'past_due')
      and (
        (coalesce(s.enterprise_limited, false) = false and s.promo_trial_code is null)
        or s.current_period_end > now()
      )
  );
$$;

revoke all on function public.organization_has_tax_documents(uuid) from public;
revoke execute on function public.organization_has_tax_documents(uuid) from anon;
grant execute on function public.organization_has_tax_documents(uuid) to authenticated;
grant execute on function public.organization_has_tax_documents(uuid) to service_role;

create or replace function public.tax_documents_set_enabled(p_store_id uuid, p_enabled boolean)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;
  select organization_id into v_org from public.stores where id = p_store_id;
  if v_org is null then
    raise exception 'store not found';
  end if;
  if not public.auth_user_role_in_store(v_org, p_store_id, 'admin') then
    raise exception 'only owner/admin can toggle tax documents';
  end if;
  if coalesce(p_enabled, false) then
    if not public.organization_has_tax_documents(v_org) then
      raise exception 'tax documents require enterprise plan';
    end if;
    if not exists (select 1 from public.store_tax_profiles p where p.store_id = p_store_id and p.vat_registered) then
      raise exception 'tax profile must be VAT registered first';
    end if;
  end if;
  update public.stores set tax_documents_enabled = coalesce(p_enabled, false) where id = p_store_id;
  return coalesce(p_enabled, false);
end;
$$;

revoke all on function public.tax_documents_set_enabled(uuid, boolean) from public, anon;
grant execute on function public.tax_documents_set_enabled(uuid, boolean) to authenticated;
grant execute on function public.tax_documents_set_enabled(uuid, boolean) to service_role;

-- 3) เอกสารขาย (ทุกชนิดในอนาคตใช้ตารางนี้ — B1 ใช้ receipt_tax_invoice / credit_note)
create table if not exists public.sales_documents (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations(id) on delete cascade,
  store_id           uuid not null references public.stores(id) on delete cascade,
  doc_type           text not null check (doc_type in (
    'tax_invoice', 'receipt_tax_invoice', 'credit_note', 'debit_note', 'quotation', 'invoice', 'receipt'
  )),
  doc_no             text not null,
  issue_date         date not null,
  status             text not null default 'issued' check (status in ('issued', 'cancelled')),
  order_id           uuid references public.orders(id) on delete restrict,
  order_number       text,
  order_paid_at      timestamptz,
  ref_document_id    uuid references public.sales_documents(id) on delete restrict,
  party_id           uuid references public.tax_parties(id) on delete set null,
  seller_snapshot    jsonb not null,
  buyer_snapshot     jsonb not null,
  prices_include_vat boolean not null,
  vat_rate           numeric(5,2) not null,
  gross_amount       numeric(12,2) not null,
  discount_amount    numeric(12,2) not null default 0,
  total_amount       numeric(12,2) not null,   -- ยอดรวมทั้งสิ้น (รวม VAT)
  vat_base           numeric(12,2) not null,   -- มูลค่าก่อน VAT
  vat_amount         numeric(12,2) not null,
  -- ใบลดหนี้: มูลค่าตามใบกำกับเดิม / มูลค่าที่ถูกต้อง / ผลต่าง (ม.86/10)
  original_total     numeric(12,2),
  corrected_total    numeric(12,2),
  reason             text check (reason is null or char_length(reason) <= 500),
  cancelled_at       timestamptz,
  cancelled_by       uuid,
  cancel_reason      text check (cancel_reason is null or char_length(cancel_reason) <= 500),
  issued_by          uuid not null,
  created_at         timestamptz not null default now(),
  unique (store_id, doc_no),
  check (total_amount = vat_base + vat_amount),
  check (status = 'issued' or (cancelled_at is not null and cancel_reason is not null)),
  check (doc_type <> 'credit_note' or (ref_document_id is not null and reason is not null))
);
create index if not exists sales_documents_store_idx on public.sales_documents (store_id, created_at desc);
create index if not exists sales_documents_order_idx on public.sales_documents (order_id) where order_id is not null;
-- ใช้ใน trigger ทุกการขาย (order_has_active_tax_invoice) — partial ตรงเงื่อนไข ไม่ต้อง filter ต่อ
create index if not exists sales_documents_active_invoice_idx
  on public.sales_documents (order_id)
  where order_id is not null and status = 'issued' and doc_type in ('tax_invoice', 'receipt_tax_invoice');
create index if not exists sales_documents_ref_idx on public.sales_documents (ref_document_id) where ref_document_id is not null;
-- บิลหนึ่งใบมีใบกำกับภาษีเต็มรูปที่ใช้งานอยู่ได้ใบเดียว
create unique index if not exists sales_documents_one_active_invoice_per_order
  on public.sales_documents (order_id)
  where status = 'issued' and doc_type in ('tax_invoice', 'receipt_tax_invoice');
-- ใบกำกับหนึ่งใบมีใบลดหนี้ (เต็มจำนวน) ที่ใช้งานอยู่ได้ใบเดียว
create unique index if not exists sales_documents_one_active_credit_note
  on public.sales_documents (ref_document_id)
  where status = 'issued' and doc_type = 'credit_note';

create table if not exists public.sales_document_lines (
  id          uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.sales_documents(id) on delete cascade,
  line_no     int not null check (line_no >= 1),
  description text not null check (btrim(description) <> '' and char_length(description) <= 300),
  quantity    numeric(12,3) not null check (quantity > 0),
  unit_label  text check (unit_label is null or char_length(unit_label) <= 40),
  unit_price  numeric(12,2) not null,
  amount      numeric(12,2) not null,
  unique (document_id, line_no)
);

-- เอกสารที่ออกแล้วแก้ไม่ได้ ยกเว้นเปลี่ยนสถานะเป็นยกเลิก (ผ่าน RPC) · ห้ามลบ
create or replace function public.sales_documents_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'sales documents cannot be deleted (cancel instead)';
  end if;
  if old.status = 'cancelled' then
    raise exception 'cancelled document is final';
  end if;
  if (to_jsonb(new) - array['status', 'cancelled_at', 'cancelled_by', 'cancel_reason'])
     is distinct from (to_jsonb(old) - array['status', 'cancelled_at', 'cancelled_by', 'cancel_reason']) then
    raise exception 'issued sales document is immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists sales_documents_immutable on public.sales_documents;
create trigger sales_documents_immutable before update or delete on public.sales_documents
  for each row execute function public.sales_documents_guard();

create or replace function public.sales_document_lines_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'sales document lines are immutable';
end;
$$;

drop trigger if exists sales_document_lines_immutable on public.sales_document_lines;
create trigger sales_document_lines_immutable before update or delete on public.sales_document_lines
  for each row execute function public.sales_document_lines_guard();

-- ------------------------------------------------------------
-- RLS: อ่าน = แคชเชียร์ขึ้นไป (ออก/พิมพ์ซ้ำที่หน้าร้าน) · ไม่มี policy เขียน
-- ------------------------------------------------------------
alter table public.sales_documents enable row level security;
alter table public.sales_document_lines enable row level security;

drop policy if exists "sales_documents_cashier_select" on public.sales_documents;
create policy "sales_documents_cashier_select" on public.sales_documents for select
  using (auth_user_role_in_store(organization_id, store_id, 'cashier'));

drop policy if exists "sales_document_lines_cashier_select" on public.sales_document_lines;
create policy "sales_document_lines_cashier_select" on public.sales_document_lines for select
  using (exists (
    select 1 from public.sales_documents d
    where d.id = document_id and auth_user_role_in_store(d.organization_id, d.store_id, 'cashier')
  ));

-- ------------------------------------------------------------
-- กันแก้บิลที่มีใบกำกับภาษีผูกอยู่ (ครอบทุกเส้นทาง void/คืนเงิน/แก้ยอด ที่มีอยู่และจะมี)
-- "ผูกอยู่" = มีใบกำกับเต็มรูปสถานะ issued ที่ยังไม่มีใบลดหนี้ issued อ้างถึง
-- ------------------------------------------------------------
create or replace function public.order_has_active_tax_invoice(p_order_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.sales_documents d
    where d.order_id = p_order_id
      and d.status = 'issued'
      and d.doc_type in ('tax_invoice', 'receipt_tax_invoice')
      and not exists (
        select 1 from public.sales_documents c
        where c.ref_document_id = d.id and c.status = 'issued' and c.doc_type = 'credit_note'
      )
  );
$$;

revoke all on function public.order_has_active_tax_invoice(uuid) from public, anon, authenticated;
grant execute on function public.order_has_active_tax_invoice(uuid) to service_role;

create or replace function public.orders_tax_invoice_lock()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if (new.status is distinct from old.status
      or new.total is distinct from old.total
      or new.subtotal is distinct from old.subtotal
      or new.discount is distinct from old.discount)
     and public.order_has_active_tax_invoice(old.id) then
    raise exception 'order has an issued tax invoice — issue a credit note or cancel the tax invoice first';
  end if;
  return new;
end;
$$;

drop trigger if exists orders_tax_invoice_lock on public.orders;
create trigger orders_tax_invoice_lock before update of status, total, subtotal, discount on public.orders
  for each row execute function public.orders_tax_invoice_lock();

create or replace function public.order_items_tax_invoice_lock()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order uuid;
begin
  -- แยกตาม tg_op: ห้ามแตะ NEW ใน DELETE / OLD ใน INSERT
  if tg_op = 'DELETE' then
    v_order := old.order_id;
  elsif tg_op = 'INSERT' then
    v_order := new.order_id;
  else
    if new.voided is not distinct from old.voided
       and new.quantity is not distinct from old.quantity
       and new.total_price is not distinct from old.total_price
       and new.unit_price is not distinct from old.unit_price
       and new.order_id is not distinct from old.order_id then
      return new;  -- เช่น อัปเดตสถานะครัว — ไม่เกี่ยวกับยอด
    end if;
    v_order := old.order_id;
  end if;
  if public.order_has_active_tax_invoice(v_order) then
    raise exception 'order has an issued tax invoice — issue a credit note or cancel the tax invoice first';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists order_items_tax_invoice_lock on public.order_items;
create trigger order_items_tax_invoice_lock before insert or update or delete on public.order_items
  for each row execute function public.order_items_tax_invoice_lock();

-- ------------------------------------------------------------
-- ด่านร่วม: สิทธิ์ + แพ็ก + สวิตช์ + ข้อมูลภาษี
-- ------------------------------------------------------------
create or replace function public.tax_documents_assert_ready(p_org uuid, p_store uuid, p_min_role text)
returns public.store_tax_profiles
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile public.store_tax_profiles%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;
  if not public.auth_user_role_in_store(p_org, p_store, p_min_role) then
    raise exception 'not allowed to manage tax documents';
  end if;
  if not public.organization_has_tax_documents(p_org) then
    raise exception 'tax documents require enterprise plan';
  end if;
  if not exists (select 1 from public.stores where id = p_store and tax_documents_enabled) then
    raise exception 'tax documents are not enabled for this store';
  end if;
  select * into v_profile from public.store_tax_profiles where store_id = p_store;
  if not found or not v_profile.vat_registered then
    raise exception 'tax profile must be VAT registered first';
  end if;
  return v_profile;
end;
$$;

revoke all on function public.tax_documents_assert_ready(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.tax_documents_assert_ready(uuid, uuid, text) to service_role;

-- ------------------------------------------------------------
-- RPC: ออกใบเสร็จรับเงิน/ใบกำกับภาษีจากบิลที่ชำระแล้ว
-- ------------------------------------------------------------
create or replace function public.issue_tax_invoice_from_order(p_order_id uuid, p_party_id uuid)
returns public.sales_documents
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders%rowtype;
  v_party public.tax_parties%rowtype;
  v_profile public.store_tax_profiles%rowtype;
  v_doc public.sales_documents%rowtype;
  v_gross numeric;
  v_total numeric;
  v_vat numeric;
  v_line_count int;
  v_doc_no text;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'order not found';
  end if;

  v_profile := public.tax_documents_assert_ready(v_order.organization_id, v_order.store_id, 'cashier');

  if not v_profile.prices_include_vat then
    raise exception 'order-based tax invoice requires VAT-inclusive prices';
  end if;
  if v_order.status <> 'paid' then
    raise exception 'order must be paid';
  end if;
  if v_order.total is null or v_order.total <= 0 then
    raise exception 'order total must be positive';
  end if;

  select * into v_party from public.tax_parties where id = p_party_id;
  if not found or v_party.store_id <> v_order.store_id or not v_party.is_active then
    raise exception 'buyer not found';
  end if;
  if v_party.address is null or btrim(v_party.address) = '' then
    raise exception 'buyer address is required';
  end if;
  if v_party.party_type = 'company' and v_party.tax_id is null then
    raise exception 'company buyer requires tax id';
  end if;

  if exists (
    select 1 from public.sales_documents d
    where d.order_id = v_order.id and d.status = 'issued' and d.doc_type in ('tax_invoice', 'receipt_tax_invoice')
  ) then
    raise exception 'order already has an issued tax invoice';
  end if;

  select count(*), coalesce(sum(total_price), 0) into v_line_count, v_gross
    from public.order_items where order_id = v_order.id and coalesce(voided, false) = false;
  if v_line_count = 0 then
    raise exception 'order has no items';
  end if;

  v_total := round(v_order.total, 2);
  v_vat := round(v_total * v_profile.vat_rate / (100 + v_profile.vat_rate), 2);
  v_doc_no := public.reserve_document_number(v_order.store_id, 'receipt_tax_invoice', now());

  insert into public.sales_documents (
    organization_id, store_id, doc_type, doc_no, issue_date, order_id, order_number, order_paid_at,
    party_id, seller_snapshot, buyer_snapshot, prices_include_vat, vat_rate,
    gross_amount, discount_amount, total_amount, vat_base, vat_amount, issued_by
  ) values (
    v_order.organization_id, v_order.store_id, 'receipt_tax_invoice', v_doc_no,
    (now() at time zone 'Asia/Bangkok')::date, v_order.id, v_order.order_number, v_order.paid_at,
    v_party.id,
    jsonb_build_object(
      'legalName', v_profile.legal_name, 'taxId', v_profile.tax_id,
      'branchCode', v_profile.branch_code, 'address', v_profile.address
    ),
    jsonb_build_object(
      'name', v_party.name, 'taxId', v_party.tax_id, 'branchCode', v_party.branch_code,
      'address', v_party.address, 'partyType', v_party.party_type
    ),
    true, v_profile.vat_rate,
    round(v_gross, 2), greatest(round(v_gross - v_total, 2), 0), v_total, v_total - v_vat, v_vat, auth.uid()
  ) returning * into v_doc;

  insert into public.sales_document_lines (document_id, line_no, description, quantity, unit_label, unit_price, amount)
  select v_doc.id,
         row_number() over (order by oi.id),
         left(
           oi.product_name
             || coalesce(' (' || nullif(oi.variant_name, '') || ')', '')
             || coalesce(' — ' || nullif((select string_agg(m->'option'->>'name', ', ')
                                          from jsonb_array_elements(case when jsonb_typeof(oi.modifiers) = 'array' then oi.modifiers else '[]'::jsonb end) m
                                         where jsonb_typeof(m->'option') = 'object' and nullif(m->'option'->>'name', '') is not null), ''), ''),
           300
         ),
         oi.quantity,
         nullif(oi.unit_name, ''),
         oi.unit_price,
         oi.total_price
    from public.order_items oi
   where oi.order_id = v_order.id and coalesce(oi.voided, false) = false;

  -- ยอดรวมรายการบนเอกสารต้องตรงกับ "รวมเป็นเงิน" เสมอ
  if (select coalesce(sum(amount), 0) from public.sales_document_lines where document_id = v_doc.id) <> v_doc.gross_amount then
    raise exception 'document lines do not match gross amount';
  end if;

  return v_doc;
end;
$$;

revoke all on function public.issue_tax_invoice_from_order(uuid, uuid) from public, anon;
grant execute on function public.issue_tax_invoice_from_order(uuid, uuid) to authenticated;
grant execute on function public.issue_tax_invoice_from_order(uuid, uuid) to service_role;

-- ------------------------------------------------------------
-- RPC: ใบลดหนี้เต็มจำนวน (ยกเลิกการขายทั้งบิล/คืนเงินทั้งหมด) — manager ขึ้นไป
-- หลังออกใบลดหนี้ บิลจะ void/คืนเงินในระบบ POS ได้ตามปกติ
-- ------------------------------------------------------------
create or replace function public.issue_full_credit_note(p_document_id uuid, p_reason text)
returns public.sales_documents
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_src public.sales_documents%rowtype;
  v_profile public.store_tax_profiles%rowtype;
  v_doc public.sales_documents%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_doc_no text;
begin
  select * into v_src from public.sales_documents where id = p_document_id for update;
  if not found then
    raise exception 'document not found';
  end if;
  v_profile := public.tax_documents_assert_ready(v_src.organization_id, v_src.store_id, 'manager');

  if v_src.doc_type not in ('tax_invoice', 'receipt_tax_invoice') or v_src.status <> 'issued' then
    raise exception 'credit note requires an issued tax invoice';
  end if;
  if v_reason is null or char_length(v_reason) > 500 then
    raise exception 'credit note requires a reason';
  end if;
  if exists (
    select 1 from public.sales_documents c
    where c.ref_document_id = v_src.id and c.status = 'issued' and c.doc_type = 'credit_note'
  ) then
    raise exception 'tax invoice already has a credit note';
  end if;

  v_doc_no := public.reserve_document_number(v_src.store_id, 'credit_note', now());

  insert into public.sales_documents (
    organization_id, store_id, doc_type, doc_no, issue_date, order_id, order_number, order_paid_at,
    ref_document_id, party_id, seller_snapshot, buyer_snapshot, prices_include_vat, vat_rate,
    gross_amount, discount_amount, total_amount, vat_base, vat_amount,
    original_total, corrected_total, reason, issued_by
  ) values (
    v_src.organization_id, v_src.store_id, 'credit_note', v_doc_no,
    (now() at time zone 'Asia/Bangkok')::date, v_src.order_id, v_src.order_number, v_src.order_paid_at,
    v_src.id, v_src.party_id,
    -- ผู้ขาย/ผู้ซื้อใช้ตามใบกำกับเดิม ให้สองเอกสารอ้างถึงคู่สัญญาเดียวกัน
    v_src.seller_snapshot,
    v_src.buyer_snapshot, v_src.prices_include_vat, v_src.vat_rate,
    v_src.total_amount, 0, v_src.total_amount, v_src.vat_base, v_src.vat_amount,
    -- ม.86/10: มูลค่าสินค้าตามใบกำกับเดิม / มูลค่าที่ถูกต้อง เป็นยอด "ก่อนภาษี" — ลดเต็มจำนวน = 0
    v_src.vat_base, 0, v_reason, auth.uid()
  ) returning * into v_doc;

  insert into public.sales_document_lines (document_id, line_no, description, quantity, unit_label, unit_price, amount)
  values (v_doc.id, 1, left('ลดหนี้เต็มจำนวนตามใบกำกับภาษีเลขที่ ' || v_src.doc_no, 300), 1, null, v_src.total_amount, v_src.total_amount);

  return v_doc;
end;
$$;

revoke all on function public.issue_full_credit_note(uuid, text) from public, anon;
grant execute on function public.issue_full_credit_note(uuid, text) to authenticated;
grant execute on function public.issue_full_credit_note(uuid, text) to service_role;

-- ------------------------------------------------------------
-- RPC: ยกเลิกเอกสาร (ออกผิด เช่น ชื่อผู้ซื้อผิด) — manager ขึ้นไป · เลขที่ยังอยู่ ไม่นำกลับมาใช้
-- ยกเลิกใบกำกับที่มีใบลดหนี้ใช้งานอยู่ไม่ได้ (ต้องยกเลิกใบลดหนี้ก่อน)
-- ------------------------------------------------------------
create or replace function public.cancel_sales_document(p_document_id uuid, p_reason text)
returns public.sales_documents
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_doc public.sales_documents%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  select * into v_doc from public.sales_documents where id = p_document_id for update;
  if not found then
    raise exception 'document not found';
  end if;
  perform public.tax_documents_assert_ready(v_doc.organization_id, v_doc.store_id, 'manager');
  if v_doc.status <> 'issued' then
    raise exception 'document already cancelled';
  end if;
  if v_reason is null or char_length(v_reason) > 500 then
    raise exception 'cancellation requires a reason';
  end if;
  if exists (
    select 1 from public.sales_documents c
    where c.ref_document_id = v_doc.id and c.status = 'issued'
  ) then
    raise exception 'cancel the related credit note first';
  end if;

  update public.sales_documents
     set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(), cancel_reason = v_reason
   where id = v_doc.id
  returning * into v_doc;
  return v_doc;
end;
$$;

revoke all on function public.cancel_sales_document(uuid, text) from public, anon;
grant execute on function public.cancel_sales_document(uuid, text) to authenticated;
grant execute on function public.cancel_sales_document(uuid, text) to service_role;
