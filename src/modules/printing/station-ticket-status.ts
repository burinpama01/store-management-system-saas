/**
 * กติกาตัดสินงานพิมพ์ "เดิม" ของตั๋วสถานี (ออเดอร์, สถานี) — pure ใช้ได้ทั้ง server/client
 *
 *   pending / claimed / printed → ครัวได้/กำลังจะได้ตั๋วแล้ว → ไม่ออกซ้ำ
 *   failed (Hub ยืนยันว่าไม่ออก) → ต้องส่งใหม่ (ถ้ายังไม่ถูกย้ายไปออกเครื่อง USB)
 *   unknown (lease หมด ไม่รู้ว่าออกไหม) → ห้ามส่งเองอัตโนมัติ ต้องให้คนดูกระดาษจริง
 */

/** ข้อความท้าย error ของงานที่ Hub ย้ายไปออกเครื่อง USB แล้ว — ใบนั้นออกแล้ว ห้ามส่งซ้ำ */
export const USB_RETARGET_NOTE = "ส่งใบนี้ออกที่เครื่องพิมพ์ USB ที่เสียบอยู่แทนแล้ว";

export type PrintJobStatus = "pending" | "claimed" | "printed" | "failed" | "unknown";

export function isRetargetedToUsb(job: { error: string | null }): boolean {
  return job.error?.includes(USB_RETARGET_NOTE) ?? false;
}

export type PriorStationTicketDecision = "print" | "skip" | "uncertain";

export function decidePriorStationTicket(
  prior: { status: PrintJobStatus; error: string | null } | undefined,
): PriorStationTicketDecision {
  if (!prior) return "print";
  if (prior.status === "unknown") return "uncertain";
  if (prior.status === "failed" && !isRetargetedToUsb(prior)) return "print";
  return "skip";
}
