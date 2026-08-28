-- Task 6/F1 (v0.33.5): setup profile for guided onboarding.
-- Additive only: existing rows keep their behavior via the '{}' default.
alter table public.stores add column setup_profile jsonb not null default '{}'::jsonb;
alter table public.stores add constraint stores_setup_profile_object_chk check (jsonb_typeof(setup_profile) = 'object');