/**
 * ใครส่งบิลซื้อ/อนุมัติได้ (pure — เทสต์ได้) · Plan v5
 * - ส่งบิล (รวมบิลเงินสดเขียนมือ): สมาชิกสาขาทุกระดับ เมื่อแพ็กเกจมี stockManagement และสาขาเปิดคลังแล้ว
 * - รออนุมัติเมื่อ: ไม่ใช่เจ้าของ และ (บิลเขียนมือ หรือผู้ส่งต่ำกว่าผู้จัดการ) — ตรงกับ purchase_bill_post ใน DB
 * - อนุมัติ: ผู้จัดการขึ้นไป ห้ามอนุมัติบิลที่ตัวเองส่ง ยกเว้นเจ้าของร้าน
 */
import type { EvidenceKind } from "./types";

export const PURCHASE_MANAGER_ROLES = ["super_admin", "owner", "admin", "manager"] as const;
export const PURCHASE_OWNER_ROLES = ["super_admin", "owner"] as const;

export const isPurchaseManager = (role: string) => (PURCHASE_MANAGER_ROLES as readonly string[]).includes(role);
export const isPurchaseOwner = (role: string) => (PURCHASE_OWNER_ROLES as readonly string[]).includes(role);

export type PurchaseSubmitDecision = { allowed: true; isManager: boolean; isOwner: boolean } | { allowed: false; message: string };

export function decidePurchaseSubmit(input: {
  hasStockManagement: boolean;
  inventoryEnabled: boolean;
  role: string;
}): PurchaseSubmitDecision {
  if (!input.hasStockManagement) return { allowed: false, message: "การส่งบิลซื้ออยู่ในแพ็กเกจที่มีระบบสต็อก" };
  if (!input.inventoryEnabled) return { allowed: false, message: "สาขานี้ยังไม่ได้เปิดคลังวัตถุดิบ" };
  return { allowed: true, isManager: isPurchaseManager(input.role), isOwner: isPurchaseOwner(input.role) };
}

/** บิลนี้จะรออนุมัติไหม (แสดงในฟอร์มก่อนกดส่ง) */
export function needsApproval(role: string, kind: EvidenceKind): boolean {
  if (isPurchaseOwner(role)) return false;
  return kind === "handwritten" || !isPurchaseManager(role);
}

/** ผู้ใช้คนนี้อนุมัติบิลนี้ได้ไหม (ซ่อนปุ่ม — DB ตรวจซ้ำ) */
export function canApproveBill(input: { role: string; userId: string; postedBy: string | null }): boolean {
  if (!isPurchaseManager(input.role)) return false;
  return input.postedBy !== input.userId || isPurchaseOwner(input.role);
}
