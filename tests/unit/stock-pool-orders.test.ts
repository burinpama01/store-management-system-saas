import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const migrationPath = "supabase/migrations/20260905000004_stock_pool_order_rpcs.sql";

function readMaybe(path: string): string {
  const fullPath = join(root, path);
  return existsSync(fullPath) ? readFileSync(fullPath, "utf8") : "";
}

function normalized(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ");
}

function section(sql: string, start: string, end?: string): string {
  const startIndex = sql.indexOf(start);
  if (startIndex < 0) return "";
  const endIndex = end ? sql.indexOf(end, startIndex + start.length) : -1;
  return sql.slice(startIndex, endIndex < 0 ? undefined : endIndex);
}

describe("Task 5 Stock Pool order RPC migration", () => {
  const raw = readMaybe(migrationPath);
  const sql = normalized(raw);
  const types = normalized(readMaybe("src/server/integrations/supabase/database.types.ts"));

  it("uses a new append-only migration and preserves the four public RPC contracts", () => {
    expect(existsSync(join(root, migrationPath))).toBe(true);
    expect(sql).toContain("create or replace function public.create_qr_order_with_items(p_organization_id uuid, p_store_id uuid, p_table_id uuid, p_order_number text, p_subtotal numeric, p_items jsonb default '[]'::jsonb) returns uuid");
    expect(sql).toContain("create or replace function public.close_pos_order_payment( p_order_id uuid, p_store_id uuid, p_processed_by_user_id uuid, p_method text, p_amount numeric, p_received_amount numeric default null, p_change_amount numeric default null, p_reference text default null ) returns uuid");
    expect(sql).toContain("create or replace function public.cancel_qr_order_by_customer( p_store_id uuid, p_table_id uuid, p_order_id uuid ) returns void");
    // void_qr_order_item ถูก 20260901000004 เขียนใหม่เป็น wrapper ของ Unified POS แล้ว
    // migration นี้จึงต้อง "ไม่" นิยามทับ แต่แยกตรรกะคืน Pool เป็น helper ให้เรียกร่วม
    expect(sql).not.toContain("create or replace function public.void_qr_order_item(");
    expect(sql).toContain("create or replace function public.restore_voided_order_item_stock_pool( p_order_id uuid, p_item_id uuid, p_store_id uuid, p_organization_id uuid, p_reason text default null, p_actor_id uuid default null ) returns boolean");
    expect(sql.match(/security definer/g)?.length ?? 0).toBeGreaterThanOrEqual(7);
    expect(sql.match(/set search_path = public, pg_temp/g)?.length ?? 0).toBeGreaterThanOrEqual(7);
    expect(sql).toContain("grant execute on function public.create_qr_order_with_items(uuid, uuid, uuid, text, numeric, jsonb) to service_role");
    expect(sql).toContain("grant execute on function public.close_pos_order_payment(uuid, uuid, uuid, text, numeric, numeric, numeric, text) to authenticated");
    expect(sql).toContain("grant execute on function public.cancel_qr_order_by_customer(uuid, uuid, uuid) to service_role");
    expect(sql).toContain("revoke execute on function public.restore_voided_order_item_stock_pool(uuid, uuid, uuid, uuid, text, uuid) from anon, authenticated");
  });

  it("acquires one canonical relation-lock boundary before every cutover DDL statement", () => {
    const firstRelationDdl = Math.min(
      sql.indexOf("alter table public.order_items"),
      sql.indexOf("create table public.order_item_stock_pool_cutover_provenance"),
      sql.indexOf("create unique index if not exists stock_movements_reference_idempotency_idx"),
      sql.indexOf("create trigger order_item_stock_pool_snapshot_immutable"),
    );
    const canonicalLocks = [
      "lock table public.orders in exclusive mode",
      "lock table public.order_items in access exclusive mode",
      "lock table public.product_variants in exclusive mode",
      "lock table public.products in exclusive mode",
      "lock table public.stock_pools in exclusive mode",
      "lock table public.variant_stock_links in exclusive mode",
      "lock table public.stock_movements in exclusive mode",
    ];

    expect(firstRelationDdl).toBeGreaterThanOrEqual(0);
    let previousLock = -1;
    for (const lock of canonicalLocks) {
      const position = sql.indexOf(lock);
      expect(position).toBeGreaterThan(previousLock);
      expect(position).toBeLessThan(firstRelationDdl);
      previousLock = position;
    }

    expect(sql.match(/lock table public\./g)).toHaveLength(canonicalLocks.length);
    expect(sql.slice(firstRelationDdl)).not.toContain("lock table public.");
  });

  it("stores an immutable Pool id/name/consumption snapshot from active same-store links", () => {
    const snapshot = section(sql, "create or replace function public.snapshot_order_item_stock_pools", "create or replace function public.deduct_order_stock_pools");
    expect(sql).toContain("add column if not exists stock_pool_name text");
    expect(sql).toContain("set stock_pool_name = sp.name");
    expect(sql).toContain("order_items_stock_pool_snapshot_complete_check");
    expect(sql).toContain("create trigger order_item_stock_pool_snapshot_immutable");
    expect(sql).toContain("old.stock_pool_id is not null");
    expect(sql).toContain("new.stock_pool_id is distinct from old.stock_pool_id");
    expect(snapshot).toContain("l.stock_pool_id");
    expect(snapshot).toContain("sp.name");
    expect(snapshot).toContain("l.consumption_quantity");
    // ตรวจแค่ tenant (คนละร้าน/องค์กร) — ไม่ตรวจ is_active เพราะออเดอร์ที่เปิดค้างอยู่
    // ต้องปิดบิลได้เสมอแม้ร้านเพิ่งปิดเมนู/ปิด Pool นั้นไป
    expect(snapshot).not.toContain("sp.is_active = true");
    expect(snapshot).toContain("sp.store_id = p_store_id");
    expect(snapshot).toContain("sp.organization_id = p_organization_id");
    expect(snapshot).toContain("stock pool ของรายการไม่ถูกต้อง (คนละร้าน)");
  });

  it("rejects forged Pool snapshots on INSERT while allowing the trusted helper to populate them later", () => {
    const guard = section(sql, "create or replace function public.enforce_order_item_stock_pool_snapshot_immutable", "drop trigger if exists order_item_stock_pool_snapshot_immutable");
    const snapshot = section(sql, "create or replace function public.snapshot_order_item_stock_pools", "create or replace function public.deduct_order_stock_pools");
    expect(guard).toContain("if tg_op = 'insert' then");
    expect(guard).toContain("new.stock_pool_id is not null");
    expect(guard).toContain("new.stock_pool_name is not null");
    expect(guard).toContain("new.stock_units_per_item is not null");
    expect(guard).toContain("raise exception 'ห้ามกำหนด stock pool snapshot ตอนสร้างรายการออร์เดอร์'");
    expect(guard).toContain("pg_get_userbyid(c.relowner)");
    expect(guard).toContain("current_user is distinct from v_order_items_owner");
    expect(guard).toContain("raise exception 'กำหนด stock pool snapshot ได้เฉพาะ trusted helper'");
    expect(sql).toContain("before insert or update of stock_pool_id, stock_pool_name, stock_units_per_item");
    expect(snapshot).toContain("update public.order_items oi");
  });

  it("backs every cancellation and item-void restore with the original sale and immutable snapshot ledger", () => {
    const provenance = section(sql, "create or replace function public.assert_order_stock_pool_restore_provenance", "create or replace function public.deduct_order_stock_pools");
    const restore = section(sql, "create or replace function public.restore_cancelled_order_stock_pools", "create or replace function public.create_qr_order_with_items");
    const itemRestore = section(sql, "create or replace function public.restore_voided_order_item_stock_pool");
    expect(provenance).toContain("sm.movement_type = 'sale'");
    expect(provenance).toContain("sm.reference_type = 'order'");
    expect(provenance).toContain("sm.reference_id = p_order_id");
    expect(provenance).toContain("sum( oi.quantity::numeric * coalesce(oi.unit_quantity, 1)::numeric * oi.stock_units_per_item::numeric )");
    expect(provenance).toContain("v_snapshot_units is distinct from v_sale_units");
    expect(provenance).toContain("sm.movement_type in ('cancel_restore', 'item_void_restore')");
    expect(provenance).toContain("v_prior_restore_units + p_restore_units > v_original_units");
    expect(provenance).toContain("p_require_full_restore and v_prior_restore_units + p_restore_units is distinct from v_original_units");
    expect(restore).toContain("perform public.assert_order_stock_pool_restore_provenance( p_order_id, v_pool.id, v_restore.restore_units, true, null )");
    expect(itemRestore).toContain("perform public.assert_order_stock_pool_restore_provenance( p_order_id, v_pool.id, v_restore_units, false, p_item_id )");
    expect(sql).toContain("revoke all on function public.assert_order_stock_pool_restore_provenance(uuid, uuid, numeric, boolean, uuid) from public");
    expect(sql).toContain("revoke execute on function public.assert_order_stock_pool_restore_provenance(uuid, uuid, numeric, boolean, uuid) from anon, authenticated");
  });

  it("creates an owner-only immutable cutover marker with exact order-item consumption identity", () => {
    const cutover = section(sql, "create table public.order_item_stock_pool_cutover_provenance", "create or replace function public.enforce_order_item_stock_pool_snapshot_immutable");
    expect(cutover).toContain("order_item_id uuid primary key references public.order_items(id) on delete cascade");
    expect(cutover).toContain("order_id uuid not null references public.orders(id) on delete cascade");
    expect(cutover).toContain("stock_pool_id uuid not null references public.stock_pools(id)");
    expect(cutover).toContain("stock_pool_name text not null");
    expect(cutover).toContain("item_quantity integer not null check (item_quantity > 0)");
    expect(cutover).toContain("unit_quantity integer not null check (unit_quantity > 0)");
    expect(cutover).toContain("stock_units_per_item integer not null check (stock_units_per_item > 0)");
    expect(cutover).toContain("total_stock_units integer not null check (total_stock_units > 0)");
    expect(cutover).toContain("order_created_at timestamptz not null");
    expect(cutover).toContain("cutover_at timestamptz not null");
    expect(cutover).toContain("cutover_migration text not null check (cutover_migration = '20260905000004')");
    expect(cutover).toContain("alter table public.order_item_stock_pool_cutover_provenance enable row level security");
    expect(cutover).toContain("revoke all privileges on table public.order_item_stock_pool_cutover_provenance from public, anon, authenticated");
    expect(cutover).not.toContain("grant ");
    expect(types).toContain("order_item_stock_pool_cutover_provenance: {");
    expect(types).toContain("cutover_migration: string");
    expect(types).toContain("total_stock_units: number");
  });

  it("populates cutover markers only for validated pre-cutover open QR snapshots", () => {
    const cutover = section(sql, "create table public.order_item_stock_pool_cutover_provenance", "create or replace function public.enforce_order_item_stock_pool_snapshot_immutable");
    expect(cutover).toContain("if exists (");
    expect(cutover).toContain("o.qr_order_source is true");
    expect(cutover).toContain("o.status = 'open'");
    expect(cutover).toContain("coalesce(oi.voided, false) = false");
    expect(cutover).toContain("v_cutover_at timestamptz := transaction_timestamp()");
    expect(cutover).toContain("o.created_at < v_cutover_at");
    expect(cutover).toContain("l.stock_pool_id is distinct from oi.stock_pool_id");
    expect(cutover).toContain("l.consumption_quantity is distinct from oi.stock_units_per_item");
    expect(cutover).toContain("pv.product_id is distinct from oi.product_id");
    expect(cutover).toContain("sp.name is distinct from oi.stock_pool_name");
    expect(cutover).toContain("pv.is_active is distinct from true");
    expect(cutover).toContain("p.is_active is distinct from true");
    expect(cutover).toContain("sp.is_active is distinct from true");
    expect(cutover).toContain("p.organization_id is distinct from o.organization_id");
    expect(cutover).toContain("p.store_id is distinct from o.store_id");
    expect(cutover).toContain("sp.organization_id is distinct from o.organization_id");
    expect(cutover).toContain("sp.store_id is distinct from o.store_id");
    expect(cutover).toContain("raise exception 'ไม่สามารถยืนยัน stock pool snapshot ก่อน cutover ได้'");
    expect(cutover).toContain("insert into public.order_item_stock_pool_cutover_provenance");
    expect(cutover).toContain("pv.product_id = oi.product_id");
    expect(cutover).toContain("order by oi.id");
    expect(cutover).not.toContain("on conflict");
  });

  it("captures cutover provenance atomically under deterministic source locks and proves exact coverage", () => {
    const cutover = section(sql, "create table public.order_item_stock_pool_cutover_provenance", "create or replace function public.enforce_order_item_stock_pool_snapshot_immutable");
    const blockStart = cutover.indexOf("do $$");
    const blockEnd = cutover.indexOf("$$;", blockStart);
    const block = cutover.slice(blockStart, blockEnd);
    expect(blockStart).toBeGreaterThanOrEqual(0);
    expect(blockEnd).toBeGreaterThan(blockStart);
    expect(cutover.indexOf("do $$", blockStart + 1)).toBe(-1);
    expect(block).not.toContain("lock table public.");

    expect(block.indexOf("for share of o;")).toBeGreaterThanOrEqual(0);
    expect(block.indexOf("for share of oi;")).toBeGreaterThan(block.indexOf("for share of o;"));
    expect(block.indexOf("for share of pv;")).toBeGreaterThan(block.indexOf("for share of oi;"));
    expect(block.indexOf("for share of p;")).toBeGreaterThan(block.indexOf("for share of pv;"));
    expect(block.indexOf("for share of sp;")).toBeGreaterThan(block.indexOf("for share of p;"));
    expect(block.indexOf("for share of l;")).toBeGreaterThan(block.indexOf("for share of sp;"));

    const validation = block.indexOf("if exists (");
    const markerInsert = block.indexOf("insert into public.order_item_stock_pool_cutover_provenance");
    const postcondition = block.indexOf("if v_marker_count is distinct from v_candidate_count", markerInsert);
    expect(validation).toBeGreaterThan(block.indexOf("for share of l;"));
    expect(markerInsert).toBeGreaterThan(validation);
    expect(postcondition).toBeGreaterThan(markerInsert);
    expect(block).toContain("select count(*) into v_candidate_count");
    expect(block).toContain("get diagnostics v_marker_count = row_count");
    expect(block).toContain("or exists ( select oi.id");
    expect(block).toContain("or exists ( select cp.order_item_id");
    expect(block).toContain("raise exception 'cutover provenance ไม่ตรงกับ source แบบ 1:1'");
  });

  it("uses exact cutover provenance only when no modern sale exists and preserves the cumulative restore bound", () => {
    const provenance = section(sql, "create or replace function public.assert_order_stock_pool_restore_provenance", "create or replace function public.deduct_order_stock_pools");
    expect(provenance).toContain("p_order_item_id uuid default null");
    expect(provenance).toContain("if found then");
    expect(provenance).toContain("v_original_units := v_sale_units");
    expect(provenance).toContain("from public.order_item_stock_pool_cutover_provenance cp");
    expect(provenance).toContain("o.created_at = cp.order_created_at");
    expect(provenance).toContain("o.created_at < cp.cutover_at");
    expect(provenance).toContain("oi.order_id = cp.order_id");
    expect(provenance).toContain("oi.stock_pool_id = cp.stock_pool_id");
    expect(provenance).toContain("oi.stock_pool_name = cp.stock_pool_name");
    expect(provenance).toContain("oi.quantity = cp.item_quantity");
    expect(provenance).toContain("oi.unit_quantity = cp.unit_quantity");
    expect(provenance).toContain("oi.stock_units_per_item = cp.stock_units_per_item");
    expect(provenance).toContain("cp.total_stock_units = cp.item_quantity::numeric * cp.unit_quantity::numeric * cp.stock_units_per_item::numeric");
    expect(provenance).toContain("p_order_item_id is not null and cp.order_item_id = p_order_item_id");
    expect(provenance).toContain("raise exception 'ไม่พบ sale movement หรือ cutover provenance ที่เชื่อถือได้'");
    expect(provenance).toContain("v_prior_restore_units + p_restore_units > v_original_units");
    expect(provenance).toContain("p_require_full_restore and v_prior_restore_units + p_restore_units is distinct from v_original_units");
  });

  it("locks Variant, Product, Pool, and Link state before fail-closed snapshotting", () => {
    const snapshot = section(sql, "create or replace function public.snapshot_order_item_stock_pools", "create or replace function public.assert_order_stock_pool_restore_provenance");
    const variantLock = snapshot.indexOf("order by pv.id for update of pv");
    const productLock = snapshot.indexOf("order by p.id for update of p");
    const poolLock = snapshot.indexOf("order by sp.id for update of sp");
    const linkLock = snapshot.indexOf("order by l.variant_id for update of l");
    const snapshotUpdate = snapshot.indexOf("update public.order_items oi");
    expect(variantLock).toBeGreaterThanOrEqual(0);
    expect(productLock).toBeGreaterThan(variantLock);
    expect(poolLock).toBeGreaterThan(productLock);
    expect(linkLock).toBeGreaterThan(poolLock);
    expect(snapshotUpdate).toBeGreaterThan(linkLock);
    expect(snapshot).toContain("v_link_state_before text[]");
    expect(snapshot).toContain("v_link_state_after text[]");
    expect(snapshot).toContain("if v_link_state_after is distinct from v_link_state_before then");
    expect(snapshot).not.toContain("is_active is distinct from true");
    expect(snapshot).toContain("p.store_id is distinct from p_store_id");
    expect(snapshot).toContain("sp.store_id is distinct from p_store_id");
    expect(snapshot).toContain("p.store_id is distinct from p_store_id");
    expect(snapshot).toContain("p.organization_id is distinct from p_organization_id");
    expect(snapshot).toContain("sp.store_id is distinct from p_store_id");
    expect(snapshot).toContain("sp.organization_id is distinct from p_organization_id");
    expect(snapshot).toContain("raise exception 'stock pool link เปลี่ยนระหว่างสร้าง snapshot'");
  });

  it("allows legacy fallback only after proving no linked item remains unsnapshotted", () => {
    const snapshot = section(sql, "create or replace function public.snapshot_order_item_stock_pools", "create or replace function public.assert_order_stock_pool_restore_provenance");
    expect(snapshot).toContain("join public.variant_stock_links l on l.variant_id = oi.variant_id");
    expect(snapshot).toContain("oi.stock_pool_id is null or oi.stock_pool_name is null or oi.stock_units_per_item is null");
    expect(snapshot).toContain("raise exception 'มีรายการที่เชื่อม stock pool แต่ยังไม่มี snapshot'");
    expect(snapshot.lastIndexOf("if exists (")).toBeGreaterThan(snapshot.indexOf("update public.order_items oi"));
  });

  it("creates movement idempotency before any mutation and never hides a duplicate after deduction", () => {
    const indexPosition = sql.indexOf("create unique index if not exists stock_movements_reference_idempotency_idx");
    const helperPosition = sql.indexOf("create or replace function public.snapshot_order_item_stock_pools");
    expect(indexPosition).toBeGreaterThanOrEqual(0);
    expect(indexPosition).toBeLessThan(helperPosition);
    expect(sql).toContain("stock_pool_id, movement_type, reference_type, reference_id");
    expect(sql).toContain("where reference_type is not null and reference_id is not null");
    expect(sql).not.toContain("on conflict do nothing");
  });

  it("aggregates shared-Pool demand with Variant and pack multipliers before sorted row locks", () => {
    const deduct = section(sql, "create or replace function public.deduct_order_stock_pools", "create or replace function public.restore_cancelled_order_stock_pools");
    expect(deduct).toMatch(/sum\(\s*oi\.quantity::numeric \* coalesce\(oi\.unit_quantity, 1\)::numeric \* oi\.stock_units_per_item::numeric\s*\)/);
    expect(deduct).toContain("group by oi.stock_pool_id");
    expect(deduct).toContain("order by oi.stock_pool_id");
    expect(deduct).toContain("for update");
    expect(deduct).toContain("v_pool.store_id is distinct from p_store_id");
    expect(deduct).toContain("v_pool.organization_id is distinct from p_organization_id");
    expect(deduct).toContain("v_demand.required_units > 2147483647");
    expect(deduct).toContain("v_pool.quantity::bigint < v_demand.required_units");
    expect(deduct).toContain("raise exception 'สต๊อกไม่เพียงพอ'");
    const idempotencyCheck = deduct.indexOf("from public.stock_movements");
    const poolUpdate = deduct.indexOf("update public.stock_pools");
    const movementInsert = deduct.indexOf("insert into public.stock_movements");
    expect(idempotencyCheck).toBeGreaterThanOrEqual(0);
    expect(idempotencyCheck).toBeLessThan(poolUpdate);
    expect(poolUpdate).toBeLessThan(movementInsert);
    expect(deduct).toContain("'sale'");
    expect(deduct).toContain("'order'");
    expect(deduct).toContain("p_order_id");
  });

  it("deducts QR stock at create and POS stock at close without re-deducting QR orders", () => {
    const qr = section(sql, "create or replace function public.create_qr_order_with_items", "create or replace function public.close_pos_order_payment");
    const pos = section(sql, "create or replace function public.close_pos_order_payment", "create or replace function public.cancel_qr_order_by_customer");
    expect(qr).toContain("perform public.snapshot_order_item_stock_pools(v_order_id, p_store_id, p_organization_id)");
    expect(qr).toContain("perform public.deduct_order_stock_pools(v_order_id, p_store_id, p_organization_id, null)");
    expect(qr).toContain("insert into public.system_accounts");
    expect(qr).toContain("available_for_qr = true");
    expect(qr).toContain("with ordinality");
    expect(pos).toContain("if not coalesce(v_order.qr_order_source, false) then");
    expect(pos).toMatch(/perform public\.snapshot_order_item_stock_pools\(\s*p_order_id, p_store_id, v_order\.organization_id\s*\)/);
    expect(pos).toMatch(/perform public\.deduct_order_stock_pools\(\s*p_order_id, p_store_id, v_order\.organization_id, p_processed_by_user_id\s*\)/);
    expect(pos).toContain("insert into public.payments");
    expect(pos).toContain("insert into public.transactions");
    expect(pos).toContain("insert into public.cash_ledger_entries");
  });

  it("keeps legacy no-link Variant stock behavior while excluding Pool-backed lines", () => {
    const qr = section(sql, "create or replace function public.create_qr_order_with_items", "create or replace function public.close_pos_order_payment");
    const pos = section(sql, "create or replace function public.close_pos_order_payment", "create or replace function public.cancel_qr_order_by_customer");
    expect(qr).toContain("oi.stock_pool_id is null");
    expect(qr).toContain("update public.product_variants");
    expect(pos).toContain("oi.stock_pool_id is null");
    expect(pos).toContain("coalesce(oi.unit_quantity, 1)");
    expect(pos).toContain("update public.product_variants");
  });

  it("restores QR cancellation from non-voided snapshots and is repeat-safe", () => {
    const restore = section(sql, "create or replace function public.restore_cancelled_order_stock_pools", "create or replace function public.create_qr_order_with_items");
    const cancel = section(sql, "create or replace function public.cancel_qr_order_by_customer", "create or replace function public.void_qr_order_item");
    expect(restore).toContain("oi.stock_pool_id");
    expect(restore).toContain("oi.stock_units_per_item");
    expect(restore).toMatch(/sum\(\s*oi\.quantity::numeric \* coalesce\(oi\.unit_quantity, 1\)::numeric \* oi\.stock_units_per_item::numeric\s*\)/);
    expect(restore).toContain("coalesce(oi.voided, false) = false");
    expect(restore).not.toContain("variant_stock_links");
    expect(restore).toContain("order by oi.stock_pool_id");
    expect(restore).toContain("for update");
    expect(restore).toContain("v_pool.quantity::bigint + v_restore.restore_units > 2147483647");
    expect(restore).toContain("'cancel_restore'");
    expect(restore).toContain("'order'");
    expect(cancel).toContain("for update");
    expect(cancel).toContain("if v_order.status = 'cancelled' then return");
    expect(cancel).toContain("perform public.restore_cancelled_order_stock_pools");
    expect(cancel).toContain("oi.stock_pool_id is null");
  });

  it("restores a voided item from its immutable snapshot exactly once", () => {
    const itemRestore = section(sql, "create or replace function public.restore_voided_order_item_stock_pool");
    expect(itemRestore).toContain("v_item.stock_pool_id");
    expect(itemRestore).toContain("v_item.stock_units_per_item");
    expect(itemRestore).not.toContain("variant_stock_links");
    expect(itemRestore).toContain("for update");
    expect(itemRestore).toContain("if v_item.voided then return");
    expect(itemRestore).toContain("v_item.quantity::numeric * coalesce(v_item.unit_quantity, 1)::numeric * v_item.stock_units_per_item::numeric");
    expect(itemRestore).toContain("v_pool.quantity::bigint + v_restore_units > 2147483647");
    expect(itemRestore).toContain("'item_void_restore'");
    expect(itemRestore).toContain("'order_item'");
    expect(itemRestore).toContain("p_item_id");
    const idempotencyCheck = itemRestore.indexOf("from public.stock_movements");
    const poolUpdate = itemRestore.indexOf("update public.stock_pools");
    expect(idempotencyCheck).toBeGreaterThanOrEqual(0);
    expect(idempotencyCheck).toBeLessThan(poolUpdate);
    // helper แตะเฉพาะ Pool — การคืน variant stock เป็นหน้าที่ผู้เรียก และต้องข้าม
    // เมื่อ helper คืน true (รายการนี้อยู่ใต้ Pool แล้ว)
    expect(itemRestore).not.toContain("update public.product_variants");
  });

  it("bumps the release version in package and lock files", () => {
    const packageJson = JSON.parse(readMaybe("package.json")) as { version: string };
    const packageLock = JSON.parse(readMaybe("package-lock.json")) as { version: string; packages: { "": { version: string } } };
    // Stock Pool ออกที่ 0.43.0 — งานหลังจากนี้เดินเลขต่อไปได้ ข้อกำหนดจริงคือ
    // "ต้องไม่ย้อนกลับไปต่ำกว่ารุ่นที่ migration ชุดนี้ออก" และ lockfile ต้องตรงกับ package
    const atLeast = (version: string) => {
      const [major, minor, patch] = version.split(".").map(Number);
      return major > 0 || minor > 43 || (minor === 43 && patch >= 0);
    };
    expect(atLeast(packageJson.version)).toBe(true);
    expect(packageLock.version).toBe(packageJson.version);
    expect(packageLock.packages[""].version).toBe(packageJson.version);
  });
});
