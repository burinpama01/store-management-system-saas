import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("QR order RPC fix (ordinality + nullable cashier)", () => {
  const sql = read("supabase/migrations/20260701000000_fix_qr_order_rpc.sql");

  it("makes orders.cashier_id nullable", () => {
    expect(sql).toContain("alter table orders alter column cashier_id drop not null");
  });

  it("no longer uses the illegal WITH ORDINALITY + column definition list", () => {
    // jsonb_to_recordset(...) WITH ORDINALITY AS item(cols...) throws at runtime.
    expect(sql).not.toMatch(/with ordinality as item\(/i);
    // Ordinality must come from jsonb_array_elements (single column) instead.
    expect(sql.toLowerCase()).toContain("jsonb_array_elements(p_items) with ordinality");
    expect(sql.toLowerCase()).toContain("cross join lateral jsonb_to_recordset(jsonb_build_array");
  });

  it("sets cashier_id NULL for QR orders (attribution via system_account_id)", () => {
    // The insert values list: table_number, then cashier_id (null), then system_account_id.
    expect(sql).toMatch(/v_table_number,\s*null,\s*v_system_account_id,/);
  });
});
