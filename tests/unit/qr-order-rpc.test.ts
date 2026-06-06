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
    expect(action).not.toContain(".from(\"order_items\")");
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
});
