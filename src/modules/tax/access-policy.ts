/**
 * ใครใช้หน้าใบกำกับภาษีได้ (pure — เทสต์ได้) · ต้องตรงกับ tax_documents_assert_ready ใน DB
 * - แพ็กเกจ: taxDocuments (Enterprise)
 * - ดู/ออก/พิมพ์ซ้ำ: แคชเชียร์ขึ้นไป · ใบลดหนี้/ยกเลิก: ผู้จัดการขึ้นไป
 * - ออกได้จริงเมื่อสาขาเปิดสวิตช์ และข้อมูลภาษีระบุว่าจด VAT แล้ว
 */
export const TAX_DOC_VIEW_ROLES = ["super_admin", "owner", "admin", "manager", "cashier"] as const;
export const TAX_DOC_VOID_ROLES = ["super_admin", "owner", "admin", "manager"] as const;

export type TaxDocumentsAccess =
  | { allowed: true; canIssue: boolean; canVoid: boolean; enabled: boolean; vatRegistered: boolean }
  | { allowed: false; message: string };

export function decideTaxDocumentsAccess(input: {
  hasFeature: boolean;
  role: string;
  enabled: boolean;
  vatRegistered: boolean;
}): TaxDocumentsAccess {
  if (!input.hasFeature) return { allowed: false, message: "ใบกำกับภาษีเต็มรูปมีในแพ็กเกจ Enterprise" };
  if (!(TAX_DOC_VIEW_ROLES as readonly string[]).includes(input.role)) {
    return { allowed: false, message: "หน้านี้สำหรับแคชเชียร์ขึ้นไป" };
  }
  const ready = input.enabled && input.vatRegistered;
  return {
    allowed: true,
    canIssue: ready,
    canVoid: ready && (TAX_DOC_VOID_ROLES as readonly string[]).includes(input.role),
    enabled: input.enabled,
    vatRegistered: input.vatRegistered,
  };
}
