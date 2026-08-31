import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("QR order transaction RPC", () => {
  it("creates QR orders/items/system account and decrements stock through one RPC", () => {
    const action = read("src/app/qr/[storeSlug]/[tableId]/actions.ts");
    const migration = read("supabase/migrations/20260601000006_qr_order_rpc.sql");

    expect(action).toContain('supabase.rpc("create_qr_order_with_items"');
    expect(action).toContain("timezone");
    expect(action).toContain("generateOrderNumber({ timeZone: store.timezone })");
    expect(action).not.toContain("QR_CASHIER_ID");
    expect(action).not.toContain(".from(\"orders\")\n    .insert");
    // Order/item creation must go through the RPC; read-only tracking SELECTs are allowed.
    expect(action).not.toContain(".from(\"order_items\")\n    .insert");
    expect(action).not.toContain("Best-effort cleanup");
    expect(migration).toContain("create table if not exists system_accounts");
    expect(migration).toContain("alter table system_accounts enable row level security");
    expect(migration).toContain("revoke all on system_accounts");
    expect(migration).toContain("create or replace function create_qr_order_with_items");
    expect(migration).toContain("insert into system_accounts");
    expect(migration).toContain("system_account_id");
    expect(migration).toContain("available_for_qr = true");
    expect(migration).toContain("missing required modifier");
    expect(migration).toContain("too many modifier selections");
    expect(migration).toContain("invalid single-choice modifier selection");
    expect(migration).toContain("duplicate modifier option");
    expect(migration).toContain("with ordinality");
    expect(migration).toContain("line_number");
    expect(migration).toContain("round(item.unit_price, 2)");
    expect(migration).toContain("round(p_subtotal, 2)");
    expect(migration).toContain("round(item.total_price, 2)");
    expect(migration).toContain("update product_variants");
    expect(migration).toContain("order by item.variant_id");
    expect(migration).toContain("raise exception 'สินค้าเหลือไม่พอ'");
    expect(migration).toContain("insert into orders");
    expect(migration).toContain("insert into order_items");
    expect(migration).toContain("revoke execute on function create_qr_order_with_items");
    expect(migration).toContain("grant execute on function create_qr_order_with_items");
  });

  // U4 (v0.35.4): เส้นทาง v2 (atomic + idempotent, flag-gated) อยู่คู่กับ v1 จนกว่า cutover
  // พฤติกรรม runtime ของ v2 ครอบคลุมใน tests/unit/qr-order-submit.test.ts (behavior),
  // supabase/tests/003_unified_pos_rpc.sql (pgTAP) และ tests/integration/unified-pos-rpc.test.ts
  it("U4: action วางเส้นทาง v2/v1 คู่กัน และ migration v2 มี engine + idempotency + grants ครบ", () => {
    const action = read("src/app/qr/[storeSlug]/[tableId]/actions.ts");
    const v2Migration = read("supabase/migrations/20260901000002_unified_pos_rpc.sql");

    // เส้นทางใหม่ (flag unified_pos_enabled = true) — เลือก RPC ตามเส้นทางใน action
    expect(action).toContain('"add_items_to_table_v2"');
    expect(action).toContain('"create_qr_order_with_items_v2"');
    expect(action).toContain("computeRequestHash");
    expect(action).toContain("unified_pos_enabled");
    // เส้นทางเดิมยังอยู่ครบ (flag false → พฤติกรรมเดิมทุกอย่าง)
    expect(action).toContain('supabase.rpc("create_qr_order_with_items"');

    expect(v2Migration).toContain("create or replace function public.create_qr_order_with_items_v2");
    expect(v2Migration).toContain("create or replace function public.add_items_to_table_v2");
    expect(v2Migration).toContain("create or replace function public.unified_pos_submit_table_order");
    expect(v2Migration).toContain("pg_advisory_xact_lock");
    expect(v2Migration).toContain("unified_pos_operation_receipts");
    expect(v2Migration).toContain("user_has_permission_in_store");
    expect(v2Migration).toContain("up_store_flag_disabled");
    expect(v2Migration).toContain("up_session_not_active");
    expect(v2Migration).toContain("up_stock_insufficient");
    expect(v2Migration).toContain("revoke execute on function public.create_qr_order_with_items_v2");
    expect(v2Migration).toContain("grant execute on function public.create_qr_order_with_items_v2");
  });
});
