import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");
const readMaybe = (path: string) => {
  const fullPath = join(root, path);
  return existsSync(fullPath) ? readFileSync(fullPath, "utf8") : "";
};
const latestPosPaymentMigration =
  "supabase/migrations/20260623124138_pos_income_category_autocreate.sql";

describe("POS income linkage", () => {
  it("creates a POS-linked income transaction after payment closes", () => {
    const source = read("src/modules/pos/order-repository.ts");

    expect(source).toContain('supabase.rpc("close_pos_order_payment"');
    expect(source).not.toContain('.update({ status: "paid"');
    expect(source).not.toContain('.from("payments")\n    .insert');
  });

  it("POS payment close RPC links payment, accounting, ledger, and stock atomically", () => {
    const migration = read(latestPosPaymentMigration);

    expect(migration).toContain("create or replace function close_pos_order_payment");
    expect(migration).toContain("auth.uid() is null");
    expect(migration).toContain("p_processed_by_user_id <> auth.uid()");
    expect(migration).toContain("auth_user_has_permission");
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

  it("latest POS payment close RPC creates the POS income category when a store is missing one", () => {
    const migration = readMaybe(latestPosPaymentMigration);

    expect(migration).toContain("insert into accounting_categories");
    expect(migration).toContain("'ยอดขาย POS'");
    expect(migration).toContain("and name = 'ยอดขาย POS'");
    expect(migration).not.toContain("and (name = 'ยอดขาย POS' or is_default = true)");
    expect(migration).toContain("returning * into v_category");
  });

  it("latest accounting migration aligns category writes with permission overrides and unique category names", () => {
    const migration = read(latestPosPaymentMigration);

    expect(migration).toContain('drop policy if exists "accounting_categories: manager+ can write"');
    expect(migration).toContain('create policy "accounting_categories: cashflow.manage can write"');
    expect(migration).toContain(
      "auth_user_has_permission(organization_id, store_id, 'cashflow.manage')",
    );
    expect(migration).toContain(
      "create unique index if not exists accounting_categories_store_type_name_unique_idx",
    );
    expect(migration).toContain("lower(btrim(name))");
    expect(migration).toContain("row_number() over");
    expect(migration).toContain("update transactions");
  });

  it("accounting repository can locate the default POS income category", () => {
    const source = read("src/modules/accounting/repository.ts");

    expect(source).toContain("getDefaultAccountingCategory");
    expect(source).toContain(".eq(\"is_default\", true)");
    expect(source).toContain("preferredName");
    expect(source).toContain(".maybeSingle()");
  });

  it("accounting UI exposes income and expense category creation", () => {
    const repository = read("src/modules/accounting/repository.ts");
    const actions = read("src/app/(dashboard)/accounting/actions.ts");
    const ui = read("src/app/(dashboard)/accounting/AccountingManager.tsx");

    expect(repository).toContain("createAccountingCategory");
    expect(repository).toContain(".from(\"accounting_categories\")");
    expect(actions).toContain("createAccountingCategoryAction");
    expect(actions).toContain("categoryName");
    expect(actions).toContain("cashflow.manage");
    expect(actions).toContain('result.error.code === "23505"');
    expect(actions).toContain("มีหมวดหมู่นี้แล้ว");
    expect(ui).toContain("createAccountingCategoryAction");
    expect(ui).toContain("เพิ่มหมวดหมู่");
    expect(ui).toContain("name=\"categoryName\"");
  });
});
