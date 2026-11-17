import { notifyOwnerSafely } from "@/modules/notifications/dispatcher";
import { logSystemEvent } from "@/modules/system/event-log";
import { claimOnlineOrderNotification, getOnlineOrderById, type OnlineOrder } from "./repository";

/**
 * แจ้งร้านว่ามีออเดอร์ออนไลน์ที่จ่ายแล้ว — ครั้งเดียวต่อออเดอร์ (claim notified_at)
 * เรียกได้จากทุกทาง: webhook Beam (ทางหลัก — ลูกค้าปิดหน้าไปแล้วก็ยังแจ้ง), ถาม Beam ผ่าน API, หน้าติดตามของลูกค้า
 */
export async function notifyOnlineOrderPaidOnce(orderOrId: OnlineOrder | string): Promise<boolean> {
  const order = typeof orderOrId === "string" ? await getOnlineOrderById(orderOrId) : orderOrId;
  if (!order || order.notifiedAt || order.status !== "paid") return false;
  if (!(await claimOnlineOrderNotification(order.id))) return false;
  const fulfillment = order.fulfillment === "pickup" ? "รับที่ร้าน" : "ส่งถึงบ้าน";
  notifyOwnerSafely({
    type: "new_online_order",
    organizationId: order.organizationId,
    storeId: order.storeId,
    title: "มีออเดอร์ออนไลน์ใหม่ (จ่ายแล้ว)",
    message: `${fulfillment} ${order.orderCode} ยอด ${order.total.toFixed(2)}`,
    metadata: { onlineOrderId: order.id, orderNumber: order.orderCode, total: order.total, fulfillment, source: "online" },
  });
  void logSystemEvent({
    level: "info",
    source: "online-orders",
    action: "onlineOrderPaid",
    message: `คำสั่งซื้อออนไลน์ ${order.orderCode} จ่ายแล้ว — แจ้งร้าน`,
    organizationId: order.organizationId,
    storeId: order.storeId,
    context: { onlineOrderId: order.id, total: order.total },
  });
  return true;
}
