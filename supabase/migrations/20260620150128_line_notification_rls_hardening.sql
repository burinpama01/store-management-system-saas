-- Keep LINE identity/chat bindings server-controlled.
-- Owners may read status through RLS, but writes must go through webhook/service-role flows.

drop policy if exists "line_account_links: owner can update" on line_account_links;
drop policy if exists "line_notification_targets: owner can update" on line_notification_targets;

revoke update on table line_account_links from anon, authenticated;
revoke update on table line_notification_targets from anon, authenticated;
