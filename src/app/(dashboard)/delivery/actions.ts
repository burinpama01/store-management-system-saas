"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/modules/auth/guards";
import { getCurrentUser, getUserStores, resolveCurrentStore } from "@/modules/auth/session";
import { getChannelLinkById, getConnectOrderById } from "@/modules/connect/repository";
import { applyPosStatus } from "@/modules/connect/status-sync";
import type { FulfillmentStatus } from "@/modules/connect/types";

export type DeliveryActionState = { error: string | null; ok?: boolean };

async function getStoreContext() {
  const user = await getCurrentUser();
  if (!user) throw new Error("ไม่มีสิทธิ์เข้าถึง");
  const { organizations, stores, memberships } = await getUserStores();
  const ctx = await resolveCurrentStore(stores, organizations, memberships);
  if (!ctx) throw new Error("ไม่พบข้อมูลร้านค้า");
  return { user, ctx };
}

/** อัปเดตสถานะออเดอร์เดลิเวอรีจากหน้าร้าน (POS) → push ไป JDC + กันกติกายกเลิก */
export async function updateDeliveryOrderStatusAction(
  _prev: DeliveryActionState,
  formData: FormData,
): Promise<DeliveryActionState> {
  try {
    await requirePermission("orders.manage_qr");
    const { ctx } = await getStoreContext();
    const connectOrderId = (formData.get("connectOrderId") as string | null)?.trim() ?? "";
    const next = (formData.get("next") as string | null)?.trim() as FulfillmentStatus;

    const co = await getConnectOrderById(ctx.organizationId, connectOrderId);
    if (!co) return { error: "ไม่พบออเดอร์" };
    const link = await getChannelLinkById(ctx.organizationId, co.linkId);
    if (!link) return { error: "ไม่พบช่องทางที่เชื่อม" };

    const res = await applyPosStatus(link, co, next);
    if (!res.ok) return { error: res.error };
    revalidatePath("/delivery");
    return { error: null, ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}
