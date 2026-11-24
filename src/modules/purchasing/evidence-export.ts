/** ส่งออกหลักฐานบิลซื้อ (pure — เทสต์ได้): ชื่อไฟล์รูปใน ZIP + ดัชนี CSV · Plan v5 */
import { BILL_STATUS_LABELS, EVIDENCE_LABELS, type EvidenceImageRow, type PurchaseBill } from "./types";

/** ตัดอักขระที่ใช้เป็นชื่อไฟล์ไม่ได้ (Windows/macOS/zip) และจำกัดความยาว */
export function safeFilePart(value: string, max = 40): string {
  const cleaned = value
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  return (cleaned || "-").slice(0, max).trim() || "-";
}

/** <วันที่>_<ผู้ขาย>_<เลขบิลหรือรหัสบิล>_<ลำดับ>.jpg — เรียงตามวันที่ได้ในโฟลเดอร์ */
export function evidenceFileName(bill: Pick<PurchaseBill, "id" | "billDate" | "billNo">, supplier: string, index: number): string {
  const ref = bill.billNo ? safeFilePart(bill.billNo, 30) : bill.id.slice(0, 8);
  return `${bill.billDate}_${safeFilePart(supplier)}_${ref}_${index + 1}.jpg`;
}

export function orphanFileName(img: Pick<EvidenceImageRow, "id" | "createdAt">): string {
  return `ไม่ผูกบิล/${img.createdAt.slice(0, 10)}_${img.id.slice(0, 8)}.jpg`;
}

function csvCell(value: string | number | null | undefined): string {
  const s = value === null || value === undefined ? "" : String(value);
  // กันสูตรใน Excel (= + - @) และ escape เครื่องหมายคำพูด
  const safe = /^[=+\-@]/.test(s) && typeof value !== "number" ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function buildEvidenceCsv(bills: PurchaseBill[], supplierOf: (b: PurchaseBill) => string): string {
  const header = [
    "วันที่ในบิล",
    "ผู้ขาย",
    "เลขที่บิล",
    "ชนิดหลักฐาน",
    "สถานะ",
    "ยอดก่อน VAT",
    "VAT",
    "ยอดสุทธิ",
    "การจ่าย",
    "ผู้ส่ง",
    "เหตุผลไม่อนุมัติ/ยกเลิก",
    "จำนวนรูป",
    "ไฟล์รูป",
  ];
  const rows = bills.map((b) => {
    const supplier = supplierOf(b);
    const files = b.images.map((_, i) => evidenceFileName(b, supplier, i)).join(" | ");
    const pay = b.paymentStatus === "paid" ? (b.paymentMethod === "cash" ? "เงินสด" : "โอน") : "ค้างจ่าย";
    return [
      b.billDate,
      supplier,
      b.billNo ?? "",
      EVIDENCE_LABELS[b.evidenceKind],
      BILL_STATUS_LABELS[b.status],
      (Math.round((b.subtotal - b.discount) * 100) / 100).toFixed(2),
      b.vatAmount.toFixed(2),
      b.total.toFixed(2),
      pay,
      b.postedByName ?? "",
      b.rejectReason ?? b.voidReason ?? "",
      b.images.length,
      files,
    ];
  });
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
}
