"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/modules/auth/guards";
import { getCurrentUser, getUserStores, resolveCurrentStore } from "@/modules/auth/session";
import { openCashSession, closeCashSession } from "@/modules/cashflow/repository";
import type { CashSession } from "@/modules/cashflow/types";

async function getStoreContext() {
  const user = await getCurrentUser();
  if (!user) throw new Error("ไม่มีสิทธิ์เข้าถึง");
  const { organizations, stores, memberships } = await getUserStores();
  const ctx = await resolveCurrentStore(stores, organizations, memberships);
  if (!ctx) throw new Error("ไม่พบข้อมูลร้านค้า");
  return { user, ctx };
}

function parseMoney(raw: unknown): number | null {
  const n = Math.round(parseFloat(String(raw ?? "")) * 100) / 100;
  if (isNaN(n) || n < 0 || n > 10_000_000) return null;
  return n;
}

export async function openCashSessionAction(
  openingFloat: number,
  note?: string,
): Promise<{ error: string | null }> {
  try {
    await requirePermission("pos.use");
    const { ctx } = await getStoreContext();

    const amount = parseMoney(openingFloat);
    if (amount === null) return { error: "ยอดเงินเปิดร้านไม่ถูกต้อง (0 – 10,000,000)" };
    if (note && note.length > 200) return { error: "หมายเหตุยาวเกิน 200 ตัวอักษร" };

    const result = await openCashSession(ctx.storeId, amount, note?.trim() || undefined);
    if (result.error) return { error: result.error.userMessage };

    revalidatePath("/pos", "page");
    revalidatePath("/accounting", "page");
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function closeCashSessionAction(
  sessionId: string,
  closingCount: number,
  note?: string,
): Promise<{ error: string | null; session: CashSession | null }> {
  try {
    await requirePermission("pos.use");
    const { ctx } = await getStoreContext();

    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(sessionId)) return { error: "รอบเงินสดไม่ถูกต้อง", session: null };

    const amount = parseMoney(closingCount);
    if (amount === null) return { error: "ยอดเงินนับจริงไม่ถูกต้อง (0 – 10,000,000)", session: null };
    if (note && note.length > 200) return { error: "หมายเหตุยาวเกิน 200 ตัวอักษร", session: null };

    const result = await closeCashSession(sessionId, ctx.storeId, amount, note?.trim() || undefined);
    if (result.error) return { error: result.error.userMessage, session: null };

    revalidatePath("/pos", "page");
    revalidatePath("/accounting", "page");
    return { error: null, session: result.data };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด", session: null };
  }
}
