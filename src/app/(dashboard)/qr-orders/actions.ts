"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/modules/auth/guards";
import { getCurrentUser, getUserStores, resolveCurrentStore } from "@/modules/auth/session";
import { updateOrderPrepStatus, resolveServiceRequest } from "@/modules/qr-ordering/repository";
import type { PrepStatus } from "@/modules/qr-ordering/types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREP_STATUSES: PrepStatus[] = ["new", "preparing", "served", "done"];

async function getStoreContext() {
  const user = await getCurrentUser();
  if (!user) throw new Error("ไม่มีสิทธิ์เข้าถึง");
  const { organizations, stores, memberships } = await getUserStores();
  const ctx = await resolveCurrentStore(stores, organizations, memberships);
  if (!ctx) throw new Error("ไม่พบข้อมูลร้านค้า");
  return { user, ctx };
}

export async function updatePrepStatusAction(
  orderId: string,
  prepStatus: PrepStatus,
): Promise<{ error: string | null }> {
  try {
    await requirePermission("orders.manage_qr");
    const { ctx } = await getStoreContext();
    if (!UUID_RE.test(orderId)) return { error: "ออร์เดอร์ไม่ถูกต้อง" };
    if (!PREP_STATUSES.includes(prepStatus)) return { error: "สถานะไม่ถูกต้อง" };

    const result = await updateOrderPrepStatus(orderId, ctx.storeId, prepStatus);
    if (result.error) return { error: result.error.userMessage };
    revalidatePath("/qr-orders", "page");
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function resolveServiceRequestAction(id: string): Promise<{ error: string | null }> {
  try {
    await requirePermission("orders.manage_qr");
    const { user, ctx } = await getStoreContext();
    if (!UUID_RE.test(id)) return { error: "คำขอไม่ถูกต้อง" };

    const result = await resolveServiceRequest(id, ctx.storeId, user.id);
    if (result.error) return { error: result.error.userMessage };
    revalidatePath("/qr-orders", "page");
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}
