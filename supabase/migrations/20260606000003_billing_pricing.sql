-- Super-admin editable subscription pricing + platform promotions.

create table if not exists billing_prices (
  tier        text not null check (tier in ('starter','standard','premium')),
  duration    text not null check (duration in ('30d','1y')),
  amount      numeric(12,2) not null check (amount >= 0),
  updated_at  timestamptz not null default now(),
  primary key (tier, duration)
);

-- Seed with the current code defaults (idempotent).
insert into billing_prices (tier, duration, amount) values
  ('starter','30d',690),  ('starter','1y',6900),
  ('standard','30d',1290),('standard','1y',12900),
  ('premium','30d',2290), ('premium','1y',22900)
on conflict (tier, duration) do nothing;

create table if not exists billing_promotions (
  id          uuid primary key default uuid_generate_v4(),
  description text not null,
  percent_off integer not null check (percent_off between 1 and 90),
  active      boolean not null default true,
  starts_at   timestamptz,
  ends_at     timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists billing_promotions_active_idx
  on billing_promotions(active) where active;

-- Internal tables: access only via service client / super-admin server actions.
alter table billing_prices     enable row level security;
alter table billing_promotions enable row level security;
