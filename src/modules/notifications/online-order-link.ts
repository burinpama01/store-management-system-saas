/** ดึง onlineOrderId จาก metadata ของแจ้งเตือน new_online_order (ข้อมูลจาก DB — ตรวจรูปทรงก่อนใช้) */
export function onlineOrderIdFromMetadata(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const id = (metadata as Record<string, unknown>).onlineOrderId;
  return typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : null;
}
