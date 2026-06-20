import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("POS order creation RPC", () => {
  it("creates POS orders and items through a single database RPC", () => {
    const repo = read("src/modules/pos/order-repository.ts");
    const migration = read("supabase/migrations/20260601000005_pos_create_order_rpc.sql");

    expect(repo).toContain('supabase.rpc("create_pos_order_with_items"');
    expect(repo).not.toContain(".from(\"orders\")\n    .insert");
    expect(repo).not.toContain(".from(\"order_items\")\n    .insert");
    expect(repo).not.toContain("Attempt cleanup: delete orphaned order");
    expect(migration).toContain("create or replace function create_pos_order_with_items");
    expect(migration).toContain("jsonb_to_recordset");
    expect(migration).toContain("auth.uid() is null");
    expect(migration).toContain("p_cashier_id is distinct from auth.uid()");
    expect(migration).toContain("auth_user_role_in_store");
    expect(migration).toContain("p_items is null");
    expect(migration).toContain("jsonb_typeof(p_items) is distinct from 'array'");
    expect(migration).toContain("v_item_count is distinct from jsonb_array_length(p_items)");
    expect(migration).toContain("p_subtotal is null");
    expect(migration).toContain("p_discount is null");
    expect(migration).toContain("p_total is null");
    expect(migration).toContain("p_total is distinct from p_subtotal - p_discount");
    expect(migration).toContain("available_for_pos = true");
    expect(migration).toContain("product_variants");
    expect(migration).toContain("modifier_options");
    expect(migration).toContain("v_items_subtotal");
    expect(migration).toContain("p_subtotal is distinct from v_items_subtotal");
    expect(migration).toContain("from tables");
    expect(migration).toContain("p_table_id is not null");
    expect(migration).toContain("p_table_number is not null");
    expect(migration).toContain("เลขโต๊ะต้องมาจากระบบ");
    expect(migration).toContain("โต๊ะไม่ถูกต้อง");
    expect(migration).toContain("insert into orders");
    expect(migration).toContain("insert into order_items");
    expect(migration).toContain("revoke execute on function create_pos_order_with_items");
  });

  it("persists item-level discount metadata and validates discounted line totals", () => {
    const repo = read("src/modules/pos/order-repository.ts");
    const migration = read("supabase/migrations/20260618000001_pos_item_discounts.sql");

    expect(repo).toContain("discount_amount: item.discount ?? 0");
    expect(repo).toContain("discount_type: item.discountType ?? null");
    expect(repo).toContain("discount_value: item.discountValue ?? null");
    expect(repo).toContain("discount_note: item.discountNote ?? null");
    expect(repo).toContain("discount: row.discount_amount");
    expect(repo).toContain("discountType: row.discount_type ?? undefined");
    expect(repo).toContain("discountValue: row.discount_value ?? undefined");
    expect(repo).toContain("discountNote: row.discount_note ?? undefined");

    expect(migration).toContain("alter table order_items");
    expect(migration).toContain("discount_amount numeric(12,2) not null default 0");
    expect(migration).toContain("discount_type text");
    expect(migration).toContain("discount_value numeric(12,2)");
    expect(migration).toContain("discount_note text");
    expect(migration).toContain("discount_amount numeric");
    expect(migration).toContain("discount_type text");
    expect(migration).toContain("discount_value numeric");
    expect(migration).toContain("discount_note text");
    expect(migration).toContain("round(item.total_price, 2) = round(item.unit_price * item.quantity - coalesce(item.discount_amount, 0), 2)");
    expect(migration).toContain("discount_amount,");
    expect(migration).toContain("discount_type,");
    expect(migration).toContain("discount_value,");
    expect(migration).toContain("discount_note");
  });
});
