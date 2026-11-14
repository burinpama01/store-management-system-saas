-- ============================================================
-- StoreOS Operations 1A — เช็กลิสต์หน้าร้าน (เปิด / ระหว่างวัน / ปิด)
--
-- ที่มา (2026-10-15): blueprint StoreOS Operations v1.0 นำร่อง Each Other II
--   เจ้าของตอบ: พนักงานที่รับผิดชอบออกงานไม่ได้ถ้ายังไม่ทำเช็กลิสต์, เจ้าของปรับแต่งเอง,
--   แจ้งเจ้าของโดยตรงทุกช่องทาง, เว็บก่อน, ต้องเห็นว่าใคร ทำอะไร เมื่อไร
--
-- ทำอะไร (เพิ่มอย่างเดียว — ไม่แตะตาราง/RPC ขายของเดิม)
--   1) stores.operations_enabled (default false) — ปิด = ไม่มีอะไรทำงาน
--   2) template + ข้อ (เจ้าของแก้ได้, มี version)
--   3) run ต่อวัน + snapshot ข้อ ณ version ที่เริ่ม (แก้ template ภายหลังไม่ทำให้ประวัติเพี้ยน)
--   4) ops_checklist_events — ประวัติ append-only ทุกการกระทำ
--   5) RPC security definer เป็นทางเขียนทางเดียว (client ไม่มีสิทธิ์ insert/update ตรง)
--   6) ops_checklist_due_alerts() + pg_cron 15 นาที เรียก API เฉพาะเมื่อมีรายการเลยกำหนด
--      ใช้กุญแจ Vault เดิม closing_summary_cron_key (ไม่มี env ใหม่)
--   7) ชนิดแจ้งเตือนใหม่ 'ops_checklist'
-- ============================================================

-- 1) flag รายร้าน ------------------------------------------------
alter table public.stores
  add column if not exists operations_enabled boolean not null default false;

comment on column public.stores.operations_enabled is
  'เปิดระบบงานหน้าร้าน (เช็กลิสต์) — false = ไม่แสดงหน้า ไม่บล็อกออกงาน ไม่แจ้งเตือน';

-- 2) template ----------------------------------------------------
create table if not exists public.ops_checklist_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  name text not null check (btrim(name) <> '' and char_length(name) <= 120),
  area text not null default '' check (char_length(area) <= 60),
  phase text not null check (phase in ('open', 'mid', 'close', 'other')),
  due_time time,
  days_of_week smallint[] not null default '{0,1,2,3,4,5,6}',
  require_before_clock_out boolean not null default true,
  assignee_user_ids uuid[] not null default '{}',
  version integer not null default 1 check (version >= 1),
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (days_of_week <@ array[0,1,2,3,4,5,6]::smallint[])
);

create index if not exists ops_checklist_templates_store_idx
  on public.ops_checklist_templates(store_id, is_active, sort_order);

create trigger set_updated_at before update on public.ops_checklist_templates
  for each row execute function set_updated_at();

create table if not exists public.ops_checklist_template_items (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.ops_checklist_templates(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  sort_order integer not null default 0,
  label text not null check (btrim(label) <> '' and char_length(label) <= 200),
  description text check (description is null or char_length(description) <= 500),
  critical boolean not null default false,
  value_type text not null default 'check' check (value_type in ('check', 'number')),
  unit text check (unit is null or char_length(unit) <= 20),
  min_value numeric(10,2),
  max_value numeric(10,2),
  photo_rule text not null default 'never' check (photo_rule in ('never', 'on_fail', 'always')),
  check (min_value is null or max_value is null or min_value <= max_value)
);

create index if not exists ops_checklist_template_items_template_idx
  on public.ops_checklist_template_items(template_id, sort_order);

-- 3) run ต่อวัน -------------------------------------------------
create table if not exists public.ops_checklist_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  template_id uuid not null references public.ops_checklist_templates(id) on delete restrict,
  template_version integer not null,
  template_name text not null,
  area text not null default '',
  phase text not null,
  shift_date date not null,
  status text not null default 'in_progress' check (status in ('in_progress', 'submitted')),
  started_by uuid not null,
  started_at timestamptz not null default now(),
  submitted_by uuid,
  submitted_at timestamptz,
  unique (template_id, shift_date)
);

create index if not exists ops_checklist_runs_store_date_idx
  on public.ops_checklist_runs(store_id, shift_date desc);

create table if not exists public.ops_checklist_run_items (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.ops_checklist_runs(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  template_item_id uuid,
  sort_order integer not null default 0,
  label text not null,
  description text,
  critical boolean not null default false,
  value_type text not null default 'check',
  unit text,
  min_value numeric(10,2),
  max_value numeric(10,2),
  photo_rule text not null default 'never',
  answer text check (answer is null or answer in ('pass', 'fail', 'na')),
  value numeric(10,2),
  note text check (note is null or char_length(note) <= 1000),
  photo_path text,
  answered_by uuid,
  answered_at timestamptz
);

create index if not exists ops_checklist_run_items_run_idx
  on public.ops_checklist_run_items(run_id, sort_order);

-- 4) ประวัติ append-only -----------------------------------------
create table if not exists public.ops_checklist_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  template_id uuid,
  run_id uuid,
  run_item_id uuid,
  actor_user_id uuid not null,
  action text not null check (action in (
    'template_created', 'template_updated',
    'run_started', 'item_answered', 'item_changed', 'photo_attached',
    'run_submitted', 'run_reopened'
  )),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists ops_checklist_events_store_created_idx
  on public.ops_checklist_events(store_id, created_at desc);
create index if not exists ops_checklist_events_run_idx
  on public.ops_checklist_events(run_id, created_at);

create or replace function public.ops_checklist_events_block_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'ops_checklist_events is append-only';
end;
$$;

create trigger ops_checklist_events_append_only
before update or delete on public.ops_checklist_events
for each row execute function public.ops_checklist_events_block_mutation();

-- กันแจ้งซ้ำ (เลยกำหนด / ข้อสำคัญไม่ผ่าน) ------------------------------
create table if not exists public.ops_notification_log (
  dedupe_key text primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- 5) RLS — อ่านอย่างเดียวจาก client, เขียนผ่าน RPC เท่านั้น ------------------
alter table public.ops_checklist_templates enable row level security;
alter table public.ops_checklist_template_items enable row level security;
alter table public.ops_checklist_runs enable row level security;
alter table public.ops_checklist_run_items enable row level security;
alter table public.ops_checklist_events enable row level security;
alter table public.ops_notification_log enable row level security;

revoke all on table public.ops_checklist_templates, public.ops_checklist_template_items,
  public.ops_checklist_runs, public.ops_checklist_run_items, public.ops_checklist_events,
  public.ops_notification_log
  from anon, authenticated;

grant select on table public.ops_checklist_templates, public.ops_checklist_template_items,
  public.ops_checklist_runs, public.ops_checklist_run_items, public.ops_checklist_events
  to authenticated;

grant all on table public.ops_checklist_templates, public.ops_checklist_template_items,
  public.ops_checklist_runs, public.ops_checklist_run_items, public.ops_checklist_events,
  public.ops_notification_log
  to service_role;

create policy "ops_checklist_templates: store member can read"
  on public.ops_checklist_templates for select
  using (auth_user_role_in_store(organization_id, store_id, 'staff'));

create policy "ops_checklist_template_items: store member can read"
  on public.ops_checklist_template_items for select
  using (auth_user_role_in_store(organization_id, store_id, 'staff'));

create policy "ops_checklist_runs: store member can read"
  on public.ops_checklist_runs for select
  using (auth_user_role_in_store(organization_id, store_id, 'staff'));

create policy "ops_checklist_run_items: store member can read"
  on public.ops_checklist_run_items for select
  using (auth_user_role_in_store(organization_id, store_id, 'staff'));

-- ประวัติละเอียดเห็นเฉพาะเจ้าของ/admin (ข้อ 6 ของผู้ใช้)
create policy "ops_checklist_events: admin can read"
  on public.ops_checklist_events for select
  using (auth_user_role_in_store(organization_id, store_id, 'admin'));

-- 6) RPC ---------------------------------------------------------
create or replace function public.ops_require_store_role(p_store_id uuid, p_min_role text)
returns uuid
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_org uuid;
begin
  if auth.uid() is null then
    raise exception 'ops_not_authenticated';
  end if;
  select organization_id into v_org from public.stores where id = p_store_id;
  if v_org is null or not auth_user_role_in_store(v_org, p_store_id, p_min_role) then
    raise exception 'ops_forbidden';
  end if;
  return v_org;
end;
$$;

revoke all on function public.ops_require_store_role(uuid, text) from public, anon, authenticated;

-- 6.1 บันทึก template (owner/admin) ----------------------------------
create or replace function public.ops_save_checklist_template(
  p_store_id uuid,
  p_template_id uuid,
  p_payload jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_template public.ops_checklist_templates%rowtype;
  v_id uuid;
  v_name text := btrim(coalesce(p_payload->>'name', ''));
  v_area text := btrim(coalesce(p_payload->>'area', ''));
  v_phase text := coalesce(p_payload->>'phase', '');
  v_due_time time := nullif(p_payload->>'due_time', '')::time;
  v_days smallint[] := coalesce(
    (select array_agg(distinct value::smallint order by value::smallint)
       from jsonb_array_elements_text(coalesce(p_payload->'days_of_week', '[]'::jsonb))),
    '{}'::smallint[]
  );
  v_assignees uuid[] := coalesce(
    (select array_agg(distinct value::uuid)
       from jsonb_array_elements_text(coalesce(p_payload->'assignee_user_ids', '[]'::jsonb))),
    '{}'::uuid[]
  );
  v_require boolean := coalesce((p_payload->>'require_before_clock_out')::boolean, true);
  v_active boolean := coalesce((p_payload->>'is_active')::boolean, true);
  v_sort integer := coalesce((p_payload->>'sort_order')::integer, 0);
  v_items jsonb := coalesce(p_payload->'items', '[]'::jsonb);
  v_item jsonb;
  v_idx integer := 0;
  v_valid_members integer;
  v_min numeric;
  v_max numeric;
begin
  v_org := public.ops_require_store_role(p_store_id, 'admin');

  if v_name = '' or char_length(v_name) > 120 then raise exception 'ops_invalid_name'; end if;
  if char_length(v_area) > 60 then raise exception 'ops_invalid_area'; end if;
  if v_phase not in ('open', 'mid', 'close', 'other') then raise exception 'ops_invalid_phase'; end if;
  if cardinality(v_days) = 0 or not (v_days <@ array[0,1,2,3,4,5,6]::smallint[]) then
    raise exception 'ops_invalid_days';
  end if;
  if jsonb_typeof(v_items) <> 'array' or jsonb_array_length(v_items) = 0 or jsonb_array_length(v_items) > 60 then
    raise exception 'ops_invalid_items';
  end if;

  select count(distinct m.user_id) into v_valid_members
    from public.memberships m
    where m.user_id = any(v_assignees)
      and m.organization_id = v_org
      and (m.store_id = p_store_id or m.store_id is null)
      and m.joined_at is not null;
  if v_valid_members <> cardinality(v_assignees) then
    raise exception 'ops_invalid_assignee';
  end if;

  if p_template_id is null then
    insert into public.ops_checklist_templates (
      organization_id, store_id, name, area, phase, due_time, days_of_week,
      require_before_clock_out, assignee_user_ids, is_active, sort_order, created_by, updated_by
    ) values (
      v_org, p_store_id, v_name, v_area, v_phase, v_due_time, v_days,
      v_require, v_assignees, v_active, v_sort, auth.uid(), auth.uid()
    ) returning * into v_template;
  else
    select * into v_template from public.ops_checklist_templates
      where id = p_template_id and store_id = p_store_id for update;
    if not found then raise exception 'ops_template_not_found'; end if;

    update public.ops_checklist_templates set
      name = v_name, area = v_area, phase = v_phase, due_time = v_due_time,
      days_of_week = v_days, require_before_clock_out = v_require,
      assignee_user_ids = v_assignees, is_active = v_active, sort_order = v_sort,
      version = version + 1, updated_by = auth.uid()
    where id = p_template_id
    returning * into v_template;

    delete from public.ops_checklist_template_items where template_id = p_template_id;
  end if;

  v_id := v_template.id;

  for v_item in select value from jsonb_array_elements(v_items) loop
    v_idx := v_idx + 1;
    if btrim(coalesce(v_item->>'label', '')) = '' or char_length(v_item->>'label') > 200 then
      raise exception 'ops_invalid_item_label';
    end if;
    if coalesce(v_item->>'value_type', 'check') not in ('check', 'number') then
      raise exception 'ops_invalid_item_type';
    end if;
    if coalesce(v_item->>'photo_rule', 'never') not in ('never', 'on_fail', 'always') then
      raise exception 'ops_invalid_photo_rule';
    end if;
    v_min := nullif(v_item->>'min_value', '')::numeric;
    v_max := nullif(v_item->>'max_value', '')::numeric;
    if v_min is not null and v_max is not null and v_min > v_max then
      raise exception 'ops_invalid_range';
    end if;

    insert into public.ops_checklist_template_items (
      template_id, organization_id, store_id, sort_order, label, description, critical,
      value_type, unit, min_value, max_value, photo_rule
    ) values (
      v_id, v_org, p_store_id, v_idx, btrim(v_item->>'label'),
      nullif(btrim(coalesce(v_item->>'description', '')), ''),
      coalesce((v_item->>'critical')::boolean, false),
      coalesce(v_item->>'value_type', 'check'),
      nullif(btrim(coalesce(v_item->>'unit', '')), ''),
      case when coalesce(v_item->>'value_type', 'check') = 'number' then v_min end,
      case when coalesce(v_item->>'value_type', 'check') = 'number' then v_max end,
      coalesce(v_item->>'photo_rule', 'never')
    );
  end loop;

  insert into public.ops_checklist_events (organization_id, store_id, template_id, actor_user_id, action, detail)
  values (
    v_org, p_store_id, v_id, auth.uid(),
    case when p_template_id is null then 'template_created' else 'template_updated' end,
    jsonb_build_object(
      'name', v_name, 'version', v_template.version, 'item_count', v_idx,
      'is_active', v_active, 'require_before_clock_out', v_require,
      'assignee_count', cardinality(v_assignees)
    )
  );

  return v_id;
end;
$$;

-- 6.2 เริ่มรอบ (สมาชิกร้าน) — idempotent ต่อ template+วันที่ ------------------
create or replace function public.ops_start_checklist_run(p_template_id uuid, p_shift_date date)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_template public.ops_checklist_templates%rowtype;
  v_store public.stores%rowtype;
  v_today date;
  v_shift date;
  v_run_id uuid;
begin
  select * into v_template from public.ops_checklist_templates where id = p_template_id;
  if not found then raise exception 'ops_template_not_found'; end if;
  perform public.ops_require_store_role(v_template.store_id, 'staff');

  select * into v_store from public.stores where id = v_template.store_id;
  if not v_store.operations_enabled then raise exception 'ops_disabled'; end if;
  if not v_template.is_active then raise exception 'ops_template_inactive'; end if;

  v_today := (now() at time zone coalesce(v_store.timezone, 'Asia/Bangkok'))::date;
  v_shift := coalesce(p_shift_date, v_today);
  -- กะข้ามเที่ยงคืนใช้วันที่ลงเวลาเข้าได้ (เมื่อวาน) แต่ห้ามย้อน/ล่วงหน้ากว่านั้น
  if v_shift < v_today - 1 or v_shift > v_today then
    raise exception 'ops_invalid_shift_date';
  end if;

  insert into public.ops_checklist_runs (
    organization_id, store_id, template_id, template_version, template_name, area, phase,
    shift_date, started_by
  ) values (
    v_template.organization_id, v_template.store_id, v_template.id, v_template.version,
    v_template.name, v_template.area, v_template.phase, v_shift, auth.uid()
  )
  on conflict (template_id, shift_date) do nothing
  returning id into v_run_id;

  if v_run_id is null then
    select id into v_run_id from public.ops_checklist_runs
      where template_id = p_template_id and shift_date = v_shift;
    return v_run_id;
  end if;

  insert into public.ops_checklist_run_items (
    run_id, organization_id, store_id, template_item_id, sort_order, label, description,
    critical, value_type, unit, min_value, max_value, photo_rule
  )
  select v_run_id, i.organization_id, i.store_id, i.id, i.sort_order, i.label, i.description,
         i.critical, i.value_type, i.unit, i.min_value, i.max_value, i.photo_rule
    from public.ops_checklist_template_items i
    where i.template_id = p_template_id
    order by i.sort_order;

  insert into public.ops_checklist_events (organization_id, store_id, template_id, run_id, actor_user_id, action, detail)
  values (
    v_template.organization_id, v_template.store_id, v_template.id, v_run_id, auth.uid(), 'run_started',
    jsonb_build_object('template_name', v_template.name, 'version', v_template.version, 'shift_date', v_shift)
  );

  return v_run_id;
end;
$$;

-- 6.3 ตอบข้อ -----------------------------------------------------
create or replace function public.ops_answer_checklist_item(
  p_run_item_id uuid,
  p_answer text,
  p_value numeric,
  p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item public.ops_checklist_run_items%rowtype;
  v_run public.ops_checklist_runs%rowtype;
  v_answer text := lower(coalesce(p_answer, ''));
  v_value numeric := null;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_out_of_range boolean := false;
  v_notify boolean := false;
  v_inserted integer;
begin
  select * into v_item from public.ops_checklist_run_items where id = p_run_item_id for update;
  if not found then raise exception 'ops_item_not_found'; end if;
  perform public.ops_require_store_role(v_item.store_id, 'staff');

  select * into v_run from public.ops_checklist_runs where id = v_item.run_id for update;
  if v_run.status <> 'in_progress' then raise exception 'ops_run_submitted'; end if;
  if not exists (select 1 from public.stores where id = v_run.store_id and operations_enabled) then
    raise exception 'ops_disabled';
  end if;

  if v_answer not in ('pass', 'fail', 'na') then raise exception 'ops_invalid_answer'; end if;
  if v_note is not null and char_length(v_note) > 1000 then raise exception 'ops_note_too_long'; end if;

  if v_item.value_type = 'number' and v_answer <> 'na' then
    if p_value is null then raise exception 'ops_value_required'; end if;
    v_value := round(p_value, 2);
    v_out_of_range := (v_item.min_value is not null and v_value < v_item.min_value)
                   or (v_item.max_value is not null and v_value > v_item.max_value);
    -- ค่าเกินช่วงที่เจ้าของตั้ง = ไม่ผ่านเสมอ (กดผ่านทับไม่ได้)
    if v_out_of_range then v_answer := 'fail'; end if;
  end if;

  if v_answer = 'na' and v_note is null then raise exception 'ops_note_required_na'; end if;
  if v_answer = 'fail' and v_item.critical and v_note is null then
    raise exception 'ops_note_required_critical';
  end if;

  update public.ops_checklist_run_items set
    answer = v_answer, value = v_value, note = v_note,
    answered_by = auth.uid(), answered_at = now()
  where id = p_run_item_id;

  insert into public.ops_checklist_events (organization_id, store_id, template_id, run_id, run_item_id, actor_user_id, action, detail)
  values (
    v_item.organization_id, v_item.store_id, v_run.template_id, v_run.id, v_item.id, auth.uid(),
    case when v_item.answer is null then 'item_answered' else 'item_changed' end,
    jsonb_build_object(
      'label', v_item.label,
      'before', case when v_item.answer is null then null else
        jsonb_build_object('answer', v_item.answer, 'value', v_item.value, 'note', v_item.note) end,
      'after', jsonb_build_object('answer', v_answer, 'value', v_value, 'note', v_note),
      'out_of_range', v_out_of_range
    )
  );

  if v_item.critical and v_answer = 'fail' then
    insert into public.ops_notification_log (dedupe_key, organization_id, store_id)
    values ('critical:' || v_item.id::text, v_item.organization_id, v_item.store_id)
    on conflict (dedupe_key) do nothing;
    get diagnostics v_inserted = row_count;
    v_notify := v_inserted > 0;
  end if;

  return jsonb_build_object(
    'answer', v_answer,
    'value', v_value,
    'out_of_range', v_out_of_range,
    'notify_critical_fail', v_notify
  );
end;
$$;

-- 6.4 แนบรูป (path ต้องอยู่ใต้ run นี้) -----------------------------------
create or replace function public.ops_attach_checklist_photo(p_run_item_id uuid, p_path text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item public.ops_checklist_run_items%rowtype;
  v_run public.ops_checklist_runs%rowtype;
  v_prefix text;
begin
  select * into v_item from public.ops_checklist_run_items where id = p_run_item_id for update;
  if not found then raise exception 'ops_item_not_found'; end if;
  perform public.ops_require_store_role(v_item.store_id, 'staff');
  select * into v_run from public.ops_checklist_runs where id = v_item.run_id;
  if v_run.status <> 'in_progress' then raise exception 'ops_run_submitted'; end if;

  v_prefix := v_item.organization_id::text || '/' || v_item.store_id::text || '/ops/' || v_run.id::text || '/';
  if p_path is null or left(p_path, char_length(v_prefix)) <> v_prefix or position('..' in p_path) > 0 then
    raise exception 'ops_invalid_photo_path';
  end if;

  update public.ops_checklist_run_items set photo_path = p_path where id = p_run_item_id;

  insert into public.ops_checklist_events (organization_id, store_id, template_id, run_id, run_item_id, actor_user_id, action, detail)
  values (
    v_item.organization_id, v_item.store_id, v_run.template_id, v_run.id, v_item.id, auth.uid(), 'photo_attached',
    jsonb_build_object('label', v_item.label, 'replaced', v_item.photo_path is not null)
  );
end;
$$;

-- 6.5 ส่ง --------------------------------------------------------
create or replace function public.ops_submit_checklist_run(p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run public.ops_checklist_runs%rowtype;
  v_unanswered integer;
  v_missing_photo integer;
  v_fail integer;
  v_critical_fail integer;
begin
  select * into v_run from public.ops_checklist_runs where id = p_run_id for update;
  if not found then raise exception 'ops_run_not_found'; end if;
  perform public.ops_require_store_role(v_run.store_id, 'staff');
  if v_run.status <> 'in_progress' then raise exception 'ops_run_submitted'; end if;

  select
    count(*) filter (where answer is null),
    count(*) filter (where photo_path is null and (photo_rule = 'always' or (photo_rule = 'on_fail' and answer = 'fail'))),
    count(*) filter (where answer = 'fail'),
    count(*) filter (where answer = 'fail' and critical)
  into v_unanswered, v_missing_photo, v_fail, v_critical_fail
  from public.ops_checklist_run_items where run_id = p_run_id;

  if v_unanswered > 0 then raise exception 'ops_items_unanswered'; end if;
  if v_missing_photo > 0 then raise exception 'ops_photo_required'; end if;

  update public.ops_checklist_runs set
    status = 'submitted', submitted_by = auth.uid(), submitted_at = now()
  where id = p_run_id;

  insert into public.ops_checklist_events (organization_id, store_id, template_id, run_id, actor_user_id, action, detail)
  values (
    v_run.organization_id, v_run.store_id, v_run.template_id, v_run.id, auth.uid(), 'run_submitted',
    jsonb_build_object('fail_count', v_fail, 'critical_fail_count', v_critical_fail)
  );

  return jsonb_build_object('fail_count', v_fail, 'critical_fail_count', v_critical_fail);
end;
$$;

-- 6.6 เปิดรอบที่ส่งแล้วให้แก้ใหม่ (owner/admin, ต้องมีเหตุผล) ---------------------
create or replace function public.ops_reopen_checklist_run(p_run_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run public.ops_checklist_runs%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  select * into v_run from public.ops_checklist_runs where id = p_run_id for update;
  if not found then raise exception 'ops_run_not_found'; end if;
  perform public.ops_require_store_role(v_run.store_id, 'admin');
  if v_run.status <> 'submitted' then raise exception 'ops_run_not_submitted'; end if;
  if v_reason is null or char_length(v_reason) > 500 then raise exception 'ops_reason_required'; end if;

  update public.ops_checklist_runs set status = 'in_progress', submitted_by = null, submitted_at = null
  where id = p_run_id;

  -- รอบที่เปิดใหม่ ข้อสำคัญที่ไม่ผ่านอีกต้องแจ้งเจ้าของได้อีกครั้ง
  delete from public.ops_notification_log
   where dedupe_key in (
     select 'critical:' || i.id::text from public.ops_checklist_run_items i where i.run_id = p_run_id
   );

  insert into public.ops_checklist_events (organization_id, store_id, template_id, run_id, actor_user_id, action, detail)
  values (
    v_run.organization_id, v_run.store_id, v_run.template_id, v_run.id, auth.uid(), 'run_reopened',
    jsonb_build_object('reason', v_reason, 'previous_submitted_by', v_run.submitted_by, 'previous_submitted_at', v_run.submitted_at)
  );
end;
$$;

revoke all on function public.ops_save_checklist_template(uuid, uuid, jsonb) from public, anon;
revoke all on function public.ops_start_checklist_run(uuid, date) from public, anon;
revoke all on function public.ops_answer_checklist_item(uuid, text, numeric, text) from public, anon;
revoke all on function public.ops_attach_checklist_photo(uuid, text) from public, anon;
revoke all on function public.ops_submit_checklist_run(uuid) from public, anon;
revoke all on function public.ops_reopen_checklist_run(uuid, text) from public, anon;
grant execute on function public.ops_save_checklist_template(uuid, uuid, jsonb) to authenticated;
grant execute on function public.ops_start_checklist_run(uuid, date) to authenticated;
grant execute on function public.ops_answer_checklist_item(uuid, text, numeric, text) to authenticated;
grant execute on function public.ops_attach_checklist_photo(uuid, text) to authenticated;
grant execute on function public.ops_submit_checklist_run(uuid) to authenticated;
grant execute on function public.ops_reopen_checklist_run(uuid, text) to authenticated;

-- 7) เลยกำหนดยังไม่ส่ง ------------------------------------------------
-- เวลาครบกำหนดก่อน 05:00 = หลังเที่ยงคืนของกะนั้น (แบบเดียวกับ closing_time)
-- แจ้งเฉพาะภายใน 6 ชม. หลังเลยกำหนด กันไล่แจ้งของเก่าตอนเพิ่งเปิดระบบ
create or replace function public.ops_checklist_due_alerts()
returns table (
  organization_id uuid,
  store_id uuid,
  store_name text,
  template_id uuid,
  template_name text,
  area text,
  shift_date date,
  due_at_local timestamp,
  dedupe_key text
)
language sql
security definer
stable
set search_path = public
as $$
  with candidates as (
    select s.organization_id, s.id as store_id, s.name as store_name,
           t.id as template_id, t.name as template_name, t.area,
           d.shift_date,
           (d.shift_date + t.due_time
             + case when t.due_time < time '05:00' then interval '1 day' else interval '0' end) as due_at_local,
           (now() at time zone coalesce(s.timezone, 'Asia/Bangkok')) as now_local
      from public.stores s
      join public.ops_checklist_templates t on t.store_id = s.id
      cross join lateral (
        select ((now() at time zone coalesce(s.timezone, 'Asia/Bangkok'))::date - g) as shift_date
          from generate_series(0, 1) g
      ) d
     where s.operations_enabled
       and t.is_active
       and t.due_time is not null
       and extract(dow from d.shift_date)::smallint = any(t.days_of_week)
  )
  select c.organization_id, c.store_id, c.store_name, c.template_id, c.template_name, c.area,
         c.shift_date, c.due_at_local,
         'overdue:' || c.template_id::text || ':' || c.shift_date::text as dedupe_key
    from candidates c
   where c.now_local >= c.due_at_local
     and c.now_local < c.due_at_local + interval '6 hours'
     and not exists (
       select 1 from public.ops_checklist_runs r
        where r.template_id = c.template_id and r.shift_date = c.shift_date and r.status = 'submitted'
     )
     and not exists (
       select 1 from public.ops_notification_log l
        where l.dedupe_key = 'overdue:' || c.template_id::text || ':' || c.shift_date::text
     );
$$;

revoke all on function public.ops_checklist_due_alerts() from public, anon, authenticated;
grant execute on function public.ops_checklist_due_alerts() to service_role;

-- 8) ชนิดแจ้งเตือนใหม่ 'ops_checklist' (ชุดเดิมทั้งหมด + ชนิดใหม่) ----------------
alter table public.notification_settings
  drop constraint if exists notification_settings_notification_type_check;

alter table public.notification_settings
  add constraint notification_settings_notification_type_check check (
    notification_type in (
      'payment', 'new_table', 'new_pos_order', 'new_qr_order', 'new_buffet_order',
      'new_delivery_order', 'kitchen_order', 'buffet_expiring', 'stock_alert',
      'order_cancelled', 'approval', 'service_request', 'attendance_clock_in',
      'attendance_clock_out', 'test', 'activation_nudge', 'subscription_expiring',
      'daily_summary', 'ops_checklist'
    )
  );

alter table public.notification_templates
  drop constraint if exists notification_templates_notification_type_check;

alter table public.notification_templates
  add constraint notification_templates_notification_type_check check (
    notification_type in (
      'payment', 'new_table', 'new_pos_order', 'new_qr_order', 'new_buffet_order',
      'new_delivery_order', 'kitchen_order', 'buffet_expiring', 'stock_alert',
      'order_cancelled', 'approval', 'service_request', 'attendance_clock_in',
      'attendance_clock_out', 'test', 'activation_nudge', 'subscription_expiring',
      'daily_summary', 'ops_checklist'
    )
  );

-- 9) pg_cron ทุก 15 นาที — เช็คใน DB ก่อน เรียก API เฉพาะเมื่อมีรายการเลยกำหนด ------
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'ops-checklist-due') then
    perform cron.unschedule('ops-checklist-due');
  end if;
end $$;

select cron.schedule(
  'ops-checklist-due',
  '*/15 * * * *',
  $job$
  select net.http_post(
    url := 'https://www.store-os.online/api/operations/cron/checklist-due',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-closing-summary-key',
      (select decrypted_secret from vault.decrypted_secrets where name = 'closing_summary_cron_key' limit 1)
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  )
  where exists (select 1 from public.ops_checklist_due_alerts());
  $job$
);
