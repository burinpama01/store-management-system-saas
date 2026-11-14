import type {
  ChecklistPhase,
  ChecklistPhotoRule,
  ChecklistRun,
  ChecklistTemplate,
  ChecklistValueType,
  Readiness,
  TemplateInput,
  TemplateItemInput,
} from "./types";

/** วันในสัปดาห์ของวันที่ "YYYY-MM-DD" (0 = อาทิตย์) — ไม่ขึ้นกับ timezone เครื่อง */
export function dayOfWeek(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function templateAppliesOn(template: Pick<ChecklistTemplate, "isActive" | "daysOfWeek">, date: string): boolean {
  return template.isActive && template.daysOfWeek.includes(dayOfWeek(date));
}

/**
 * เช็กลิสต์ที่ผู้ใช้ "รับผิดชอบ" และต้องส่งก่อนออกงานของกะ shiftDate แต่ยังไม่ส่ง
 * (คำตอบเจ้าของข้อ 1: พนักงานที่รับผิดชอบออกงานไม่ได้ถ้ายังไม่ทำเช็กลิสต์)
 */
export function pendingClockOutChecklists(
  templates: ChecklistTemplate[],
  submittedTemplateIds: ReadonlySet<string>,
  userId: string,
  shiftDate: string,
): ChecklistTemplate[] {
  return templates.filter(
    (template) =>
      template.requireBeforeClockOut &&
      template.assigneeUserIds.includes(userId) &&
      templateAppliesOn(template, shiftDate) &&
      !submittedTemplateIds.has(template.id),
  );
}

export function formatClockOutBlockMessage(pending: Pick<ChecklistTemplate, "name">[]): string {
  const names = pending.map((template) => `“${template.name}”`).join(", ");
  return `ยังออกงานไม่ได้ — ทำเช็กลิสต์ให้เสร็จก่อน: ${names} (เมนู งานหน้าร้าน)`;
}

export interface AreaReadiness {
  area: string;
  readiness: Readiness;
  reasons: string[];
}

/**
 * ความพร้อมรายพื้นที่จากผลตรวจจริงของวันนั้น — ไม่ใช้คะแนนเฉลี่ย:
 *   ข้อสำคัญไม่ผ่าน = NOT_READY, ข้อทั่วไปไม่ผ่าน = LIMITED,
 *   เช็กลิสต์เปิดร้านที่ใช้วันนี้ส่งครบและไม่มีข้อไม่ผ่าน = READY, นอกนั้น UNKNOWN
 */
export function computeAreaReadiness(
  templates: ChecklistTemplate[],
  runs: ChecklistRun[],
  shiftDate: string,
): AreaReadiness[] {
  const areas = new Set<string>();
  for (const template of templates) if (templateAppliesOn(template, shiftDate)) areas.add(areaKey(template.area));
  for (const run of runs) areas.add(areaKey(run.area));

  return [...areas].sort((a, b) => a.localeCompare(b, "th")).map((area) => {
    const areaRuns = runs.filter((run) => areaKey(run.area) === area && run.shiftDate === shiftDate);
    const criticalFails = areaRuns.flatMap((run) =>
      run.items.filter((item) => item.critical && item.answer === "fail").map((item) => `${run.templateName}: ${item.label}`),
    );
    if (criticalFails.length > 0) return { area, readiness: "NOT_READY" as const, reasons: criticalFails };

    const fails = areaRuns.flatMap((run) =>
      run.items.filter((item) => item.answer === "fail").map((item) => `${run.templateName}: ${item.label}`),
    );
    if (fails.length > 0) return { area, readiness: "LIMITED" as const, reasons: fails };

    const openTemplates = templates.filter(
      (template) => areaKey(template.area) === area && template.phase === "open" && templateAppliesOn(template, shiftDate),
    );
    const missing = openTemplates.filter(
      (template) => !areaRuns.some((run) => run.templateId === template.id && run.status === "submitted"),
    );
    if (openTemplates.length > 0 && missing.length === 0) return { area, readiness: "READY" as const, reasons: [] };
    return {
      area,
      readiness: "UNKNOWN" as const,
      reasons: openTemplates.length === 0
        ? ["ยังไม่มีเช็กลิสต์เปิดร้านของพื้นที่นี้"]
        : missing.map((template) => `ยังไม่ส่ง: ${template.name}`),
    };
  });
}

function areaKey(area: string): string {
  return area.trim() || "ทั่วไป";
}

/** เวลาครบกำหนด (เวลาร้าน) ของกะ — ก่อน 05:00 นับเป็นหลังเที่ยงคืน ตรงกับ ops_checklist_due_alerts() */
export function isChecklistOverdue(dueTime: string | null, shiftDate: string, nowLocal: { date: string; time: string }): boolean {
  if (!dueTime) return false;
  const dueDate = dueTime < "05:00" ? addDays(shiftDate, 1) : shiftDate;
  return `${nowLocal.date}T${nowLocal.time}` >= `${dueDate}T${dueTime.slice(0, 5)}`;
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + days));
  return next.toISOString().slice(0, 10);
}

/** แสดงค่าที่วัดได้ เช่น "7.5 °C (ช่วง 0–5)" */
export function formatMeasuredValue(
  value: number | null,
  unit: string | null,
  min: number | null,
  max: number | null,
): string {
  if (value === null) return "-";
  const range = min !== null || max !== null ? ` (ช่วง ${min ?? "…"}–${max ?? "…"})` : "";
  return `${value}${unit ? ` ${unit}` : ""}${range}`;
}

const RPC_ERROR_MESSAGES: Record<string, string> = {
  ops_not_authenticated: "กรุณาเข้าสู่ระบบใหม่",
  ops_forbidden: "ไม่มีสิทธิ์ทำรายการนี้",
  ops_disabled: "ร้านนี้ยังไม่ได้เปิดระบบงานหน้าร้าน",
  ops_template_not_found: "ไม่พบเช็กลิสต์",
  ops_template_inactive: "เช็กลิสต์นี้ถูกปิดใช้งานแล้ว",
  ops_invalid_shift_date: "วันที่ของกะไม่ถูกต้อง",
  ops_item_not_found: "ไม่พบข้อในเช็กลิสต์",
  ops_run_not_found: "ไม่พบรอบเช็กลิสต์",
  ops_run_submitted: "เช็กลิสต์นี้ส่งแล้ว — ให้เจ้าของเปิดรอบใหม่ก่อนแก้",
  ops_run_not_submitted: "เช็กลิสต์นี้ยังไม่ได้ส่ง",
  ops_invalid_answer: "คำตอบไม่ถูกต้อง",
  ops_value_required: "กรุณากรอกค่าที่วัดได้",
  ops_note_required_na: "เลือก “ไม่เกี่ยว” ต้องใส่เหตุผล",
  ops_note_required_critical: "ข้อสำคัญไม่ผ่าน ต้องใส่หมายเหตุว่าเกิดอะไรขึ้นและทำอะไรไปแล้ว",
  ops_note_too_long: "หมายเหตุยาวเกิน 1,000 ตัวอักษร",
  ops_invalid_photo_path: "ไฟล์รูปไม่ถูกต้อง",
  ops_items_unanswered: "ยังตอบไม่ครบทุกข้อ",
  ops_photo_required: "ยังขาดรูปในข้อที่ต้องแนบรูป",
  ops_reason_required: "กรุณาระบุเหตุผล",
  ops_invalid_name: "กรุณาตั้งชื่อเช็กลิสต์ (ไม่เกิน 120 ตัวอักษร)",
  ops_invalid_area: "ชื่อพื้นที่ยาวเกิน 60 ตัวอักษร",
  ops_invalid_phase: "รอบไม่ถูกต้อง",
  ops_invalid_days: "เลือกวันที่ใช้อย่างน้อย 1 วัน",
  ops_invalid_items: "ต้องมีอย่างน้อย 1 ข้อ และไม่เกิน 60 ข้อ",
  ops_invalid_assignee: "ผู้รับผิดชอบต้องเป็นพนักงานของสาขานี้",
  ops_invalid_item_label: "ทุกข้อต้องมีชื่อ (ไม่เกิน 200 ตัวอักษร)",
  ops_invalid_item_type: "ชนิดข้อไม่ถูกต้อง",
  ops_invalid_photo_rule: "กฎการแนบรูปไม่ถูกต้อง",
  ops_invalid_range: "ค่าต่ำสุดต้องไม่มากกว่าค่าสูงสุด",
};

export function opsErrorMessage(raw: string | null | undefined): string {
  if (!raw) return "เกิดข้อผิดพลาด";
  const code = Object.keys(RPC_ERROR_MESSAGES).find((key) => raw.includes(key));
  return code ? RPC_ERROR_MESSAGES[code] : "บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง";
}

const PHASES: ChecklistPhase[] = ["open", "mid", "close", "other"];
const VALUE_TYPES: ChecklistValueType[] = ["check", "number"];
const PHOTO_RULES: ChecklistPhotoRule[] = ["never", "on_fail", "always"];

/** ตรวจ input ฝั่งแอปก่อนส่ง RPC (RPC ตรวจซ้ำเสมอ) — คืนข้อความไทย หรือ null */
export function validateTemplateInput(input: TemplateInput): string | null {
  if (!input.name.trim() || input.name.length > 120) return RPC_ERROR_MESSAGES.ops_invalid_name;
  if (input.area.length > 60) return RPC_ERROR_MESSAGES.ops_invalid_area;
  if (!PHASES.includes(input.phase)) return RPC_ERROR_MESSAGES.ops_invalid_phase;
  if (input.dueTime !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.dueTime)) return "เวลาครบกำหนดไม่ถูกต้อง";
  if (input.daysOfWeek.length === 0 || input.daysOfWeek.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
    return RPC_ERROR_MESSAGES.ops_invalid_days;
  }
  if (input.items.length === 0 || input.items.length > 60) return RPC_ERROR_MESSAGES.ops_invalid_items;
  for (const item of input.items) {
    const error = validateTemplateItem(item);
    if (error) return error;
  }
  return null;
}

function validateTemplateItem(item: TemplateItemInput): string | null {
  if (!item.label.trim() || item.label.length > 200) return RPC_ERROR_MESSAGES.ops_invalid_item_label;
  if (!VALUE_TYPES.includes(item.valueType)) return RPC_ERROR_MESSAGES.ops_invalid_item_type;
  if (!PHOTO_RULES.includes(item.photoRule)) return RPC_ERROR_MESSAGES.ops_invalid_photo_rule;
  if (item.unit && item.unit.length > 20) return "หน่วยยาวเกิน 20 ตัวอักษร";
  for (const value of [item.minValue, item.maxValue]) {
    if (value !== null && (!Number.isFinite(value) || Math.abs(value) >= 1e8)) return "ค่าช่วงไม่ถูกต้อง";
  }
  if (item.minValue !== null && item.maxValue !== null && item.minValue > item.maxValue) {
    return RPC_ERROR_MESSAGES.ops_invalid_range;
  }
  return null;
}
