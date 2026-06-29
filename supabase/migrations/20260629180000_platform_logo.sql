-- Super-admin configurable system logo (shown as the StoreOS brand mark).
alter table platform_settings
  add column if not exists logo_url text;
