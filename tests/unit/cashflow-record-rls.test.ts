import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const migration = "supabase/migrations/20260626150000_cashflow_record_rls.sql";

describe("cashflow record RLS aligns with cashflow.record permission", () => {
  it("lets anyone with cashflow.record insert transactions + cash ledger entries", () => {
    expect(existsSync(join(root, migration))).toBe(true);
    const sql = readFileSync(join(root, migration), "utf8");

    // old manager+/cashier+ policies are replaced
    expect(sql).toContain('drop policy if exists "transactions: manager+ can write" on transactions');
    expect(sql).toContain('drop policy if exists "cash_ledger: cashier+ can insert" on cash_ledger_entries');

    // both inserts now check the cashflow.record permission (cashier + staff hold it)
    expect(sql).toContain("on transactions for insert");
    expect(sql).toContain("on cash_ledger_entries for insert");
    expect(sql).toMatch(/with check \(auth_user_has_permission\(organization_id, store_id, 'cashflow\.record'\)\)/);
    expect((sql.match(/auth_user_has_permission\(organization_id, store_id, 'cashflow\.record'\)/g) ?? []).length).toBe(2);
  });
});
