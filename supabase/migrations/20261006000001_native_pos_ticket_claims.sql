-- Native ticket consumption is durable and idempotent. Apply separately after review.
-- Dedicated source table: older web deployments cannot resume/clone native drafts.
create table public.native_pos_saved_tickets (
  id uuid primary key,
  organization_id uuid not null references public.organizations(id),
  store_id uuid not null,
  label text not null check (length(trim(label)) between 1 and 100),
  cart_snapshot jsonb not null,
  created_by_user_id uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (store_id, organization_id) references public.stores(id, organization_id),
  check (jsonb_typeof(cart_snapshot) = 'object' and cart_snapshot->>'storeId' = store_id::text and jsonb_typeof(cart_snapshot->'items') = 'array')
);
create index native_pos_saved_tickets_store_updated on public.native_pos_saved_tickets(store_id, updated_at desc);
alter table public.native_pos_saved_tickets enable row level security;
revoke all on public.native_pos_saved_tickets from public, anon, authenticated;
grant select on public.native_pos_saved_tickets to service_role;
create table public.native_pos_ticket_claims (
  claim_id uuid primary key,
  ticket_id uuid not null unique,
  organization_id uuid not null references public.organizations(id),
  store_id uuid not null references public.stores(id),
  actor_id uuid not null references auth.users(id),
  result jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.native_pos_ticket_claims enable row level security;
revoke all on public.native_pos_ticket_claims from public, anon, authenticated;
grant select, insert on public.native_pos_ticket_claims to service_role;

create function public.native_pos_ticket_result(p_claim_id uuid, p_ticket_id uuid, p_store_id uuid, p_actor_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_claim native_pos_ticket_claims%rowtype;
begin
  perform assert_native_pos_operation(p_store_id, 'native:' || p_store_id::text || ':' || p_actor_id::text || ':' || p_claim_id::text, p_actor_id);
  select * into v_claim from native_pos_ticket_claims where claim_id = p_claim_id;
  if not found then return null; end if;
  if v_claim.ticket_id <> p_ticket_id or v_claim.store_id <> p_store_id or v_claim.actor_id <> p_actor_id then
    return jsonb_build_object('error', 'คำขอเรียกบิลนี้ไม่ตรงกับผู้ใช้หรือร้านเดิม');
  end if;
  return v_claim.result;
end $$;

create function public.native_pos_claim_ticket(p_claim_id uuid, p_ticket_id uuid, p_store_id uuid, p_organization_id uuid, p_actor_id uuid, p_updated_at timestamptz, p_expected_cart jsonb, p_result jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_ticket native_pos_saved_tickets%rowtype; v_claim native_pos_ticket_claims%rowtype;
begin
  if assert_native_pos_operation(p_store_id, 'native:' || p_store_id::text || ':' || p_actor_id::text || ':' || p_claim_id::text, p_actor_id) <> p_organization_id then raise exception 'no_store_access'; end if;
  -- The same ticket serializes save/claim even when the source row is already gone.
  perform pg_advisory_xact_lock(hashtextextended(p_ticket_id::text, 0));
  select * into v_claim from native_pos_ticket_claims where claim_id = p_claim_id or ticket_id = p_ticket_id;
  if found then
    if v_claim.claim_id = p_claim_id and v_claim.ticket_id = p_ticket_id and v_claim.store_id = p_store_id and v_claim.organization_id = p_organization_id and v_claim.actor_id = p_actor_id then return v_claim.result; end if;
    return jsonb_build_object('error', 'บิลพักนี้ถูกเรียกแล้ว กรุณาตรวจคำขอเดิม');
  end if;
  select * into v_ticket from native_pos_saved_tickets where id = p_ticket_id and store_id = p_store_id and organization_id = p_organization_id for update;
  if not found then return jsonb_build_object('error', 'ไม่พบบิลพักในร้านนี้'); end if;
  if v_ticket.updated_at <> p_updated_at or v_ticket.cart_snapshot <> p_expected_cart then return jsonb_build_object('error', 'บิลพักเปลี่ยนแล้ว กรุณาโหลดใหม่'); end if;
  if p_result->>'id' is distinct from p_ticket_id::text or p_result->>'checkoutOperationId' is distinct from p_claim_id::text or jsonb_typeof(p_result->'lines') is distinct from 'array' then
    return jsonb_build_object('error', 'ข้อมูลผลการเรียกบิลไม่ถูกต้อง');
  end if;
  insert into native_pos_ticket_claims(claim_id, ticket_id, organization_id, store_id, actor_id, result)
    values(p_claim_id, p_ticket_id, p_organization_id, p_store_id, p_actor_id, p_result);
  delete from native_pos_saved_tickets where id = p_ticket_id and store_id = p_store_id;
  return p_result;
end $$;

create function public.native_pos_save_ticket(p_ticket_id uuid, p_store_id uuid, p_organization_id uuid, p_actor_id uuid, p_label text, p_cart jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_ticket native_pos_saved_tickets%rowtype;
begin
  if assert_native_pos_operation(p_store_id, 'native:' || p_store_id::text || ':' || p_actor_id::text || ':' || p_ticket_id::text, p_actor_id) <> p_organization_id then raise exception 'no_store_access'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_ticket_id::text, 0));
  if exists(select 1 from native_pos_ticket_claims where ticket_id = p_ticket_id) then return jsonb_build_object('error', 'บิลพักนี้ถูกเรียกแล้ว ห้ามบันทึกซ้ำ'); end if;
  if p_cart->>'storeId' <> p_store_id::text or jsonb_typeof(p_cart->'items') <> 'array' or length(trim(p_label)) not between 1 and 100 then return jsonb_build_object('error', 'ข้อมูลบิลพักไม่ถูกต้อง'); end if;
  select * into v_ticket from native_pos_saved_tickets where id = p_ticket_id for update;
  if found then
    -- Native saves are immutable; ambiguous retries cannot overwrite a shared bill.
    if v_ticket.store_id <> p_store_id or v_ticket.organization_id <> p_organization_id or v_ticket.created_by_user_id <> p_actor_id or v_ticket.cart_snapshot <> p_cart or v_ticket.label <> p_label then
      return jsonb_build_object('error', 'รหัสบิลพักมีข้อมูลเดิมแล้ว กรุณาตรวจบิลเดิม');
    end if;
  else
    insert into native_pos_saved_tickets(id, organization_id, store_id, label, cart_snapshot, created_by_user_id)
      values(p_ticket_id, p_organization_id, p_store_id, p_label, p_cart, p_actor_id) returning * into v_ticket;
  end if;
  return jsonb_build_object('ticket', jsonb_build_object('id', v_ticket.id, 'label', v_ticket.label, 'updatedAt', v_ticket.updated_at));
end $$;

revoke all on function public.native_pos_ticket_result(uuid, uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.native_pos_claim_ticket(uuid, uuid, uuid, uuid, uuid, timestamptz, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.native_pos_save_ticket(uuid, uuid, uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.native_pos_ticket_result(uuid, uuid, uuid, uuid) to service_role;
grant execute on function public.native_pos_claim_ticket(uuid, uuid, uuid, uuid, uuid, timestamptz, jsonb, jsonb) to service_role;
grant execute on function public.native_pos_save_ticket(uuid, uuid, uuid, uuid, text, jsonb) to service_role;


