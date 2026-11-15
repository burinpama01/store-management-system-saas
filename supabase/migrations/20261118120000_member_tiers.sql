-- ระดับสมาชิกแบบ Shopee Rewards · P2a (Plan/Prepaid Pass and Member Tiers Implementation Plan v1.html)
--
-- ผู้ใช้ตัดสินใจ 2026-11-15:
--   T1 เจ้าของเลือกวิธีวัด: ยอดซื้อ / จำนวนบิล / ต้องถึงทั้งสอง (แบบ Shopee) / ถึงอย่างใดอย่างหนึ่ง
--   T2 ลดระดับแบบ Shopee: นับเป็นรอบ ขึ้นระดับทันทีเมื่อถึงเกณฑ์ ครบรอบไม่ถึงเกณฑ์ระดับปัจจุบัน → ลด
--   T4 Enterprise เท่านั้น (ตรวจฝั่ง server action)
--   T5 ตอนเปิดใช้ เจ้าของเลือก เริ่มจากศูนย์ หรือ คำนวณจากยอดย้อนหลัง (ดูตัวอย่างก่อนยืนยัน)
--
-- นับยอดต่อ "ตัวตนสมาชิก" (member_identities = เบอร์เดียวกันทั้งองค์กร) จาก
--   - ออเดอร์ที่จ่ายแล้ว (ยอด total หลังส่วนลด, นับบิลเฉพาะยอด > 0 — บิลใช้แพ็กทั้งบิล ฿0 ไม่นับ)
--   - ซื้อแพ็กออนไลน์ (ซื้อแพ็กที่ POS นับผ่านออเดอร์อยู่แล้ว)
--   ออเดอร์ถูก void/ยกเลิก → แถวหักยอดคืน (ไม่ลดระดับทันที ไปตัดสินตอนครบรอบ)
-- แต้มสะสมเดิมไม่เกี่ยวและไม่ถูกรีเซ็ต

-- ---------------------------------------------------------------------------
-- รอบ: ปฏิทินเวลาไทย แบ่งตามจำนวนเดือน (3 = ไตรมาส, 6 = ม.ค.–มิ.ย./ก.ค.–ธ.ค., 12 = ปีปฏิทิน)
-- ---------------------------------------------------------------------------
create or replace function public.member_tier_cycle_start(p_at timestamptz, p_months integer)
returns date
language sql
stable
set search_path = public
as $$
  select make_date(
    extract(year from (p_at at time zone 'Asia/Bangkok'))::int,
    (((extract(month from (p_at at time zone 'Asia/Bangkok'))::int - 1) / p_months) * p_months) + 1,
    1
  )
$$;

-- ---------------------------------------------------------------------------
-- ตาราง
-- ---------------------------------------------------------------------------
create table if not exists public.member_tier_programs (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  is_enabled boolean not null default false,
  metric_mode text not null default 'both' check (metric_mode in ('spend', 'orders', 'both', 'either')),
  cycle_months integer not null default 6 check (cycle_months in (3, 6, 12)),
  downgrade_one_step boolean not null default false,
  initial_mode text check (initial_mode in ('zero', 'backfill')),
  initialized_at timestamptz,
  updated_by uuid,
  updated_at timestamptz not null default now()
);

create table if not exists public.member_tiers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  rank integer not null check (rank between 0 and 5),
  name text not null check (length(trim(name)) between 1 and 40),
  color text not null default '#8a4b1f' check (color ~ '^#[0-9a-fA-F]{6}$'),
  min_spend numeric(12,2) not null default 0 check (min_spend >= 0),
  min_orders integer not null default 0 check (min_orders >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, rank)
);

create table if not exists public.member_tier_status (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  member_identity_id uuid not null references public.member_identities(id) on delete cascade,
  tier_rank integer not null default 0,
  achieved_at timestamptz not null default now(),
  cycle_start date not null,
  cycle_spend numeric(14,2) not null default 0,
  cycle_orders integer not null default 0,
  locked boolean not null default false,
  lock_note text,
  updated_at timestamptz not null default now(),
  primary key (member_identity_id)
);

create index if not exists member_tier_status_org_idx on public.member_tier_status (organization_id, cycle_start);

create table if not exists public.member_tier_activity (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  member_identity_id uuid not null references public.member_identities(id) on delete cascade,
  source_type text not null check (source_type in ('order', 'pass_purchase')),
  source_id uuid not null,
  kind text not null check (kind in ('sale', 'reversal')),
  spend_delta numeric(14,2) not null,
  orders_delta integer not null,
  cycle_start date not null,
  created_at timestamptz not null default now(),
  unique (source_type, source_id, kind)
);

create index if not exists member_tier_activity_identity_idx
  on public.member_tier_activity (member_identity_id, created_at desc);

create table if not exists public.member_tier_events (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  member_identity_id uuid not null references public.member_identities(id) on delete cascade,
  type text not null check (type in ('upgrade', 'downgrade', 'retain', 'manual', 'initial')),
  from_rank integer,
  to_rank integer not null,
  cycle_start date,
  cycle_spend numeric(14,2),
  cycle_orders integer,
  actor_user_id uuid,
  note text,
  created_at timestamptz not null default now()
);

create index if not exists member_tier_events_identity_idx
  on public.member_tier_events (member_identity_id, created_at desc);

-- คำนวณย้อนหลังตอนเปิดใช้ (initialize_member_tiers) อ่านออเดอร์ที่จ่ายแล้วทั้งองค์กร 2 รอบล่าสุด
create index if not exists orders_org_paid_at_idx
  on public.orders (organization_id, paid_at)
  where status = 'paid';

-- ---------------------------------------------------------------------------
-- RLS: อ่านได้ในองค์กร; เขียนผ่าน RPC/trigger เท่านั้น
-- ---------------------------------------------------------------------------
alter table public.member_tier_programs enable row level security;
alter table public.member_tiers enable row level security;
alter table public.member_tier_status enable row level security;
alter table public.member_tier_activity enable row level security;
alter table public.member_tier_events enable row level security;

revoke all on table public.member_tier_programs from anon, authenticated;
revoke all on table public.member_tiers from anon, authenticated;
revoke all on table public.member_tier_status from anon, authenticated;
revoke all on table public.member_tier_activity from anon, authenticated;
revoke all on table public.member_tier_events from anon, authenticated;
grant select on table public.member_tier_programs to authenticated;
grant select on table public.member_tiers to authenticated;
grant select on table public.member_tier_status to authenticated;
grant select on table public.member_tier_events to authenticated;

drop policy if exists "member_tier_programs: org member can read" on public.member_tier_programs;
create policy "member_tier_programs: org member can read" on public.member_tier_programs for select
  using (organization_id in (select s.organization_id from public.stores s where s.id in (select auth_user_store_ids())));
drop policy if exists "member_tiers: org member can read" on public.member_tiers;
create policy "member_tiers: org member can read" on public.member_tiers for select
  using (organization_id in (select s.organization_id from public.stores s where s.id in (select auth_user_store_ids())));
drop policy if exists "member_tier_status: org member can read" on public.member_tier_status;
create policy "member_tier_status: org member can read" on public.member_tier_status for select
  using (organization_id in (select s.organization_id from public.stores s where s.id in (select auth_user_store_ids())));
drop policy if exists "member_tier_events: org member can read" on public.member_tier_events;
create policy "member_tier_events: org member can read" on public.member_tier_events for select
  using (organization_id in (select s.organization_id from public.stores s where s.id in (select auth_user_store_ids())));

-- ---------------------------------------------------------------------------
-- ระดับสูงสุดที่ยอดนี้ถึง ตามวิธีวัดของร้าน
-- ---------------------------------------------------------------------------
create or replace function public.member_tier_rank_for(p_org uuid, p_spend numeric, p_orders integer)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(max(t.rank), 0)
    from public.member_tiers t
    join public.member_tier_programs p on p.organization_id = t.organization_id
   where t.organization_id = p_org
     and case p.metric_mode
           when 'spend' then coalesce(p_spend, 0) >= t.min_spend
           when 'orders' then coalesce(p_orders, 0) >= t.min_orders
           when 'either' then coalesce(p_spend, 0) >= t.min_spend or coalesce(p_orders, 0) >= t.min_orders
           else coalesce(p_spend, 0) >= t.min_spend and coalesce(p_orders, 0) >= t.min_orders
         end
$$;

-- ---------------------------------------------------------------------------
-- ครบรอบ: ตัดสินระดับจากยอดของรอบที่จบ แล้วเริ่มนับรอบใหม่ (เรียกจาก cron และก่อนบันทึกยอดทุกครั้ง)
-- ถ้าเว้นหลายรอบ (ไม่มีกิจกรรม) รอบที่ว่างถือยอด 0
-- ---------------------------------------------------------------------------
create or replace function public.member_tier_rollover(p_identity uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status public.member_tier_status%rowtype;
  v_program public.member_tier_programs%rowtype;
  v_current date;
  v_cycle date;
  v_spend numeric;
  v_orders integer;
  v_met integer;
  v_new integer;
begin
  select * into v_status from public.member_tier_status where member_identity_id = p_identity for update;
  if not found then return; end if;
  -- for share: ถ้าเจ้าของกำลังบันทึกเกณฑ์ใหม่ (save ล็อก for update) ให้รอจนบันทึกเสร็จ — ประเมินด้วยเกณฑ์ชุดเดียว
  select * into v_program from public.member_tier_programs where organization_id = v_status.organization_id for share;
  if not found then return; end if;

  v_current := public.member_tier_cycle_start(now(), v_program.cycle_months);
  if v_status.cycle_start >= v_current then return; end if;

  v_cycle := v_status.cycle_start;
  v_spend := v_status.cycle_spend;
  v_orders := v_status.cycle_orders;
  v_new := v_status.tier_rank;

  while v_cycle < v_current loop
    if not v_status.locked then
      v_met := public.member_tier_rank_for(v_status.organization_id, v_spend, v_orders);
      if v_met >= v_new then
        insert into public.member_tier_events (organization_id, member_identity_id, type, from_rank, to_rank, cycle_start, cycle_spend, cycle_orders, note)
        values (v_status.organization_id, p_identity, 'retain', v_new, v_new, v_cycle, v_spend, v_orders, 'ครบรอบ ยอดถึงเกณฑ์ระดับเดิม');
      else
        insert into public.member_tier_events (organization_id, member_identity_id, type, from_rank, to_rank, cycle_start, cycle_spend, cycle_orders, note)
        values (
          v_status.organization_id, p_identity, 'downgrade', v_new,
          case when v_program.downgrade_one_step then greatest(v_met, v_new - 1) else v_met end,
          v_cycle, v_spend, v_orders, 'ครบรอบ ยอดไม่ถึงเกณฑ์ระดับเดิม'
        );
        v_new := case when v_program.downgrade_one_step then greatest(v_met, v_new - 1) else v_met end;
      end if;
    end if;
    v_cycle := (v_cycle + make_interval(months => v_program.cycle_months))::date;
    v_spend := 0;
    v_orders := 0;
  end loop;

  update public.member_tier_status
     set tier_rank = v_new,
         achieved_at = case when v_new <> v_status.tier_rank then now() else achieved_at end,
         cycle_start = v_current,
         cycle_spend = 0,
         cycle_orders = 0,
         updated_at = now()
   where member_identity_id = p_identity;
end;
$$;

-- ---------------------------------------------------------------------------
-- บันทึกยอด (idempotent ต่อ source+kind) → ขึ้นระดับทันทีเมื่อถึงเกณฑ์
-- ---------------------------------------------------------------------------
create or replace function public.record_member_tier_activity(
  p_identity uuid,
  p_source_type text,
  p_source_id uuid,
  p_kind text,
  p_spend numeric,
  p_orders integer,
  p_occurred_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_program public.member_tier_programs%rowtype;
  v_cycle date;
  v_inserted bigint;
  v_status public.member_tier_status%rowtype;
  v_met integer;
begin
  select organization_id into v_org from public.member_identities where id = p_identity;
  if v_org is null then return; end if;
  select * into v_program from public.member_tier_programs where organization_id = v_org;
  if not found or not v_program.is_enabled or v_program.initialized_at is null then return; end if;

  v_cycle := public.member_tier_cycle_start(coalesce(p_occurred_at, now()), v_program.cycle_months);

  insert into public.member_tier_activity (organization_id, member_identity_id, source_type, source_id, kind, spend_delta, orders_delta, cycle_start)
  values (v_org, p_identity, p_source_type, p_source_id, p_kind, p_spend, p_orders, v_cycle)
  on conflict (source_type, source_id, kind) do nothing
  returning id into v_inserted;
  if v_inserted is null then return; end if;

  insert into public.member_tier_status (organization_id, member_identity_id, tier_rank, cycle_start)
  values (v_org, p_identity, 0, public.member_tier_cycle_start(now(), v_program.cycle_months))
  on conflict (member_identity_id) do nothing;

  perform public.member_tier_rollover(p_identity);

  select * into v_status from public.member_tier_status where member_identity_id = p_identity for update;
  -- ยอดของรอบที่จบไปแล้ว (เช่น void บิลเดือนก่อน) ไม่ย้อนแก้ระดับ — เก็บไว้เป็นประวัติอย่างเดียว
  if v_cycle <> v_status.cycle_start then return; end if;

  update public.member_tier_status
     set cycle_spend = greatest(0, cycle_spend + p_spend),
         cycle_orders = greatest(0, cycle_orders + p_orders),
         updated_at = now()
   where member_identity_id = p_identity
  returning * into v_status;

  if p_kind = 'sale' and not v_status.locked then
    v_met := public.member_tier_rank_for(v_org, v_status.cycle_spend, v_status.cycle_orders);
    if v_met > v_status.tier_rank then
      update public.member_tier_status set tier_rank = v_met, achieved_at = now(), updated_at = now()
       where member_identity_id = p_identity;
      insert into public.member_tier_events (organization_id, member_identity_id, type, from_rank, to_rank, cycle_start, cycle_spend, cycle_orders, note)
      values (v_org, p_identity, 'upgrade', v_status.tier_rank, v_met, v_status.cycle_start, v_status.cycle_spend, v_status.cycle_orders, 'ยอดถึงเกณฑ์ ขึ้นระดับทันที');
    end if;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- trigger: ออเดอร์ paid → +ยอด; void/ยกเลิก/คืนเงินหลังจ่าย → หักยอดคืน
-- ไม่มีการ raise เด็ดขาด: ระบบระดับต้องไม่ทำให้การชำระเงิน/void ล้ม
-- ---------------------------------------------------------------------------
create or replace function public.member_tiers_on_order_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_identity uuid;
  v_sale public.member_tier_activity%rowtype;
begin
  if new.status is not distinct from old.status or new.customer_id is null then
    return new;
  end if;
  if not exists (select 1 from public.member_tier_programs where organization_id = new.organization_id and is_enabled) then
    return new;
  end if;
  select member_identity_id into v_identity from public.customers where id = new.customer_id;
  if v_identity is null then return new; end if;

  begin
    if new.status = 'paid' and coalesce(new.total, 0) > 0 then
      perform public.record_member_tier_activity(v_identity, 'order', new.id, 'sale', new.total, 1, coalesce(new.paid_at, now()));
    elsif new.status in ('voided', 'cancelled', 'refunded') and old.status = 'paid' then
      select * into v_sale from public.member_tier_activity
       where source_type = 'order' and source_id = new.id and kind = 'sale';
      if found then
        perform public.record_member_tier_activity(v_identity, 'order', new.id, 'reversal', -v_sale.spend_delta, -v_sale.orders_delta, coalesce(new.paid_at, now()));
      end if;
    end if;
  exception when others then
    raise warning 'member tier activity skipped for order %: %', new.id, sqlerrm;
  end;
  return new;
end;
$$;

drop trigger if exists member_tiers_on_order_status on public.orders;
create trigger member_tiers_on_order_status
  after update of status on public.orders
  for each row execute function public.member_tiers_on_order_status();

-- ซื้อแพ็กออนไลน์ (ไม่มีออเดอร์) → +ยอด
create or replace function public.member_tiers_on_pass_purchase_paid()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'paid' and old.status is distinct from 'paid' then
    begin
      perform public.record_member_tier_activity(new.member_identity_id, 'pass_purchase', new.id, 'sale', new.amount, 1, now());
    exception when others then
      raise warning 'member tier activity skipped for pass purchase %: %', new.id, sqlerrm;
    end;
  end if;
  return new;
end;
$$;

drop trigger if exists member_tiers_on_pass_purchase_paid on public.prepaid_pass_purchases;
create trigger member_tiers_on_pass_purchase_paid
  after update of status on public.prepaid_pass_purchases
  for each row execute function public.member_tiers_on_pass_purchase_paid();

-- ---------------------------------------------------------------------------
-- ตั้งค่าโปรแกรม + ระดับ (owner/admin) — แก้กลางรอบได้ มีผลกับการประเมินครั้งถัดไป ไม่ลดใครทันที
-- p_tiers: [{ "rank": 0, "name": "Member", "color": "#...", "min_spend": 0, "min_orders": 0 }, ...]
-- ---------------------------------------------------------------------------
create or replace function public.save_member_tier_program(
  p_store_id uuid,
  p_metric_mode text,
  p_cycle_months integer,
  p_downgrade_one_step boolean,
  p_tiers jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_count integer;
  v_initialized timestamptz;
begin
  select organization_id into v_org from public.stores where id = p_store_id;
  if v_org is null or auth.uid() is null or not auth_user_role_in_store(v_org, p_store_id, 'admin') then
    raise exception 'เฉพาะเจ้าของหรือแอดมินที่ตั้งค่าระดับสมาชิกได้';
  end if;
  v_count := jsonb_array_length(coalesce(p_tiers, '[]'::jsonb));
  if v_count < 2 or v_count > 6 then raise exception 'ต้องมี 2–6 ระดับ'; end if;

  -- ล็อกโปรแกรมก่อนลบ/ใส่เกณฑ์ใหม่ — การประเมินครบรอบที่ทำพร้อมกันจะรอ (ไม่ใช้เกณฑ์ปนกัน)
  select initialized_at into v_initialized from public.member_tier_programs where organization_id = v_org for update;
  -- เปลี่ยนความยาวรอบหลังเริ่มใช้แล้วทำให้รอบเดิมคลาดเคลื่อน
  if v_initialized is not null and exists (
    select 1 from public.member_tier_programs where organization_id = v_org and cycle_months <> p_cycle_months
  ) then
    raise exception 'เปลี่ยนความยาวรอบหลังเปิดใช้แล้วไม่ได้';
  end if;

  insert into public.member_tier_programs (organization_id, metric_mode, cycle_months, downgrade_one_step, updated_by, updated_at)
  values (v_org, p_metric_mode, p_cycle_months, coalesce(p_downgrade_one_step, false), auth.uid(), now())
  on conflict (organization_id) do update
     set metric_mode = excluded.metric_mode,
         cycle_months = excluded.cycle_months,
         downgrade_one_step = excluded.downgrade_one_step,
         updated_by = excluded.updated_by,
         updated_at = now();

  delete from public.member_tiers where organization_id = v_org;
  insert into public.member_tiers (organization_id, rank, name, color, min_spend, min_orders)
  select v_org,
         (t ->> 'rank')::int,
         trim(t ->> 'name'),
         coalesce(nullif(t ->> 'color', ''), '#8a4b1f'),
         case when (t ->> 'rank')::int = 0 then 0 else coalesce((t ->> 'min_spend')::numeric, 0) end,
         case when (t ->> 'rank')::int = 0 then 0 else coalesce((t ->> 'min_orders')::int, 0) end
    from jsonb_array_elements(p_tiers) t;

  if not exists (select 1 from public.member_tiers where organization_id = v_org and rank = 0) then
    raise exception 'ต้องมีระดับเริ่มต้น (ลำดับ 0)';
  end if;
  -- โหมดต้องถึงทั้งคู่: เกณฑ์ 0 ข้อใดข้อหนึ่ง = ระดับนั้นวัดด้วยอีกข้อเดียว ซึ่งไม่ใช่สิ่งที่เจ้าของตั้งใจ
  if p_metric_mode = 'both' and exists (
    select 1 from public.member_tiers where organization_id = v_org and rank > 0 and (min_spend <= 0 or min_orders <= 0)
  ) then
    raise exception 'โหมดต้องถึงทั้งคู่ ต้องตั้งยอดซื้อและจำนวนบิลของทุกระดับให้มากกว่า 0';
  end if;
  -- เกณฑ์ต้องเพิ่มขึ้นตามลำดับ
  if exists (
    select 1 from public.member_tiers a join public.member_tiers b
      on a.organization_id = b.organization_id and b.rank = a.rank + 1
     where a.organization_id = v_org and (b.min_spend < a.min_spend or b.min_orders < a.min_orders)
  ) then
    raise exception 'เกณฑ์ของระดับที่สูงกว่าต้องไม่ต่ำกว่าระดับก่อนหน้า';
  end if;
  if exists (
    select 1 from public.member_tiers t where t.organization_id = v_org and t.rank > 0
       and t.rank <> (select count(*) from public.member_tiers x where x.organization_id = v_org and x.rank < t.rank)
  ) then
    raise exception 'ลำดับระดับต้องต่อเนื่อง 0, 1, 2, ...';
  end if;
  -- สถานะที่ระดับเกินจำนวนระดับใหม่ → ลดลงมาเป็นระดับสูงสุดที่มี
  update public.member_tier_status
     set tier_rank = (select max(rank) from public.member_tiers where organization_id = v_org), updated_at = now()
   where organization_id = v_org
     and tier_rank > (select max(rank) from public.member_tiers where organization_id = v_org);
end;
$$;

-- ---------------------------------------------------------------------------
-- เปิดใช้ครั้งแรก: เริ่มจากศูนย์ หรือคำนวณจากยอดย้อนหลัง (p_dry_run = แสดงตัวอย่าง ไม่เขียน)
--   backfill: ระดับเริ่มต้นจากยอด "รอบที่แล้ว", ยอดสะสมรอบนี้ = ยอดตั้งแต่ต้นรอบนี้ (แล้วขึ้นระดับทันทีถ้าถึง)
-- คืน { "counts": { "0": n, "1": n, ... }, "members": n }
-- ---------------------------------------------------------------------------
create or replace function public.initialize_member_tiers(p_store_id uuid, p_mode text, p_dry_run boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_program public.member_tier_programs%rowtype;
  v_current date;
  v_previous date;
  v_counts jsonb;
  v_members integer;
begin
  select organization_id into v_org from public.stores where id = p_store_id;
  if v_org is null or auth.uid() is null or not auth_user_role_in_store(v_org, p_store_id, 'admin') then
    raise exception 'เฉพาะเจ้าของหรือแอดมินที่เปิดใช้ระดับสมาชิกได้';
  end if;
  if p_mode not in ('zero', 'backfill') then raise exception 'วิธีเริ่มต้นไม่ถูกต้อง'; end if;
  select * into v_program from public.member_tier_programs where organization_id = v_org for update;
  if not found then raise exception 'ตั้งค่าระดับก่อนเปิดใช้'; end if;
  if v_program.initialized_at is not null and not p_dry_run then raise exception 'เปิดใช้ไปแล้ว'; end if;

  v_current := public.member_tier_cycle_start(now(), v_program.cycle_months);
  v_previous := (v_current - make_interval(months => v_program.cycle_months))::date;

  create temporary table if not exists _tier_seed (
    member_identity_id uuid primary key,
    prev_spend numeric, prev_orders integer, cur_spend numeric, cur_orders integer
  ) on commit drop;
  truncate _tier_seed;

  if p_mode = 'backfill' then
    insert into _tier_seed
    select c.member_identity_id,
           coalesce(sum(o.total) filter (where public.member_tier_cycle_start(o.paid_at, v_program.cycle_months) = v_previous), 0),
           count(*) filter (where public.member_tier_cycle_start(o.paid_at, v_program.cycle_months) = v_previous and o.total > 0),
           coalesce(sum(o.total) filter (where public.member_tier_cycle_start(o.paid_at, v_program.cycle_months) = v_current), 0),
           count(*) filter (where public.member_tier_cycle_start(o.paid_at, v_program.cycle_months) = v_current and o.total > 0)
      from public.orders o
      join public.customers c on c.id = o.customer_id
     where o.organization_id = v_org
       and o.status = 'paid'
       and o.paid_at >= (v_previous::timestamp at time zone 'Asia/Bangkok')
       and c.member_identity_id is not null
     group by c.member_identity_id;
  end if;

  select coalesce(jsonb_object_agg(r::text, n), '{}'::jsonb), coalesce(sum(n), 0)
    into v_counts, v_members
    from (
      select greatest(
               public.member_tier_rank_for(v_org, prev_spend, prev_orders),
               public.member_tier_rank_for(v_org, cur_spend, cur_orders)
             ) as r,
             count(*) as n
        from _tier_seed
       group by 1
    ) s;

  if not p_dry_run then
    insert into public.member_tier_status (organization_id, member_identity_id, tier_rank, cycle_start, cycle_spend, cycle_orders)
    select v_org, member_identity_id,
           greatest(public.member_tier_rank_for(v_org, prev_spend, prev_orders), public.member_tier_rank_for(v_org, cur_spend, cur_orders)),
           v_current, cur_spend, cur_orders
      from _tier_seed
    on conflict (member_identity_id) do update
       set tier_rank = excluded.tier_rank, cycle_start = excluded.cycle_start,
           cycle_spend = excluded.cycle_spend, cycle_orders = excluded.cycle_orders,
           achieved_at = now(), updated_at = now();

    insert into public.member_tier_events (organization_id, member_identity_id, type, from_rank, to_rank, cycle_start, cycle_spend, cycle_orders, actor_user_id, note)
    select v_org, s.member_identity_id, 'initial', null, st.tier_rank, v_current, s.cur_spend, s.cur_orders, auth.uid(), 'เปิดใช้ระดับสมาชิก (คำนวณยอดย้อนหลัง)'
      from _tier_seed s join public.member_tier_status st on st.member_identity_id = s.member_identity_id;

    update public.member_tier_programs
       set is_enabled = true, initial_mode = p_mode, initialized_at = now(), updated_by = auth.uid(), updated_at = now()
     where organization_id = v_org;
  end if;

  return jsonb_build_object('counts', v_counts, 'members', v_members, 'cycle_start', v_current, 'previous_cycle_start', v_previous);
end;
$$;

-- เปิด/ปิดหลังเริ่มใช้แล้ว (ปิด = หยุดนับยอดและซ่อน ไม่ลบประวัติ)
create or replace function public.set_member_tier_program_enabled(p_store_id uuid, p_enabled boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
begin
  select organization_id into v_org from public.stores where id = p_store_id;
  if v_org is null or auth.uid() is null or not auth_user_role_in_store(v_org, p_store_id, 'admin') then
    raise exception 'เฉพาะเจ้าของหรือแอดมินที่เปิด/ปิดระดับสมาชิกได้';
  end if;
  update public.member_tier_programs
     set is_enabled = coalesce(p_enabled, false), updated_by = auth.uid(), updated_at = now()
   where organization_id = v_org and initialized_at is not null;
  if not found then raise exception 'ยังไม่ได้เปิดใช้ครั้งแรก'; end if;
end;
$$;

-- ตั้ง/ล็อกระดับให้สมาชิกรายคน (owner/admin) — ล็อกแล้วไม่ถูกลดตอนครบรอบ
create or replace function public.set_member_tier_manual(p_store_id uuid, p_identity uuid, p_rank integer, p_locked boolean, p_note text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_program public.member_tier_programs%rowtype;
  v_old integer;
begin
  select organization_id into v_org from public.stores where id = p_store_id;
  if v_org is null or auth.uid() is null or not auth_user_role_in_store(v_org, p_store_id, 'admin') then
    raise exception 'เฉพาะเจ้าของหรือแอดมินที่ตั้งระดับได้';
  end if;
  if not exists (select 1 from public.member_identities where id = p_identity and organization_id = v_org) then
    raise exception 'ไม่พบสมาชิก';
  end if;
  if not exists (select 1 from public.member_tiers where organization_id = v_org and rank = p_rank) then
    raise exception 'ไม่มีระดับนี้';
  end if;
  select * into v_program from public.member_tier_programs where organization_id = v_org;
  if not found or v_program.initialized_at is null then raise exception 'ยังไม่ได้เปิดใช้ระดับสมาชิก'; end if;

  insert into public.member_tier_status (organization_id, member_identity_id, tier_rank, cycle_start)
  values (v_org, p_identity, 0, public.member_tier_cycle_start(now(), v_program.cycle_months))
  on conflict (member_identity_id) do nothing;
  perform public.member_tier_rollover(p_identity);

  select tier_rank into v_old from public.member_tier_status where member_identity_id = p_identity for update;
  update public.member_tier_status
     set tier_rank = p_rank, locked = coalesce(p_locked, false), lock_note = nullif(trim(coalesce(p_note, '')), ''),
         achieved_at = case when p_rank <> v_old then now() else achieved_at end, updated_at = now()
   where member_identity_id = p_identity;
  insert into public.member_tier_events (organization_id, member_identity_id, type, from_rank, to_rank, actor_user_id, note)
  values (v_org, p_identity, 'manual', v_old, p_rank, auth.uid(), coalesce(nullif(trim(coalesce(p_note, '')), ''), 'เจ้าของตั้งระดับเอง') ||
          case when coalesce(p_locked, false) then ' (ล็อก)' else '' end);
end;
$$;

-- ครบรอบทั้งองค์กร — pg_cron ทุกวัน 00:15 เวลาไทย (แค่สมาชิกที่รอบเก่า)
create or replace function public.rollover_member_tiers()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
  v_count integer := 0;
begin
  for v_row in
    select s.member_identity_id
      from public.member_tier_status s
      join public.member_tier_programs p on p.organization_id = s.organization_id
     where p.is_enabled
       and s.cycle_start < public.member_tier_cycle_start(now(), p.cycle_months)
     -- จำกัดต่อรอบ cron กัน transaction ยาว — เกินนี้ทำต่อวันถัดไป และการบันทึกยอดของคนนั้น
     -- เรียก member_tier_rollover ก่อนเสมอ จึงไม่มีใครถูกนับยอดผิดรอบแม้ cron ยังไม่ถึง
     limit 20000
  loop
    perform public.member_tier_rollover(v_row.member_identity_id);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- สิทธิ์เรียกฟังก์ชัน
-- ---------------------------------------------------------------------------
revoke all on function public.member_tier_rank_for(uuid, numeric, integer) from public, anon, authenticated;
revoke all on function public.member_tier_rollover(uuid) from public, anon, authenticated;
revoke all on function public.record_member_tier_activity(uuid, text, uuid, text, numeric, integer, timestamptz) from public, anon, authenticated;
revoke all on function public.member_tiers_on_order_status() from public, anon, authenticated;
revoke all on function public.member_tiers_on_pass_purchase_paid() from public, anon, authenticated;
revoke all on function public.rollover_member_tiers() from public, anon, authenticated;
revoke all on function public.save_member_tier_program(uuid, text, integer, boolean, jsonb) from public, anon;
revoke all on function public.initialize_member_tiers(uuid, text, boolean) from public, anon;
revoke all on function public.set_member_tier_program_enabled(uuid, boolean) from public, anon;
revoke all on function public.set_member_tier_manual(uuid, uuid, integer, boolean, text) from public, anon;
grant execute on function public.save_member_tier_program(uuid, text, integer, boolean, jsonb) to authenticated;
grant execute on function public.initialize_member_tiers(uuid, text, boolean) to authenticated;
grant execute on function public.set_member_tier_program_enabled(uuid, boolean) to authenticated;
grant execute on function public.set_member_tier_manual(uuid, uuid, integer, boolean, text) to authenticated;
grant execute on function public.rollover_member_tiers() to service_role;

create extension if not exists pg_cron with schema pg_catalog;
do $$
begin
  if exists (select 1 from cron.job where jobname = 'rollover-member-tiers') then
    perform cron.unschedule('rollover-member-tiers');
  end if;
end $$;
-- 17:15 UTC = 00:15 เวลาไทย
select cron.schedule('rollover-member-tiers', '15 17 * * *', $job$ select public.rollover_member_tiers(); $job$);
