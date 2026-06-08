import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("POS income linkage", () => {
  it("creates a POS-linked income transaction after payment closes", () => {
    const source = read("src/modules/pos/order-repository.ts");

    expect(source).toContain('supabase.rpc("close_pos_order_payment"');
    expect(source).not.toContain('.update({ status: "paid"');
    expect(source).not.toContain('.from("payments")\n    .insert');
  });

  it("POS payment close RPC links payment, accounting, ledger, and stock atomically", () => {
    const migration = read("supabase/migrations/20260601000004_pos_payment_close_rpc.sql");

    expect(migration).toContain("create or replace function close_pos_order_payment");
    expect(migration).toContain("auth.uid() is null");
    expect(migration).toContain("p_processed_by_user_id <> auth.uid()");
    expect(migration).toContain("auth_user_role_in_store");
    expect(migration).toContain("revoke execute on function close_pos_order_payment");
    expect(migration).toContain("grant execute on function close_pos_order_payment");
    expect(migration).toContain("p_amount <= 0");
    expect(migration).toContain("p_amount <> v_order.total");
    expect(migration).toContain("ยอดชำระไม่ตรงกับยอดออร์เดอร์");
    expect(migration).toContain("coalesce(p_received_amount, p_amount) < p_amount");
    expect(migration).toContain("v_net_cash <> p_amount");
    expect(migration).toContain("pg_advisory_xact_lock");
    expect(migration).toContain("update product_variants");
    expect(migration).toContain("join products");
    expect(migration).toContain("raise exception 'สินค้าไม่ถูกต้อง'");
    expect(migration).toContain("raise exception 'สินค้าเหลือไม่พอ'");
    expect(migration).toContain("insert into payments");
    expect(migration).toContain("insert into transactions");
    expect(migration).toContain("insert into cash_ledger_entries");
  });

  it("accounting repository can locate the default POS income category", () => {
    const source = read("src/modules/accounting/repository.ts");

    expect(source).toContain("getDefaultAccountingCategory");
    expect(source).toContain(".eq(\"is_default\", true)");
    expect(source).toContain("preferredName");
    expect(source).toContain(".maybeSingle()");
  });
});
