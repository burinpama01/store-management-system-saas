alter table public.stores
  add column if not exists theme_preset_id text not null default 'caramel-cafe',
  add column if not exists theme_primary_color text not null default '#c2603a',
  add column if not exists theme_primary_strong_color text not null default '#a8492a',
  add column if not exists theme_primary_soft_color text not null default '#fbede4',
  add column if not exists theme_accent_color text not null default '#3c8fb0';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'stores_theme_preset_id_check'
  ) then
    alter table public.stores
      add constraint stores_theme_preset_id_check
      check (theme_preset_id in ('caramel-cafe', 'matcha-garden', 'berry-bloom', 'ocean-retail', 'custom'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'stores_theme_primary_color_hex_check'
  ) then
    alter table public.stores
      add constraint stores_theme_primary_color_hex_check
      check (theme_primary_color ~ '^#[0-9A-Fa-f]{6}$');
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'stores_theme_primary_strong_color_hex_check'
  ) then
    alter table public.stores
      add constraint stores_theme_primary_strong_color_hex_check
      check (theme_primary_strong_color ~ '^#[0-9A-Fa-f]{6}$');
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'stores_theme_primary_soft_color_hex_check'
  ) then
    alter table public.stores
      add constraint stores_theme_primary_soft_color_hex_check
      check (theme_primary_soft_color ~ '^#[0-9A-Fa-f]{6}$');
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'stores_theme_accent_color_hex_check'
  ) then
    alter table public.stores
      add constraint stores_theme_accent_color_hex_check
      check (theme_accent_color ~ '^#[0-9A-Fa-f]{6}$');
  end if;
end
$$;
