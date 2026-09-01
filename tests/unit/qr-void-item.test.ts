import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("QR kitchen void line item (out of stock)", () => {
  it("migration adds voided columns + a stock-restoring void RPC", () => {
    const sql = read("supabase/migrations/20260701000002_void_qr_order_item.sql");
    expect(sql).toContain("add column if not exists voided boolean not null default false");
    expect(sql).toContain("create or replace function void_qr_order_item");
    // Only cashier+ of the store may void.
    expect(sql).toContain("auth_user_role_in_store(v_org, p_store_id, 'cashier')");
    // Restores the stock deducted at creation.
    expect(sql).toContain("stock_quantity = coalesce(stock_quantity, 0) + v_qty");
    // Recomputes the order total from remaining lines; cancels when none left.
    expect(sql).toContain("from order_items");
    expect(sql).toContain("update orders set status = 'cancelled'");
  });

  it("kitchen board wires the void action per item", () => {
    const board = read("src/app/(dashboard)/qr-orders/QrOrdersBoard.tsx");
    expect(board).toContain("voidQrOrderItemAction");
    expect(board).toContain("ของหมด");
    // Voided lines are struck through.
    expect(board).toContain('it.voided ? "text-gray-300 line-through"');
  });

  it("customer tracking shows voided lines struck through", () => {
    const app = read("src/app/qr/[storeSlug]/[tableId]/QrOrderingApp.tsx");
    expect(app).toContain("it.voided");
    expect(app).toContain("voidedReason");
  });
});

describe("U6 — governed item reject + legacy void wrapper (v0.35.6)", () => {
  const sql = read("supabase/migrations/20260901000004_unified_pos_reject.sql");

  it("adds a governed reject RPC with receipt-based idempotency", () => {
    expect(sql).toContain("create or replace function public.unified_pos_reject_order_item");
    // Serialize same-key + receipt tombstone (replay/conflict) — same semantics as U4/U5
    expect(sql).toContain("pg_advisory_xact_lock");
    expect(sql).toContain("from public.unified_pos_operation_receipts");
    expect(sql).toContain("'item_reject'");
    expect(sql).toContain("'replayed','result'");
    expect(sql).toContain("'hash_conflict'");
  });

  it("canonical void stays on the boolean only (never fulfillment_status)", () => {
    expect(sql).toContain("voided = true");
    expect(sql).toContain("voided_reason = v_reason");
    // dual truth ห้ามเกิด: โค้ด (ไม่รวม comment) ห้ามเขียน fulfillment_status='voided'
    const code = sql
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    expect(code).not.toMatch(/fulfillment_status\s*=\s*'voided'/);
  });

  it("guards: fail-closed flag, permission, open+unpaid order, locked rows", () => {
    // flag ปิด = fail closed (up_store_flag_disabled)
    expect(sql).toContain("unified_pos_enabled = true");
    expect(sql).toContain("'up_store_flag_disabled'");
    // permission เดียวกับ action layer (orders.manage_qr ≈ cashier+ ของ legacy)
    expect(sql).toContain("public.user_has_permission_in_store(p_actor_user_id, p_organization_id, p_store_id, 'orders.manage_qr')");
    // paid/closed ปฏิเสธที่ระดับ order
    expect(sql).toContain("v_order.status <> 'open' or v_order.paid_at is not null");
    expect(sql).toContain("'up_invalid_state_transition'");
    // FOR UPDATE locks on order + item (กัน concurrent restore ซ้ำ)
    expect(sql).toContain("for update");
  });

  it("restores tracked stock exactly once, scoped to the store; untracked skips", () => {
    expect(sql).toContain("coalesce(pv.stock_quantity, 0) + v_item.quantity");
    expect(sql).toContain("pv.track_stock = true");
    expect(sql).toContain("p.organization_id = p_organization_id");
    expect(sql).toContain("p.store_id = p_store_id");
    expect(sql).toContain("if v_item.variant_id is not null then");
  });

  it("recalculates totals from remaining active items using the submit RPC calculation source", () => {
    // แหล่งเดียวกับ submit/validate: sum(total_price) ของ active items (voided=false)
    expect(sql).toContain("where order_id = p_order_id\n     and voided = false");
    // total = subtotal - discount (สูตร canonical ของ pos_create_order) clamp ≥ 0
    expect(sql).toContain("greatest(round(v_subtotal - v_discount, 2), 0)");
    // ไม่เหลือ active → ปิดออเดอร์แบบ legacy parity
    expect(sql).toContain("'cancelled' else v_order.status end");
  });

  it("audits the result as unified_pos.item_reject", () => {
    expect(sql).toContain("'unified_pos.item_reject'");
  });

  it("keeps void_qr_order_item as a flags-gated wrapper (flag off → legacy body, flag on → canonical)", () => {
    // signature + grants เดิม
    expect(sql).toContain("create or replace function public.void_qr_order_item(\n  p_store_id uuid,\n  p_order_id uuid,\n  p_item_id uuid,\n  p_reason text default null\n)");
    // ทางเลือก flags-gated ระบุชัดใน migration comment
    expect(sql).toContain("flags-gated");
    // gating: อ่าน flag ก่อนเลือกเส้นทาง
    expect(sql).toContain("coalesce(unified_pos_enabled, false)");
    // flag on → route เข้า canonical path
    expect(sql).toContain("public.unified_pos_reject_order_item(");
    // flag off → legacy body คงเดิมทุกอย่าง (สิทธิ์ cashier+ / QR-only / restore สต๊อก)
    expect(sql).toContain("auth_user_role_in_store(v_org, p_store_id, 'cashier')");
    expect(sql).toContain("เฉพาะออเดอร์ที่สั่งผ่าน QR");
    expect(sql).toContain("stock_quantity = coalesce(stock_quantity, 0) + v_qty");
  });

  it("grants: new RPC is service_role only, wrapper stays authenticated-only", () => {
    expect(sql).toContain("grant execute on function public.unified_pos_reject_order_item(uuid, uuid, uuid, uuid, text, text, uuid, text) to service_role");
    expect(sql).toContain("grant execute on function public.void_qr_order_item(uuid, uuid, uuid, text) to authenticated");
  });

  it("exposes the new RPC in database.types.ts", () => {
    const types = read("src/server/integrations/supabase/database.types.ts");
    expect(types).toContain("unified_pos_reject_order_item: {");
    expect(types).toContain("p_actor_user_id: string;\n          p_reason?: string | null;");
  });
});
