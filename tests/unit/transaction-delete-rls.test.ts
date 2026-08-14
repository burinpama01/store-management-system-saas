import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");
const migration = "supabase/migrations/20260804000000_transactions_delete_policy.sql";

describe("deleting a cashflow transaction actually deletes it", () => {
  it("adds the missing DELETE policy on transactions, gated by cashflow.manage", () => {
    expect(existsSync(join(root, migration))).toBe(true);
    const sql = read(migration);

    expect(sql).toContain('drop policy if exists "transactions: cashflow.manage can delete"');
    expect(sql).toContain("on transactions for delete");
    expect(sql).toContain("auth_user_has_permission(organization_id, store_id, 'cashflow.manage')");
    // POS-linked income must be voided through the order, never deleted from the ledger UI
    expect(sql).toContain("order_id is null");
  });

  it("repository treats a 0-row delete as a failure instead of silent success", () => {
    const repo = read("src/modules/accounting/repository.ts");
    const deleteFn = repo.slice(
      repo.indexOf("export async function deleteTransaction"),
      repo.indexOf("export interface ListTransactionsOpts"),
    );

    expect(deleteFn).toContain('.select("id")');
    expect(deleteFn).toContain("data.length === 0");
    expect(deleteFn).toContain("ลบรายการไม่สำเร็จ");
    expect(deleteFn).toContain("ok: false");
  });

  it("confirms deletion with an in-app dialog, not window.confirm", () => {
    const ui = read("src/app/(dashboard)/accounting/AccountingManager.tsx");

    // window.confirm never opens inside the mobile app WebView / cross-origin iframes:
    // it returns false straight away and the delete silently does nothing.
    expect(ui).not.toMatch(/(?<!\w)confirm\(/);
    expect(ui).toContain("deleteTarget");
    expect(ui).toContain("ยืนยันการลบรายการ");
    // the warning must match the payment method — transfers never touch the drawer
    expect(ui).toContain("ไม่กระทบยอดเงินสดในลิ้นชัก");
  });

  it("action deletes first and only then reverses the cash ledger", () => {
    const actions = read("src/app/(dashboard)/accounting/actions.ts");
    const deleteAction = actions.slice(actions.indexOf("export async function deleteTransactionAction"));

    const deleteAt = deleteAction.indexOf("await deleteTransaction(id, ctx.storeId)");
    const ledgerAt = deleteAction.indexOf("await addCashLedgerEntry(");
    expect(deleteAt).toBeGreaterThan(-1);
    expect(ledgerAt).toBeGreaterThan(deleteAt);

    // a failed reversal after a successful delete must be surfaced, not swallowed
    expect(deleteAction).toContain("if (ledgerRes.error)");
    expect(deleteAction).toContain("ปรับยอดเงินสดในลิ้นชักไม่สำเร็จ");
  });
});
