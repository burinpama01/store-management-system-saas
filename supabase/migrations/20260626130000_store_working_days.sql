-- Store-level open days (which weekdays the store operates), used as the default for the
-- attendance calendar so weekend-operating stores count Sat/Sun as working days.
-- 0=Sun .. 6=Sat. Default = all 7 days open. Per-employee working_days still overrides.

alter table store_hr_settings
  add column if not exists working_days int[] not null default '{0,1,2,3,4,5,6}';
