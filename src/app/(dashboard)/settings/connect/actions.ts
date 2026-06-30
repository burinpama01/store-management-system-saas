"use server";

import { revalidatePath } from "next/cache";
import { requireFeature, requirePermission } from "@/modules/auth/guards";
import { getCurrentUser, getUserStores, resolveCurrentStore } from "@/modules/auth/session";
import {
  createChannelLink,
  getChannelLinkById,
  getConnectOrderById,
  updateChannelLink,
} from "@/modules/connect/repository";
import { syncMenuForLink } from "@/modules/connect/menu-sync";
import { applyPosStatus } from "@/modules/connect/status-sync";
import { pushShopStatus } from "@/modules/connect/jdc-client";
import { CONNECT_CHANNEL_JDC, type FulfillmentStatus } from "@/modules/connect/types";

async function getStoreContext() {
  const user = await getCurrentUser();
  if (!user) throw new Error("ไม่มีสิทธิ์เข้าถึง");
  const { organizations, stores, memberships } = await getUserStores();
  const ctx = await resolveCurrentStore(stores, organizations, memberships);
  if (!ctx) throw new Error("ไม่พบข้อมูลร้านค้า");
  return { user, ctx };
}

export type ConnectActionState = { error: string | null; ok?: boolean; message?: string };

export async function createChannelLinkAction(
  _prev: ConnectActionState,
  formData: FormData,
): Promise<ConnectActionState> {
  try {
    await requirePermission("settings.manage_store");
    await requireFeature("apiIntegration");
    const { ctx } = await getStoreContext();

    const externalMerchantId = (formData.get("merchantId") as string | null)?.trim() ?? "";
    const autoAccept = formData.get("autoAccept") === "1";

    if (!externalMerchantId) return { error: "กรุณาระบุ merchant_id ของร้านฝั่ง JDC" };
    if (externalMerchantId.length > 100) return { error: "merchant_id ยาวเกินไป" };

    const res = await createChannelLink({
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      channel: CONNECT_CHANNEL_JDC,
      externalMerchantId,
      autoAccept,
    });
    if (!res.ok) return { error: res.error };

    revalidatePath("/settings/connect");
    return { error: null, ok: true, message: "เชื่อมช่องทาง JDC สำเร็จ — คัดลอก secret ไปตั้งฝั่ง JDC" };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function updateLinkAction(
  _prev: ConnectActionState,
  formData: FormData,
): Promise<ConnectActionState> {
  try {
    await requirePermission("settings.manage_store");
    const { ctx } = await getStoreContext();
    const linkId = (formData.get("linkId") as string | null)?.trim() ?? "";
    const intent = (formData.get("intent") as string | null)?.trim() ?? "";
    if (!linkId) return { error: "ไม่พบ link" };

    const patch =
      intent === "pause"
        ? { status: "paused" as const }
        : intent === "resume"
          ? { status: "active" as const }
          : intent === "autoaccept_on"
            ? { autoAccept: true }
            : intent === "autoaccept_off"
              ? { autoAccept: false }
              : null;
    if (!patch) return { error: "คำสั่งไม่ถูกต้อง" };

    const res = await updateChannelLink(ctx.organizationId, linkId, patch);
    if (!res.ok) return { error: res.error ?? "อัปเดตไม่สำเร็จ" };
    revalidatePath("/settings/connect");
    return { error: null, ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function syncMenuNowAction(
  _prev: ConnectActionState,
  formData: FormData,
): Promise<ConnectActionState> {
  try {
    await requirePermission("settings.manage_store");
    await requireFeature("apiIntegration");
    const { ctx } = await getStoreContext();
    const linkId = (formData.get("linkId") as string | null)?.trim() ?? "";
    const link = await getChannelLinkById(ctx.organizationId, linkId);
    if (!link) return { error: "ไม่พบช่องทางที่เชื่อม" };

    const res = await syncMenuForLink(link, true);
    if (!res.ok) return { error: res.error ?? "sync เมนูไม่สำเร็จ" };
    revalidatePath("/settings/connect");
    return {
      error: null,
      ok: true,
      message: `Sync เมนูสำเร็จ: ส่ง ${res.pushed} / ทั้งหมด ${res.total} รายการ`,
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function setShopStatusAction(
  _prev: ConnectActionState,
  formData: FormData,
): Promise<ConnectActionState> {
  try {
    await requirePermission("settings.manage_store");
    await requireFeature("apiIntegration");
    const { ctx } = await getStoreContext();
    const linkId = (formData.get("linkId") as string | null)?.trim() ?? "";
    const isOpen = formData.get("isOpen") === "1";
    const link = await getChannelLinkById(ctx.organizationId, linkId);
    if (!link) return { error: "ไม่พบช่องทางที่เชื่อม" };

    const res = await pushShopStatus(link, isOpen);
    if (!res.ok) return { error: `ส่งสถานะร้านไป JDC ไม่สำเร็จ (HTTP ${res.status})` };
    return { error: null, ok: true, message: isOpen ? "เปิดรับออเดอร์ JDC แล้ว" : "ปิดรับออเดอร์ JDC แล้ว" };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function updateDeliveryOrderStatusAction(
  _prev: ConnectActionState,
  formData: FormData,
): Promise<ConnectActionState> {
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
    revalidatePath("/settings/connect");
    return { error: null, ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}
