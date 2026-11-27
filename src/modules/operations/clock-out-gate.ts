import { logSystemEvent } from "@/modules/system/event-log";
import { isOperationsEnabled, listChecklistTemplates, listSubmittedTemplateIds } from "./repository";
import { formatClockOutBlockMessage, pendingClockOutChecklists } from "./rules";

/**
 * กฎเจ้าของข้อ 1: ผู้รับผิดชอบเช็กลิสต์ที่ตั้ง "ต้องเสร็จก่อนออกงาน" ออกงานไม่ได้จนกว่าจะส่ง
 * คืนข้อความบล็อก หรือ null = ออกงานได้
 *
 * อ่านข้อมูลไม่ได้ = ปล่อยออกงาน (fail-open) แต่ทิ้ง log warn — ไม่ให้พนักงานติดอยู่ที่ร้าน
 * เพราะฐานข้อมูลสะดุด; เช็กลิสต์ที่ไม่ส่งยังขึ้นเลยกำหนดและแจ้งเจ้าของตามปกติ
 */
export async function checkClockOutChecklistGate(input: {
  organizationId: string;
  storeId: string;
  userId: string;
  shiftDate: string;
}): Promise<string | null> {
  if (!(await isOperationsEnabled(input.storeId))) return null;

  const [templates, submitted] = await Promise.all([
    listChecklistTemplates(input.storeId),
    listSubmittedTemplateIds(input.storeId, input.shiftDate),
  ]);
  if (templates.error !== null || submitted.error !== null) {
    await logSystemEvent({
      level: "warn",
      source: "operations.checklist",
      action: "clockOutGate",
      message: "อ่านเช็กลิสต์ตอนออกงานไม่ได้ — ปล่อยออกงาน",
      organizationId: input.organizationId,
      storeId: input.storeId,
      actorUserId: input.userId,
      context: { error: templates.error ?? submitted.error, shiftDate: input.shiftDate },
    });
    return null;
  }

  const pending = pendingClockOutChecklists(templates.data, submitted.data, input.userId, input.shiftDate);
  if (pending.length === 0) return null;

  await logSystemEvent({
    level: "info",
    source: "operations.checklist",
    action: "clockOutGate",
    message: `บล็อกออกงาน: ยังไม่ส่ง ${pending.map((template) => template.name).join(", ")}`,
    organizationId: input.organizationId,
    storeId: input.storeId,
    actorUserId: input.userId,
    context: { shiftDate: input.shiftDate, templateIds: pending.map((template) => template.id) },
  });
  return formatClockOutBlockMessage(pending);
}
