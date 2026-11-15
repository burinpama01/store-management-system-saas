import { createHash, randomInt } from "node:crypto";

/** อายุรหัสใช้สิทธิ์ที่ลูกค้าเปิดจากหน้าสมาชิก (ผู้ใช้กำหนด 5 นาที) */
export const MEMBER_REDEEM_CODE_TTL_SECONDS = 300;
/** ผลยืนยันที่ POS ใช้ได้นานเท่านี้ เพื่อให้แคชเชียร์ทำบิลจนจ่ายเสร็จ */
export const MEMBER_VERIFICATION_TTL_SECONDS = 1200;
export const MEMBER_REDEEM_CODE_LENGTH = 6;

/** QR ของรหัสใส่แค่ตัวเลข 6 หลัก — เครื่องสแกนแบบคีย์บอร์ดยิงลงช่องเดียวกับที่แคชเชียร์พิมพ์ได้ */
export function generateMemberRedeemCode(): string {
  return String(randomInt(0, 10 ** MEMBER_REDEEM_CODE_LENGTH)).padStart(MEMBER_REDEEM_CODE_LENGTH, "0");
}

/** hash ผูกกับองค์กร: รหัสเดียวกันต่างองค์กรไม่ชนกัน และไม่เก็บรหัสจริงในฐานข้อมูล */
export function hashMemberRedeemCode(organizationId: string, code: string): string {
  return createHash("sha256").update(`${organizationId}:${code}`).digest("hex");
}

/**
 * รับค่าที่แคชเชียร์พิมพ์/สแกน คืนรหัส 6 หลัก หรือ null ถ้าไม่ใช่รูปแบบรหัส
 * ยอมรับช่องว่าง/ขีดคั่น (เช่น "482 913") แต่ไม่ยอมรับเลขที่ยาว/สั้นกว่า 6 หลัก
 */
export function normalizeMemberRedeemCodeInput(value: string | null | undefined): string | null {
  const cleaned = (value ?? "").trim().replace(/[\s-]/g, "");
  return /^[0-9]{6}$/.test(cleaned) ? cleaned : null;
}

export type IssueRedeemCodeStatus =
  | "ok"
  | "disabled"
  | "store_not_found"
  | "customer_not_found"
  | "no_phone"
  | "rate_limited"
  | "collision";

export type VerifyRedeemCodeStatus =
  | "ok"
  | "disabled"
  | "store_not_found"
  | "invalid"
  | "locked"
  | "customer_inactive"
  | "customer_conflict";

export function issueStatusMessage(status: Exclude<IssueRedeemCodeStatus, "ok">): string {
  switch (status) {
    case "disabled":
      return "สาขานี้ยังไม่เปิดใช้รหัสสมาชิก";
    case "store_not_found":
      return "ไม่พบร้านนี้";
    case "customer_not_found":
      return "ไม่พบสมาชิกของร้านนี้";
    case "no_phone":
      return "บัญชีสมาชิกต้องมีเบอร์โทรศัพท์ก่อนจึงจะใช้สิทธิ์ได้";
    case "rate_limited":
      return "ขอรหัสบ่อยเกินไป กรุณารอสักครู่";
    case "collision":
      return "สร้างรหัสไม่สำเร็จ กรุณาลองใหม่";
  }
}

export function verifyStatusMessage(
  status: Exclude<VerifyRedeemCodeStatus, "ok">,
  attemptsLeft?: number | null,
): string {
  switch (status) {
    case "disabled":
      return "สาขานี้ยังไม่เปิดใช้รหัสสมาชิก (ตั้งค่า › สิทธิ์สมาชิก)";
    case "store_not_found":
      return "ไม่พบร้านนี้";
    case "invalid":
      return typeof attemptsLeft === "number"
        ? `รหัสไม่ถูกต้อง หมดอายุ หรือถูกใช้แล้ว — ให้ลูกค้ากดขอรหัสใหม่ (เหลือ ${attemptsLeft} ครั้ง)`
        : "รหัสไม่ถูกต้อง หมดอายุ หรือถูกใช้แล้ว — ให้ลูกค้ากดขอรหัสใหม่";
    case "locked":
      return "กรอกรหัสผิดหลายครั้ง ระบบล็อกไว้ 10 นาที";
    case "customer_inactive":
      return "สมาชิกคนนี้ถูกปิดใช้งานในสาขานี้ — เปิดใช้งานในหน้าลูกค้าก่อน";
    case "customer_conflict":
      return "ผูกสมาชิกกับสาขานี้ไม่สำเร็จ กรุณาค้นด้วยเบอร์แล้วลองใหม่";
  }
}
