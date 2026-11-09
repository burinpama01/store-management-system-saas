/**
 * ข้อมูลที่พนักงานกรอกเอง (ตาราง employee_self_info)
 *
 * กติกา:
 * - ช่องตัวตน/บัญชี (ชื่อจริง, ธนาคาร, เลขบัญชี, ชื่อบัญชี) — เจ้าของตั้งแล้ว = ล็อก พนักงานแก้ไม่ได้
 *   ค่าที่ใช้จริง = ค่าของเจ้าของ ถ้าไม่มีจึงใช้ค่าที่พนักงานกรอก
 * - ช่องส่วนตัว (ชื่อเล่น, เบอร์, วันเกิด, ที่อยู่, ผู้ติดต่อฉุกเฉิน) — ของพนักงาน แก้ได้เสมอ
 * DB มี trigger ล้างช่องที่ล็อกซ้ำอีกชั้น (20261109120000_employee_self_info.sql)
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

/** ชื่อช่องที่เปลี่ยน (สำหรับ log — ไม่เก็บค่าจริง) */
export function changedFields(before: EmployeeSelfInfo | null | undefined, patch: SelfInfoPatch): string[] {
  return (Object.keys(patch) as (keyof SelfInfoPatch)[]).filter((k) => (before?.[k] ?? null) !== (patch[k] ?? null));
}
