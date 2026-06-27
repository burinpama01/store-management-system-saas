-- Super-admin-configurable sender for Enterprise request emails.
-- Falls back to the ENTERPRISE_FROM_EMAIL env var when null.

alter table platform_settings
  add column if not exists enterprise_from_email text;
