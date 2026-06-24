-- Ensure each store has one active permanent member signup QR.
with ranked_active_links as (
  select
    id,
    row_number() over (partition by store_id order by created_at desc, id desc) as active_rank
  from customer_member_portal_links
  where is_active = true
)
update customer_member_portal_links links
set
  is_active = false,
  updated_at = now()
from ranked_active_links ranked
where links.id = ranked.id
  and ranked.active_rank > 1;

create unique index if not exists customer_member_portal_links_one_active_per_store_idx
  on customer_member_portal_links(store_id)
  where is_active = true;
