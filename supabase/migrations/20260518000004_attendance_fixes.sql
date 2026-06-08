-- ATT-01: Prevent concurrent clock-in TOCTOU race via partial unique index.
-- Only one "active" record per (store, user, date) is allowed at the DB level.
create unique index attendance_one_active_per_user_date
  on attendance_records(store_id, user_id, date)
  where status = 'active';

-- ATT-02: The existing "attendance: manager+ can adjust" UPDATE policy only allows
-- managers to update records. Staff need to be able to clock themselves out.
-- This policy allows any authenticated user to update their own active record.
create policy "attendance: staff can clock out own record"
  on attendance_records for update
  using (user_id = auth.uid() and status = 'active');

-- ATT-04: GPS coordinate range constraints.
alter table attendance_records
  add constraint ck_clock_in_lat  check (clock_in_lat  is null or clock_in_lat  between -90 and 90),
  add constraint ck_clock_in_lng  check (clock_in_lng  is null or clock_in_lng  between -180 and 180),
  add constraint ck_clock_out_lat check (clock_out_lat is null or clock_out_lat between -90 and 90),
  add constraint ck_clock_out_lng check (clock_out_lng is null or clock_out_lng between -180 and 180);

-- ATT-08: Clock-out timestamp must not precede clock-in.
alter table attendance_records
  add constraint ck_clock_out_after_in
    check (clock_out_at is null or clock_out_at >= clock_in_at);
