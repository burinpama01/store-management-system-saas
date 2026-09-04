-- The database must enforce the same stock feature access as the server action;
-- SECURITY DEFINER keeps subscription rows private while RLS can call this predicate.
create or replace function public.organization_has_stock_management(p_organization_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.subscriptions s
    where s.organization_id = p_organization_id
      and s.status in ('active', 'trialing', 'past_due')
      -- ทุกแพ็กเกจต้องยังไม่หมดอายุ รวมถึง enterprise — ให้ตรงกับ getPlanFeatures
      -- (src/modules/billing/types.ts) ที่ตัดสิทธิ์เป็น free เมื่อพ้น current_period_end
      -- ไม่งั้น DB จะใจดีกว่าแอป: org ที่หมดอายุยิง PostgREST ตรงได้แต่กดในแอปไม่ได้
      and (
        (s.plan in ('standard', 'premium') and s.current_period_end > now())
        or (s.plan = 'enterprise' and s.current_period_end > now())
        or (
          s.plan = 'business'
          and s.current_period_end > now()
          and s.business_seats between 1 and 500
          and s.business_stores between 1 and 50
          and jsonb_typeof(s.business_features) = 'array'
          and s.business_features @> '["stockManagement"]'::jsonb
        )
      )
  );
$$;

revoke all on function public.organization_has_stock_management(uuid) from public;
revoke execute on function public.organization_has_stock_management(uuid) from anon;
grant execute on function public.organization_has_stock_management(uuid) to authenticated;
grant execute on function public.organization_has_stock_management(uuid) to service_role;

-- Pool quantity changes must update the append-only ledger in the same transaction.
create or replace function public.adjust_stock_pool(
  p_pool_id uuid,
  p_mode text,
  p_quantity integer,
  p_reason text default null
)
returns public.stock_pools
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pool public.stock_pools%rowtype;
  v_before integer;
  v_after integer;
  v_after_bigint bigint;
  v_reason text;
begin
  select * into v_pool
  from public.stock_pools
  where id = p_pool_id
  for update;

  if not found then
    raise exception 'stock pool not found';
  end if;

  if auth.uid() is null
    or not public.auth_user_has_permission(v_pool.organization_id, v_pool.store_id, 'stock.manage')
    or not public.organization_has_stock_management(v_pool.organization_id) then
    raise exception 'stock pool adjustment requires stock.manage and stockManagement access';
  end if;

  if p_mode not in ('receive', 'set_balance') then
    raise exception 'invalid stock pool adjustment mode';
  end if;

  if p_quantity is null or p_quantity < 0 then
    raise exception 'stock pool quantity must be a nonnegative integer';
  end if;

  v_reason := nullif(btrim(coalesce(p_reason, '')), '');
  if p_mode = 'receive' and p_quantity <= 0 then
    raise exception 'received quantity must be greater than zero';
  end if;
  if p_mode = 'set_balance' and nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'set balance requires a reason';
  end if;

  v_before := v_pool.quantity;
  if p_mode = 'receive' then
    v_after_bigint := v_before::bigint + p_quantity::bigint;
  else
    v_after_bigint := p_quantity::bigint;
  end if;

  if v_after_bigint < 0 or v_after_bigint > 2147483647 then
    raise exception 'stock pool quantity exceeds integer range';
  end if;
  v_after := v_after_bigint::integer;

  update public.stock_pools
  set quantity = v_after
  where id = v_pool.id
  returning * into v_pool;

  insert into public.stock_movements (
    stock_pool_id,
    movement_type,
    quantity_delta,
    before_quantity,
    after_quantity,
    reason,
    actor_id
  ) values (
    v_pool.id,
    p_mode,
    v_after - v_before,
    v_before,
    v_after,
    v_reason,
    auth.uid()
  );

  return v_pool;
end;
$$;

-- Managers may create zero-balance pools and edit metadata, but cannot bypass
-- the ledger by writing a nonzero balance or directly altering movements.
revoke insert (quantity), update (quantity) on table public.stock_pools from authenticated;
revoke insert, update on table public.stock_pools from authenticated;
grant insert (organization_id, store_id, name, unit_label, low_stock_threshold, is_active)
on table public.stock_pools to authenticated;
grant update (name, unit_label, low_stock_threshold, is_active)
on table public.stock_pools to authenticated;

-- Preserve read access, but make every direct write use effective permission
-- overrides plus the same plan entitlement as the RPC.
drop policy if exists "stock_pools_manage" on public.stock_pools;
create policy "stock_pools_manage"
on public.stock_pools for all to authenticated
using (
  public.auth_user_has_permission(organization_id, store_id, 'stock.manage')
  and public.organization_has_stock_management(organization_id)
)
with check (
  public.auth_user_has_permission(organization_id, store_id, 'stock.manage')
  and public.organization_has_stock_management(organization_id)
);

drop policy if exists "variant_stock_links_manage" on public.variant_stock_links;
create policy "variant_stock_links_manage"
on public.variant_stock_links for all to authenticated
using (
  exists (
    select 1 from public.stock_pools sp
    where sp.id = stock_pool_id
      and public.auth_user_has_permission(sp.organization_id, sp.store_id, 'stock.manage')
      and public.organization_has_stock_management(sp.organization_id)
  )
)
with check (
  exists (
    select 1 from public.stock_pools sp
    where sp.id = stock_pool_id
      and public.auth_user_has_permission(sp.organization_id, sp.store_id, 'stock.manage')
      and public.organization_has_stock_management(sp.organization_id)
  )
);

drop policy if exists "stock_movements_insert" on public.stock_movements;
create policy "stock_movements_insert"
on public.stock_movements for insert to authenticated
with check (
  exists (
    select 1 from public.stock_pools sp
    where sp.id = stock_pool_id
      and public.auth_user_has_permission(sp.organization_id, sp.store_id, 'stock.manage')
      and public.organization_has_stock_management(sp.organization_id)
  )
);

revoke all privileges on table public.stock_movements from authenticated;
grant select on table public.stock_movements to authenticated;
revoke all privileges on table public.stock_movements from anon;
revoke all privileges on table public.stock_movements from public;

revoke all on function public.adjust_stock_pool(uuid, text, integer, text) from public;
revoke execute on function public.adjust_stock_pool(uuid, text, integer, text) from anon;
grant execute on function public.adjust_stock_pool(uuid, text, integer, text) to authenticated;
grant execute on function public.adjust_stock_pool(uuid, text, integer, text) to service_role;
