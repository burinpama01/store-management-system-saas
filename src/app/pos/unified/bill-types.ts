// U11 — Types/view ของแท็บบิลใน unified shell (R2)
// ความจริงของบิลมาจาก server เสมอ (server truth — ห้าม client คำนวณ/เก็บ):
//   - รายการที่โชว์ = order_items ที่ voided=false เท่านั้น (canonical void ตาม U1)
//   - ยอดต่อบิล = orders.total (คอลัมน์เดียวกับที่ RPC settlement ใช้คิดเงิน — never client totals)
//   - การชำระที่มีอยู่ = แถว payments จริงของบิลนั้น

/** รายการสินค้าในบิล (ไม่มีรายการ voided — server กรองให้ก่อนส่งออกเสมอ) */
export interface UnifiedPosBillItemView {
  readonly itemId: string;
  readonly productName: string;
  readonly variantName?: string;
  readonly modifierNames: readonly string[];
  readonly quantity: number;
  readonly unitPrice: number;
  readonly totalPrice: number;
  readonly note?: string;
}

/** การชำระเงินที่บันทึกไว้ของบิล (สถานะ completed) */
export interface UnifiedPosBillPaymentView {
  readonly paymentId: string;
  readonly method: string;
  readonly amount: number;
  readonly processedAt?: string;
}

/** บิลรายออร์เดอร์ (view ย่อยของ partial settle) */
export interface UnifiedPosBillOrderView {
  readonly orderId: string;
  readonly orderNumber: string;
  readonly source: "qr" | "staff";
  readonly status: string;
  readonly revision: number;
  /** ผลรวมรายการที่ไม่ voided (แสดงเทียบกับ total เพื่อเห็นส่วนลดระดับบิล) */
  readonly itemsSubtotal: number;
  readonly discount: number;
  /** orders.total — ยอดที่ RPC settlement ใช้ตัดเงินจริง */
  readonly total: number;
  readonly items: readonly UnifiedPosBillItemView[];
  readonly payments: readonly UnifiedPosBillPaymentView[];
}

/** บิลทั้งโต๊ะ (view ของ whole_table settle) — grandTotal = ผลรวม orders.total ของโต๊ะ */
export interface UnifiedPosTableBillView {
  readonly tableId: string;
  readonly tableNumber: string | null;
  readonly orders: readonly UnifiedPosBillOrderView[];
  readonly grandTotal: number;
  readonly fetchedAt: string;
}
