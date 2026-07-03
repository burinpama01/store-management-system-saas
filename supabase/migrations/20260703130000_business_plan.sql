-- Business (build-your-own) plan: tenant picks seats/stores/features and pays
-- for exactly the selected components. #business-plan

-- 1) subscriptions: allow plan = 'business' + store the purchased config.
alter table subscriptions
  drop constraint if exists subscriptions_plan_check;
alter table subscriptions
  add constraint subscriptions_plan_check
    check (plan in ('free','starter','standard','premium','business','enterprise'));
alter table subscriptions
  add column if not exists business_seats    integer,
  add column if not exists business_stores   integer,
  add column if not exists business_features jsonb not null default '[]'::jsonb;

-- 2) payment_submissions: allow business purchases + record what was bought.
alter table payment_submissions
  drop constraint if exists payment_submissions_plan_check;
alter table payment_submissions
  add constraint payment_submissions_plan_check
    check (plan in ('starter','standard','premium','business'));
alter table payment_submissions
  add column if not exists business_seats    integer,
  add column if not exists business_stores   integer,
  add column if not exists business_features jsonb not null default '[]'::jsonb;

-- 3) promotions + discount codes can be scoped to the business plan.
alter table billing_promotions
  drop constraint if exists billing_promotions_plan_check;
alter table billing_promotions
  add constraint billing_promotions_plan_check
    check (plan is null or plan in ('starter','standard','premium','business'));

alter table billing_discount_codes
  drop constraint if exists billing_discount_codes_plan_check;
alter table billing_discount_codes
  add constraint billing_discount_codes_plan_check
    check (plan is null or plan in ('starter','standard','premium','business'));

-- 4) landing/pricing display config for the business tier.
alter table plan_settings
  drop constraint if exists plan_settings_tier_check;
alter table plan_settings
  add constraint plan_settings_tier_check
    check (tier in ('starter','standard','premium','business','enterprise'));

update plan_settings set sort_order = 5 where tier = 'enterprise' and sort_order = 4;

insert into plan_settings (tier, display_name, visible_on_landing, highlight, sort_order, feature_lines) values
  ('business','Business',true,false,4,
   '["เลือกจำนวนที่นั่งและสาขาได้เอง","เลือกเปิดเฉพาะฟีเจอร์ที่ต้องใช้","จ่ายตามที่เลือกจริง ไม่จ่ายเผื่อ","ปรับแพ็กเกจได้ทุกครั้งที่ต่ออายุ"]'::jsonb)
on conflict (tier) do nothing;

-- 5) super-admin editable component prices (missing rows fall back to code defaults).
create table if not exists business_plan_prices (
  component  text not null,
  duration   text not null check (duration in ('30d','1y')),
  amount     numeric(12,2) not null check (amount >= 0),
  updated_at timestamptz not null default now(),
  primary key (component, duration)
);

-- Internal: read/written via service client only; no client policies.
alter table business_plan_prices enable row level security;
