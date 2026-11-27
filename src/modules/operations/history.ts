import { CHECKLIST_ANSWER_LABELS, type ChecklistAnswer, type ChecklistEvent } from "./types";

function answerText(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "-";
  const entry = raw as { answer?: ChecklistAnswer; value?: number | null; note?: string | null };
  const parts = [entry.answer ? CHECKLIST_ANSWER_LABELS[entry.answer] : "-"];
  if (entry.value !== null && entry.value !== undefined) parts.push(`ค่า ${entry.value}`);
  if (entry.note) parts.push(`“${entry.note}”`);
  return parts.join(" · ");
}

export function describeChecklistEvent(event: ChecklistEvent): string {
  const detail = event.detail;
  const label = typeof detail.label === "string" ? detail.label : "";
  switch (event.action) {
    case "run_started":
      return "เริ่มเช็กลิสต์";
    case "item_answered":
      return `ตอบ “${label}”: ${answerText(detail.after)}${detail.out_of_range ? " (ค่าเกินช่วง)" : ""}`;
    case "item_changed":
      return `แก้ “${label}”: ${answerText(detail.before)} → ${answerText(detail.after)}`;
    case "photo_attached":
      return `${detail.replaced ? "เปลี่ยนรูป" : "แนบรูป"} “${label}”`;
    case "run_submitted":
      return `ส่งเช็กลิสต์ (ไม่ผ่าน ${Number(detail.fail_count ?? 0)} ข้อ, สำคัญ ${Number(detail.critical_fail_count ?? 0)})`;
    case "run_reopened":
      return `เปิดให้แก้ใหม่ — เหตุผล: ${String(detail.reason ?? "-")}`;
    case "template_created":
      return `สร้างเช็กลิสต์ “${String(detail.name ?? "")}” (${Number(detail.item_count ?? 0)} ข้อ)`;
    case "template_updated":
      return `แก้เช็กลิสต์ “${String(detail.name ?? "")}” เป็นฉบับที่ ${Number(detail.version ?? 0)} (${Number(detail.item_count ?? 0)} ข้อ${detail.is_active === false ? ", ปิดใช้" : ""})`;
    default:
      return event.action;
  }
}
