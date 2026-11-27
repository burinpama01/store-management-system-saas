export type ChecklistPhase = "open" | "mid" | "close" | "other";
export type ChecklistValueType = "check" | "number";
export type ChecklistPhotoRule = "never" | "on_fail" | "always";
export type ChecklistAnswer = "pass" | "fail" | "na";
export type ChecklistRunStatus = "in_progress" | "submitted";
export type Readiness = "READY" | "LIMITED" | "NOT_READY" | "UNKNOWN";

export const CHECKLIST_PHASE_LABELS: Record<ChecklistPhase, string> = {
  open: "เปิดร้าน",
  mid: "ระหว่างวัน",
  close: "ปิดร้าน",
  other: "อื่น ๆ",
};

export const CHECKLIST_ANSWER_LABELS: Record<ChecklistAnswer, string> = {
  pass: "ผ่าน",
  fail: "ไม่ผ่าน",
  na: "ไม่เกี่ยว",
};

export const READINESS_LABELS: Record<Readiness, string> = {
  READY: "พร้อม",
  LIMITED: "พร้อมบางส่วน",
  NOT_READY: "ไม่พร้อม",
  UNKNOWN: "ยังไม่ตรวจ",
};

/** 0 = อาทิตย์ ตาม Date#getUTCDay และ extract(dow) ของ Postgres */
export const DAY_LABELS = ["อา", "จ", "อ", "พ", "พฤ", "ศ", "ส"] as const;

export interface ChecklistTemplateItem {
  id: string;
  sortOrder: number;
  label: string;
  description: string | null;
  critical: boolean;
  valueType: ChecklistValueType;
  unit: string | null;
  minValue: number | null;
  maxValue: number | null;
  photoRule: ChecklistPhotoRule;
}

export interface ChecklistTemplate {
  id: string;
  storeId: string;
  name: string;
  area: string;
  phase: ChecklistPhase;
  /** "HH:MM" เวลาร้าน หรือ null = ไม่มีกำหนด */
  dueTime: string | null;
  daysOfWeek: number[];
  requireBeforeClockOut: boolean;
  assigneeUserIds: string[];
  version: number;
  isActive: boolean;
  sortOrder: number;
  updatedAt: string;
  items: ChecklistTemplateItem[];
}

export interface ChecklistRunItem {
  id: string;
  sortOrder: number;
  label: string;
  description: string | null;
  critical: boolean;
  valueType: ChecklistValueType;
  unit: string | null;
  minValue: number | null;
  maxValue: number | null;
  photoRule: ChecklistPhotoRule;
  answer: ChecklistAnswer | null;
  value: number | null;
  note: string | null;
  photoPath: string | null;
  answeredBy: string | null;
  answeredAt: string | null;
}

export interface ChecklistRun {
  id: string;
  storeId: string;
  organizationId: string;
  templateId: string;
  templateVersion: number;
  templateName: string;
  area: string;
  phase: ChecklistPhase;
  shiftDate: string;
  status: ChecklistRunStatus;
  startedBy: string;
  startedAt: string;
  submittedBy: string | null;
  submittedAt: string | null;
  items: ChecklistRunItem[];
}

export type ChecklistEventAction =
  | "template_created"
  | "template_updated"
  | "run_started"
  | "item_answered"
  | "item_changed"
  | "photo_attached"
  | "run_submitted"
  | "run_reopened";

export interface ChecklistEvent {
  id: string;
  templateId: string | null;
  runId: string | null;
  runItemId: string | null;
  actorUserId: string;
  action: ChecklistEventAction;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface TemplateItemInput {
  label: string;
  description: string | null;
  critical: boolean;
  valueType: ChecklistValueType;
  unit: string | null;
  minValue: number | null;
  maxValue: number | null;
  photoRule: ChecklistPhotoRule;
}

export interface TemplateInput {
  name: string;
  area: string;
  phase: ChecklistPhase;
  dueTime: string | null;
  daysOfWeek: number[];
  requireBeforeClockOut: boolean;
  assigneeUserIds: string[];
  isActive: boolean;
  sortOrder: number;
  items: TemplateItemInput[];
}
