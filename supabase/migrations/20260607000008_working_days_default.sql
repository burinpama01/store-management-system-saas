-- Default employees to a 7-day work week. Days off come from admin-set store
-- holidays (store_holidays), not weekday assumptions — so shops open on weekends
-- work out of the box. Mon–Fri shops can uncheck Sat/Sun per employee.

alter table employee_profiles
  alter column working_days set default '{0,1,2,3,4,5,6}';

-- Promote existing rows still on the old Mon–Fri auto-default to all days.
update employee_profiles
   set working_days = '{0,1,2,3,4,5,6}'
 where working_days = '{1,2,3,4,5}';
