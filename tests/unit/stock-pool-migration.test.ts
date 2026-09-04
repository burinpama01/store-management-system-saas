import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const migrationPath = "supabase/migrations/20260905000001_stock_pools.sql";

function read(path: string) {
  return readFileSync(join(root, path), "utf8");
}

function migration() {
  expect(existsSync(join(root, migrationPath))).toBe(true);
  return read(migrationPath).toLowerCase().replace(/\s+/g, " ");
}

function tableSection(types: string, table: string, nextTable: string) {
  const start = types.indexOf(`      ${table}: {`);
  const end = types.indexOf(`      ${nextTable}: {`, start + 1);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return types.slice(start, end);
}

describe("stock pool schema migration", () => {
  it("defines tenant-scoped pools, one link per variant, and an append-only movement ledger", () => {
    const sql = migration();

    expect(sql).toMatch(/create table (if not exists )?public\.stock_pools \(.*?id uuid primary key default gen_random_uuid\(\).*?organization_id uuid not null references public\.organizations\(id\).*?store_id uuid not null references public\.stores\(id\).*?name text not null check \(btrim\(name\) <> ''\).*?unit_label text not null check \(btrim\(unit_label\) <> ''\).*?quantity integer not null default 0 check \(quantity >= 0\).*?low_stock_threshold integer not null default 5 check \(low_stock_threshold >= 0\).*?is_active boolean not null default true.*?created_at timestamptz not null default now\(\).*?updated_at timestamptz not null default now\(\)/);
    expect(sql).toMatch(/create table (if not exists )?public\.variant_stock_links \(.*?variant_id uuid primary key references public\.product_variants\(id\) on delete cascade.*?stock_pool_id uuid not null references public\.stock_pools\(id\).*?consumption_quantity integer not null check \(consumption_quantity > 0\).*?created_at timestamptz not null default now\(\)/);
    expect(sql).toMatch(/create table (if not exists )?public\.stock_movements \(.*?id uuid primary key default gen_random_uuid\(\).*?stock_pool_id uuid not null references public\.stock_pools\(id\).*?movement_type text not null check \(movement_type in \('receive', 'set_balance', 'sale', 'cancel_restore', 'item_void_restore', 'migration'\)\).*?quantity_delta integer not null.*?before_quantity integer not null.*?after_quantity integer not null.*?reason text.*?reference_type text.*?reference_id uuid.*?actor_id uuid.*?created_at timestamptz not null default now\(\)/);
  });

  it("adds nullable stock snapshots to order items without removing legacy variant stock", () => {
    const sql = migration();

    expect(sql).toContain("alter table public.order_items add column if not exists stock_pool_id uuid references public.stock_pools(id)");
    expect(sql).toContain("add column if not exists stock_units_per_item integer check (stock_units_per_item > 0)");
    expect(sql).not.toMatch(/alter table (public\.)?product_variants .*drop column .*stock_quantity/);
    expect(sql).not.toMatch(/alter table (public\.)?product_variants .*rename column .*stock_quantity/);
  });

  it("keeps stock snapshots paired and scoped to the owning order's tenant and store", () => {
    const sql = migration();

    expect(sql).toMatch(/add constraint order_items_stock_pool_snapshot_pair_check check \(\s*\(stock_pool_id is null and stock_units_per_item is null\) or \(stock_pool_id is not null and stock_units_per_item is not null\)\s*\)/);
    expect(sql).toContain("create or replace function public.enforce_order_item_stock_pool_scope()");
    expect(sql).toContain("select organization_id, store_id into v_order_organization_id, v_order_store_id from public.orders where id = new.order_id");
    expect(sql).toContain("select organization_id, store_id into v_pool_organization_id, v_pool_store_id from public.stock_pools where id = new.stock_pool_id");
    expect(sql).toContain("raise exception 'order item stock pool must belong to the order store and organization'");
    expect(sql).toContain("create trigger order_item_stock_pool_same_scope before insert or update of order_id, stock_pool_id, stock_units_per_item on public.order_items");
  });

  it("enables RLS and limits access through store membership", () => {
    const sql = migration();

    for (const table of ["stock_pools", "variant_stock_links", "stock_movements"]) {
      expect(sql).toContain(`alter table public.${table} enable row level security`);
    }

    expect(sql).toMatch(/create policy "stock_pools_select" on public\.stock_pools for select using \(auth_user_role_in_store\(organization_id, store_id, 'staff'\)\)/);
    expect(sql).toMatch(/create policy "stock_pools_manage" on public\.stock_pools for all using \(auth_user_role_in_store\(organization_id, store_id, 'manager'\)\) with check \(auth_user_role_in_store\(organization_id, store_id, 'manager'\)\)/);
    expect(sql).toMatch(/create policy "variant_stock_links_select" on public\.variant_stock_links for select using \(\s*exists \(\s*select 1 from public\.stock_pools sp where sp\.id = stock_pool_id and auth_user_role_in_store\(sp\.organization_id, sp\.store_id, 'staff'\)\s*\)\s*\)/);
    expect(sql).toMatch(/create policy "variant_stock_links_manage" on public\.variant_stock_links for all using \(\s*exists \(\s*select 1 from public\.stock_pools sp where sp\.id = stock_pool_id and auth_user_role_in_store\(sp\.organization_id, sp\.store_id, 'manager'\)\s*\)\s*\) with check \(\s*exists \(\s*select 1 from public\.stock_pools sp where sp\.id = stock_pool_id and auth_user_role_in_store\(sp\.organization_id, sp\.store_id, 'manager'\)\s*\)\s*\)/);
    expect(sql).toMatch(/create policy "stock_movements_select" on public\.stock_movements for select using \(\s*exists \(\s*select 1 from public\.stock_pools sp where sp\.id = stock_pool_id and auth_user_role_in_store\(sp\.organization_id, sp\.store_id, 'staff'\)\s*\)\s*\)/);
    expect(sql).toMatch(/create policy "stock_movements_insert" on public\.stock_movements for insert with check \(\s*exists \(\s*select 1 from public\.stock_pools sp where sp\.id = stock_pool_id and auth_user_role_in_store\(sp\.organization_id, sp\.store_id, 'manager'\)\s*\)\s*\)/);
  });

  it("rejects cross-tenant pools and cross-store variant links", () => {
    const sql = migration();

    expect(sql).toContain("create or replace function public.enforce_stock_pool_tenant()");
    expect(sql).toContain("select organization_id into v_store_organization_id from public.stores where id = new.store_id");
    expect(sql).toContain("raise exception 'stock pool store must belong to its organization'");
    expect(sql).toContain("create trigger stock_pool_same_tenant before insert or update on public.stock_pools");
    expect(sql).toContain("create or replace function public.enforce_variant_stock_link_store()");
    expect(sql).toContain("select p.store_id into v_variant_store_id from public.product_variants pv join public.products p on p.id = pv.product_id where pv.id = new.variant_id");
    expect(sql).toContain("select store_id into v_pool_store_id from public.stock_pools where id = new.stock_pool_id");
    expect(sql).toContain("raise exception 'variant and stock pool must belong to the same store'");
    expect(sql).toContain("create trigger variant_stock_link_same_store before insert or update on public.variant_stock_links");
  });

  it("rejects parent mutations that would invalidate an existing variant stock link", () => {
    const sql = migration();

    expect(sql).toContain("stock pool organization_id and store_id are immutable after insert");
    expect(sql).toContain("create or replace function public.enforce_product_stock_link_scope()");
    expect(sql).toContain("raise exception 'product scope cannot change while a linked variant uses a stock pool in the old scope'");
    expect(sql).toContain("create trigger product_stock_link_scope before update of organization_id, store_id on public.products");
    expect(sql).toContain("create or replace function public.enforce_variant_stock_link_product_scope()");
    expect(sql).toContain("raise exception 'variant product cannot change across a linked stock pool scope'");
    expect(sql).toContain("create trigger variant_stock_link_product_scope before update of product_id on public.product_variants");
  });

  it("makes pool scope immutable and rejects store or order scope changes once stock ownership exists", () => {
    const sql = migration();

    expect(sql).toContain("if tg_op = 'update' and (new.organization_id is distinct from old.organization_id or new.store_id is distinct from old.store_id) then raise exception 'stock pool organization_id and store_id are immutable after insert'");
    expect(sql).toContain("create or replace function public.enforce_store_stock_pool_organization()");
    expect(sql).toContain("if new.organization_id is distinct from old.organization_id and exists (select 1 from public.stock_pools where store_id = old.id) then raise exception 'store organization_id cannot change while stock pools exist'");
    expect(sql).toContain("create trigger store_stock_pool_organization_immutable before update of organization_id on public.stores");
    expect(sql).toContain("create or replace function public.enforce_order_stock_pool_scope()");
    expect(sql).toContain("if (new.organization_id is distinct from old.organization_id or new.store_id is distinct from old.store_id) and exists (select 1 from public.order_items where order_id = old.id and stock_pool_id is not null) then raise exception 'order organization_id and store_id cannot change while stock pool snapshots exist'");
    expect(sql).toContain("create trigger order_stock_pool_scope_immutable before update of organization_id, store_id on public.orders");
  });

  it("backfills tracked variants idempotently with a dedicated pool, link, and migration movement", () => {
    const sql = migration();

    expect(sql).toContain("do $$");
    // ตัวแปร loop ห้ามชื่อ v ซ้ำ alias ของตาราง มิฉะนั้น plpgsql ล้มด้วย
    // "record v is not assigned yet" ตั้งแต่ statement แรก (migration รันไม่ผ่านเลย)
    expect(sql).not.toContain("for v in");
    expect(sql).toContain("from public.product_variants pv join public.products p on p.id = pv.product_id where pv.track_stock = true");
    expect(sql).toContain("coalesce(nullif(btrim(v_row.unit_label), ''), 'unit')");
    expect(sql).toContain("greatest(coalesce(v_row.stock_quantity, 0), 0)");
    expect(sql).toContain("when v_row.stock_quantity < 0 then 'legacy variant stock backfill (negative quantity normalized to zero)'");
    expect(sql).toContain("if not exists (select 1 from public.variant_stock_links l where l.variant_id = v_row.id)");
    expect(sql).toContain("consumption_quantity) values (v_row.id, v_pool_id, 1)");
    expect(sql).toContain("'migration', v_quantity, 0, v_quantity, case");
    expect(sql).toContain("else 'legacy variant stock backfill'");
  });

  it("backfills only empty legacy order-item snapshots from their variant stock links", () => {
    const sql = migration();

    expect(sql).toContain("update public.order_items oi set stock_pool_id = l.stock_pool_id, stock_units_per_item = l.consumption_quantity from public.variant_stock_links l join public.stock_pools sp on sp.id = l.stock_pool_id, public.orders o");
    expect(sql).toContain("where oi.variant_id = l.variant_id and oi.order_id = o.id and oi.stock_pool_id is null and oi.stock_units_per_item is null");
    expect(sql).toContain("o.organization_id = sp.organization_id and o.store_id = sp.store_id");
    expect(sql).toContain("preflight: legacy order_items with variant links but mismatched order/pool scope remain without a stock snapshot");
    expect(sql).not.toContain("coalesce(oi.stock_pool_id, l.stock_pool_id)");
  });

  it("installs the first immutable snapshot guard only after the trusted backfill", () => {
    const sql = migration();
    const backfill = sql.indexOf("update public.order_items oi set stock_pool_id = l.stock_pool_id");
    const guard = sql.indexOf("create or replace function public.enforce_order_item_stock_pool_snapshot_immutable()");
    const trigger = sql.indexOf("create trigger order_item_stock_pool_snapshot_immutable", guard);

    expect(backfill).toBeGreaterThanOrEqual(0);
    expect(guard).toBeGreaterThan(backfill);
    expect(trigger).toBeGreaterThan(guard);
    expect(sql.slice(guard, trigger)).toContain("set search_path = public, pg_temp");
    expect(sql.slice(guard, trigger)).toContain("if tg_op = 'insert' then");
    expect(sql.slice(guard, trigger)).toContain("new.stock_pool_id is not null or new.stock_units_per_item is not null");
    expect(sql.slice(guard, trigger)).toContain("new.stock_pool_id is distinct from old.stock_pool_id or new.stock_units_per_item is distinct from old.stock_units_per_item");
    expect(sql.slice(guard, trigger)).not.toContain("stock_pool_name");
    expect(sql.slice(trigger)).toContain("before insert or update of stock_pool_id, stock_units_per_item on public.order_items");
  });

  it("guards movement arithmetic, pool freshness, and stock-pool access paths", () => {
    const sql = migration();

    expect(sql).toContain("check (before_quantity >= 0)");
    expect(sql).toContain("check (after_quantity >= 0)");
    expect(sql).toContain("check (after_quantity = before_quantity + quantity_delta)");
    expect(sql).toContain("create trigger stock_pools_set_updated_at before update on public.stock_pools for each row execute function public.set_updated_at()");
    expect(sql).toContain("create index if not exists variant_stock_links_stock_pool_id_idx on public.variant_stock_links(stock_pool_id)");
    expect(sql).toContain("create index if not exists stock_movements_stock_pool_created_at_idx on public.stock_movements(stock_pool_id, created_at desc)");
    expect(sql).toContain("create index if not exists order_items_stock_pool_id_idx on public.order_items(stock_pool_id)");
  });

  it("keeps generated database types aligned with the new tables and snapshots", () => {
    const types = read("src/server/integrations/supabase/database.types.ts");

    expect(types).toContain("stock_pools: {");
    expect(types).toContain("variant_stock_links: {");
    expect(types).toContain("stock_movements: {");
    expect(types).toContain("stock_pool_id: string | null;");
    expect(types).toContain("stock_units_per_item: number | null;");
    expect(types).toContain('movement_type: "receive" | "set_balance" | "sale" | "cancel_restore" | "item_void_restore" | "migration";');
  });

  it("exposes generated-style foreign-key relationships for pools, links, movements, and snapshots", () => {
    const types = read("src/server/integrations/supabase/database.types.ts");
    const stockPools = tableSection(types, "stock_pools", "variant_stock_links");
    const links = tableSection(types, "variant_stock_links", "stock_movements");
    const movements = tableSection(types, "stock_movements", "product_units");
    const orderItems = tableSection(types, "order_items", "payments");

    expect(stockPools).toContain(`foreignKeyName: "stock_pools_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]`);
    expect(stockPools).toContain(`foreignKeyName: "stock_pools_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]`);
    expect(links).toContain(`foreignKeyName: "variant_stock_links_variant_id_fkey"
            columns: ["variant_id"]
            isOneToOne: true
            referencedRelation: "product_variants"
            referencedColumns: ["id"]`);
    expect(links).toContain(`foreignKeyName: "variant_stock_links_stock_pool_id_fkey"
            columns: ["stock_pool_id"]
            isOneToOne: false
            referencedRelation: "stock_pools"
            referencedColumns: ["id"]`);
    expect(movements).toContain(`foreignKeyName: "stock_movements_stock_pool_id_fkey"
            columns: ["stock_pool_id"]
            isOneToOne: false
            referencedRelation: "stock_pools"
            referencedColumns: ["id"]`);
    expect(orderItems).toContain(`foreignKeyName: "order_items_stock_pool_id_fkey"
            columns: ["stock_pool_id"]
            isOneToOne: false
            referencedRelation: "stock_pools"
            referencedColumns: ["id"]`);
  });
});
