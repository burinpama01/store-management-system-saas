/**
 * ข้อมูลที่พนักงานกรอกเอง (ตาราง employee_self_info)
 *
 * กติกา:
 * - ช่องตัวตน/บัญชี (ชื่อจริง, ธนาคาร, เลขบัญชี, ชื่อบัญชี) — เจ้าของตั้งแล้ว = ล็อก พนักงานแก้ไม่ได้
 *   ค่าที่ใช้จริง = ค่าของเจ้าของ ถ้าไม่มีจึงใช้ค่าที่พนักงานกรอก
 * - ช่องส่วนตัว (ชื่อเล่น, เบอร์, วันเกิด, ที่อยู่, ผู้ติดต่อฉุกเฉิน) — ของพนักงาน แก้ได้เสมอ
 * - กรอกครั้งแรก (ช่องว่าง) บันทึกทันที · แก้/ลบช่องที่มีค่าแล้ว ต้องส่งคำขอให้ผู้จัดการอนุมัติ
 * DB บังคับซ้ำทั้งสองข้อด้วย trigger (20261109120000_employee_self_info.sql)
 */
import type { EmployeeProfile } from "./types";

export const OWNER_LOCKABLE_FIELDS = ["fullName", "bankName", "bankAccountNo", "bankAccountName"] as const;
export type OwnerLockableField = (typeof OWNER_LOCKABLE_FIELDS)[number];

export const SELF_FIELD_LABEL: Record<OwnerLockableField | PersonalField, string> = {
  fullName: "ชื่อ-สกุลจริง",
  bankName: "ธนาคาร",
  bankAccountNo: "เลขบัญชี",
  bankAccountName: "ชื่อบัญชี",
  nickname: "ชื่อเล่น",
  phone: "เบอร์โทร",
  birthDate: "วันเกิด",
  address: "ที่อยู่",
  emergencyContactName: "ผู้ติดต่อฉุกเฉิน",
  emergencyContactPhone: "เบอร์ผู้ติดต่อฉุกเฉิน",
};

export const PERSONAL_FIELDS = [
  "nickname",
  "phone",
  "birthDate",
  "address",
  "emergencyContactName",
  "emergencyContactPhone",
] as const;
export type PersonalField = (typeof PERSONAL_FIELDS)[number];

export interface EmployeeSelfInfo {
  storeId: string;
  userId: string;
  fullName?: string;
  bankName?: string;
  bankAccountNo?: string;
  bankAccountName?: string;
  nickname?: string;
  phone?: string;
  birthDate?: string;
  address?: string;
  emergencyContactName?: string;
  emergencyContactPhone?: string;
  updatedAt?: string;
}

/** ค่าที่ส่งไปบันทึก: undefined = ไม่แตะช่องนั้น, null = ล้าง */
export type SelfInfoPatch = Partial<Record<OwnerLockableField | PersonalField, string | null>>;

type OwnerIdentity = Pick<EmployeeProfile, OwnerLockableField> | null | undefined;

const filled = (v: string | null | undefined) => typeof v === "string" && v.trim() !== "";

/** ช่องที่เจ้าของตั้งไว้แล้ว (พนักงานแก้ไม่ได้) */
export function lockedFields(owner: OwnerIdentity): Set<OwnerLockableField> {
  return new Set(OWNER_LOCKABLE_FIELDS.filter((f) => filled(owner?.[f])));
}

/** รวมค่าจริงสำหรับสลิป/รายงาน: เจ้าของก่อน แล้วจึงค่าที่พนักงานกรอก */
export function applySelfInfo<T extends Pick<EmployeeProfile, OwnerLockableField>>(profile: T, self: EmployeeSelfInfo | null | undefined): T {
  if (!self) return profile;
  const out = { ...profile };
  for (const f of OWNER_LOCKABLE_FIELDS) {
    if (!filled(out[f]) && filled(self[f])) out[f] = self[f];
  }
  return out;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PHONE_RE = /^\+?[0-9]{9,15}$/;

function isValidDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

const MAX: Record<OwnerLockableField | PersonalField, number> = {
  fullName: 150,
  bankName: 80,
  bankAccountNo: 30,
  bankAccountName: 150,
  nickname: 50,
  phone: 20,
  birthDate: 10,
  address: 400,
  emergencyContactName: 150,
  emergencyContactPhone: 20,
};

/**
 * ตรวจฟอร์มของพนักงาน
 * - ช่องที่ล็อก: ไม่อ่านค่าเลย (ไม่ส่งไป DB)
 * - เลขบัญชี: ไม่กรอก = ไม่เปลี่ยน (ฟอร์มไม่ส่งเลขเต็มกลับไป browser) · ติ๊ก clearBankAccount = ล้าง
 * - ช่องอื่น: ว่าง = ล้าง
 */
export function parseSelfInfoForm(
  get: (key: string) => unknown,
  opts: { locked: Set<OwnerLockableField>; today: string },
): { value: SelfInfoPatch; error: null } | { value: null; error: string } {
  const patch: SelfInfoPatch = {};
  const read = (key: OwnerLockableField | PersonalField) => {
    // ตัดอักขระควบคุม/ตัวอักษรล่องหน (zero-width) ที่ทำให้ชื่อบนสลิปเพี้ยน
    const v = String(get(key) ?? "")
      .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2060\ufeff]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    return v ? v.slice(0, MAX[key]) : null;
  };

  for (const f of ["fullName", "bankName", "bankAccountName"] as const) {
    if (!opts.locked.has(f)) patch[f] = read(f);
  }
  if (!opts.locked.has("bankAccountNo")) {
    const raw = String(get("bankAccountNo") ?? "").trim();
    if (raw) {
      const digits = raw.replace(/[\s-]/g, "");
      if (!/^\d{6,20}$/.test(digits)) return { value: null, error: "เลขบัญชีต้องเป็นตัวเลข 6–20 หลัก" };
      patch.bankAccountNo = digits;
    } else if (get("clearBankAccount") === "on") {
      patch.bankAccountNo = null;
    }
  }

  patch.nickname = read("nickname");
  patch.address = read("address");
  patch.emergencyContactName = read("emergencyContactName");

  for (const f of ["phone", "emergencyContactPhone"] as const) {
    const raw = read(f);
    if (!raw) {
      patch[f] = null;
      continue;
    }
    const digits = raw.replace(/[\s-]/g, "");
    if (!PHONE_RE.test(digits)) return { value: null, error: `${SELF_FIELD_LABEL[f]}ต้องเป็นตัวเลข 9–15 หลัก` };
    patch[f] = digits;
  }

  const birth = read("birthDate");
  if (birth) {
    if (!isValidDate(birth)) return { value: null, error: "วันเกิดไม่ถูกต้อง" };
    if (birth > opts.today) return { value: null, error: "วันเกิดต้องไม่เกินวันนี้" };
    if (birth < "1900-01-01") return { value: null, error: "วันเกิดไม่ถูกต้อง" };
  }
  patch.birthDate = birth;

  return { value: patch, error: null };
}

export type SelfInfoField = OwnerLockableField | PersonalField;

/** ชื่อคอลัมน์ในตาราง employee_self_info */
export const SELF_INFO_COLUMN: Record<SelfInfoField, string> = {
  fullName: "full_name",
  bankName: "bank_name",
  bankAccountNo: "bank_account_no",
  bankAccountName: "bank_account_name",
  nickname: "nickname",
  phone: "phone",
  birthDate: "birth_date",
  address: "address",
  emergencyContactName: "emergency_contact_name",
  emergencyContactPhone: "emergency_contact_phone",
};

const FIELD_BY_COLUMN = new Map(Object.entries(SELF_INFO_COLUMN).map(([field, column]) => [column, field as SelfInfoField]));

/**
 * แยกค่าที่ส่งมาเป็น 2 กอง
 * - direct: ช่องที่ยังว่าง → บันทึกทันที (การกรอกครั้งแรก)
 * - needsApproval: ช่องที่มีค่าแล้วและค่าเปลี่ยน (รวมการลบ) → ส่งคำขอ
 * ช่องที่ค่าไม่เปลี่ยน หรือว่างแล้วยังว่าง จะไม่อยู่ในกองไหน
 */
export function splitSelfInfoPatch(before: EmployeeSelfInfo | null | undefined, patch: SelfInfoPatch) {
  const direct: SelfInfoPatch = {};
  const needsApproval: SelfInfoPatch = {};
  for (const key of Object.keys(patch) as SelfInfoField[]) {
    const next = patch[key];
    if (next === undefined) continue;
    const current = before?.[key] ?? null;
    if ((current ?? "") === (next ?? "")) continue;
    if (filled(current)) needsApproval[key] = next;
    else direct[key] = next;
  }
  return { direct, needsApproval };
}

export interface SelfInfoChange {
  field: SelfInfoField;
  label: string;
  /** ค่าที่แสดงบนหน้าจอ — เลขบัญชีปิดหลักเสมอ, null = ขอลบ */
  value: string | null;
}

/** แปลง changes (คีย์เป็นชื่อคอลัมน์) เป็นรายการแสดงผล · เลขบัญชีเต็มห้ามไปถึง browser */
export function describeSelfInfoChanges(changes: unknown): SelfInfoChange[] {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return [];
  const out: SelfInfoChange[] = [];
  for (const [column, raw] of Object.entries(changes as Record<string, unknown>)) {
    const field = FIELD_BY_COLUMN.get(column);
    if (!field) continue;
    const value = typeof raw === "string" && raw !== "" ? raw : null;
    out.push({
      field,
      label: SELF_FIELD_LABEL[field],
      value: field === "bankAccountNo" && value ? `••${value.replace(/\D/g, "").slice(-4)}` : value,
    });
  }
  return out;
}
