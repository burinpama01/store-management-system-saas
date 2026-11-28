import { notifyOwnerSafely } from "@/modules/notifications/dispatcher";
import { logSystemEvent } from "@/modules/system/event-log";
import { claimAdOrderNotification, getAdOrderById } from "./server";

/**
 * แจ้งร้านว่ามีคนลงโฆษณาที่จ่ายแล้ว — ครั้งเดียวต่อคำสั่ง (claim notified_at)
 * เรียกได้จากทุกทาง: webhook Beam (ทางหลัก), ถาม Beam ผ่าน API, หน้าสถานะของผู้ลง, ตรวจสลิปผ่าน
 * ขึ้นจอทันที (โหมดเริ่มต้น) → ร้านต้องรู้ทันทีเพื่อถอดได้ถ้าเนื้อหาไม่เหมาะสม
 */
export async function notifyAdOrderPaidOnce(orderId: string): Promise<boolean> {
  const order = await getAdOrderById(orderId);
  if (!order || order.notifiedAt || (order.status !== "active" && order.status !== "pending_review")) return false;
  if (!(await claimAdOrderNotification(order.id))) return false;
  const statusText = order.status === "active" ? "ขึ้นจอแล้ว ถอดได้ที่ ตั้งค่า → รับลงโฆษณา" : "รอร้านอนุมัติ ที่ ตั้งค่า → รับลงโฆษณา";
  notifyOwnerSafely({
    type: "ad_order",
    organizationId: order.organizationId,
    storeId: order.storeId,
    title: "มีคนลงโฆษณาบนจอร้าน",
    message: `${order.advertiserName} ลง ${order.packageName} ยอด ${order.amount.toFixed(2)} — ${statusText}`,
    metadata: {
      adOrderId: order.id,
      advertiser: order.advertiserName,
      packageName: order.packageName,
      amount: order.amount,
      statusText,
    },
  });
  void logSystemEvent({
    level: "info",
    source: "ad-self-serve",
    action: "adOrderPaid",
    message: `โฆษณา ${order.packageName} จาก ${order.advertiserName} จ่ายแล้ว (${order.paymentMethod ?? "-"}) → ${order.status} — แจ้งร้าน`,
    organizationId: order.organizationId,
    storeId: order.storeId,
    context: { adOrderId: order.id, amount: order.amount, status: order.status, paymentMethod: order.paymentMethod },
  });
  return true;
}
