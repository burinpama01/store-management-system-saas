import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("accounting transaction payment method (cash vs transfer)", () => {
  it("adds the payment_method column + types", () => {
    const migration = "supabase/migrations/20260627140000_transaction_payment_method.sql";
    expect(existsSync(join(root, migration))).toBe(true);
    expect(read(migration)).toContain(
      "add column if not exists payment_method text not null default 'cash'",
    );
    expect(read(migration)).toContain("check (payment_method in ('cash', 'transfer'))");

    const types = read("src/modules/accounting/types.ts");
    expect(types).toContain('export type AccountingPaymentMethod = "cash" | "transfer"');
    expect(types).toContain("paymentMethod: AccountingPaymentMethod");
  });

  it("persists the method and only cash moves the cash drawer", () => {
    const repo = read("src/modules/accounting/repository.ts");
    expect(repo).toContain("payment_method: input.paymentMethod ?? \"cash\"");
    expect(repo).toContain("payment_method?: string | null");

    const actions = read("src/app/(dashboard)/accounting/actions.ts");
    expect(actions).toContain('formData.get("paymentMethod")');
    expect(actions).toContain("paymentMethod,");
    // cash ledger only for cash transactions, on both create and delete
    expect(actions).toContain('if (paymentMethod === "cash")');
    expect(actions).toContain('if (tx.paymentMethod === "cash")');
  });

  it("exposes the method selector + badge in the UI", () => {
    const manager = read("src/app/(dashboard)/accounting/AccountingManager.tsx");
    expect(manager).toContain('name="paymentMethod"');
    expect(manager).toContain("วิธีชำระ");
    expect(manager).toContain("ไม่กระทบเงินสดในลิ้นชัก");
    expect(manager).toContain('tx.paymentMethod === "transfer"');
  });
});
