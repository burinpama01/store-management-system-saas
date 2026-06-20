"use server";

import { revalidatePath } from "next/cache";
import { getResolvedCurrentPermissions, requirePermission } from "@/modules/auth/guards";
import { getCurrentUser, getUserStores, resolveCurrentStore } from "@/modules/auth/session";
import {
  createTransaction,
  deleteTransaction,
  getTransaction,
  listAccountingCategories,
  getLatestCashBalance,
  addCashLedgerEntry,
} from "@/modules/accounting/repository";
import type { TransactionType } from "@/modules/accounting/types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function getStoreContext() {
  const user = await getCurrentUser();
  if (!user) throw new Error("ไม่มีสิทธิ์เข้าถึง");
  const { organizations, stores, memberships } = await getUserStores();
  const ctx = await resolveCurrentStore(stores, organizations, memberships);
  if (!ctx) throw new Error("ไม่พบข้อมูลร้านค้า");
  return { user, ctx };
}

function revalidate() {
  revalidatePath("/accounting", "page");
}

export async function createTransactionAction(
  _prev: { error: string | null },
  formData: FormData,
): Promise<{ error: string | null }> {
  try {
    await requirePermission("cashflow.record");
    const { resolved } = await getResolvedCurrentPermissions();
    const canManageCashflow = resolved.can("cashflow.manage");
    const { user, ctx } = await getStoreContext();

    const type = formData.get("type") as TransactionType | null;
    const categoryId = (formData.get("categoryId") as string | null)?.trim() ?? "";
    const amountRaw = formData.get("amount") as string | null;
    const note = (formData.get("note") as string | null)?.trim() ?? "";
    const date = (formData.get("date") as string | null)?.trim() ?? "";

    if (!type || !["income", "expense", "cash_adjustment"].includes(type))
      return { error: "ประเภทรายการไม่ถูกต้อง" };
    if (type === "cash_adjustment" && !canManageCashflow)
      return { error: "ต้องมีสิทธิ์จัดการบัญชีเพื่อปรับเงินสด" };
    if (!UUID_RE.test(categoryId)) return { error: "กรุณาเลือกหมวดหมู่" };
    if (!DATE_RE.test(date) || isNaN(Date.parse(date)))
      return { error: "รูปแบบวันที่ไม่ถูกต้อง (YYYY-MM-DD)" };
    if (note.length > 200) return { error: "หมายเหตุยาวเกิน 200 ตัวอักษร" };

    const rawAmount = parseFloat(amountRaw ?? "");
    const amount = Math.round(rawAmount * 100) / 100;
    if (isNaN(amount) || amount <= 0 || amount > 10_000_000)
      return { error: "จำนวนเงินไม่ถูกต้อง (0.01 – 10,000,000)" };

    const catsRes = await listAccountingCategories(ctx.storeId);
    const category = catsRes.data?.find((c) => c.id === categoryId);
    if (!category) return { error: "ไม่พบหมวดหมู่นี้" };
    if (category.type !== type) return { error: "ประเภทไม่ตรงกับหมวดหมู่" };

    const txRes = await createTransaction({
      storeId: ctx.storeId,
      organizationId: ctx.organizationId,
      type,
      categoryId,
      categoryName: category.name,
      amount,
      note: note || undefined,
      date,
      createdByUserId: user.id,
    });
    if (txRes.error) return { error: txRes.error.userMessage };

    // Append to cash ledger — best-effort (TOCTOU risk accepted for MVP; see ISSUE-056)
    const delta = type === "expense" ? -amount : amount;
    const prevBalance = await getLatestCashBalance(ctx.storeId);
    await addCashLedgerEntry({
      storeId: ctx.storeId,
      organizationId: ctx.organizationId,
      type: type === "cash_adjustment" ? "adjustment" : type,
      amount: Math.abs(delta),
      balanceAfter: prevBalance + delta,
      transactionId: txRes.data!.id,
      createdByUserId: user.id,
    });

    revalidate();
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function deleteTransactionAction(id: string): Promise<{ error: string | null }> {
  try {
    await requirePermission("cashflow.manage");
    const { user, ctx } = await getStoreContext();

    if (!UUID_RE.test(id)) return { error: "ID ไม่ถูกต้อง" };

    // Fetch transaction to check guards (MN-01, CR-02)
    const txRes = await getTransaction(id, ctx.storeId);
    if (txRes.error || !txRes.data) return { error: "ไม่พบรายการ" };
    const tx = txRes.data;

    // MN-01: Block deletion of POS-linked transactions
    if (tx.orderId) return { error: "รายการที่เชื่อมกับออร์เดอร์ไม่สามารถลบได้" };

    // CR-02: Reverse the cash ledger entry to maintain balance integrity
    const originalDelta = tx.type === "expense" ? -tx.amount : tx.amount;
    const reversalDelta = -originalDelta;
    const prevBalance = await getLatestCashBalance(ctx.storeId);
    await addCashLedgerEntry({
      storeId: ctx.storeId,
      organizationId: ctx.organizationId,
      type: "adjustment",
      amount: Math.abs(reversalDelta),
      balanceAfter: prevBalance + reversalDelta,
      note: `ยกเลิก: ${tx.categoryName}`,
      createdByUserId: user.id,
    });

    const result = await deleteTransaction(id, ctx.storeId);
    if (result.error) return { error: result.error.userMessage };
    revalidate();
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}
