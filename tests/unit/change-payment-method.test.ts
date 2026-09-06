// แก้ช่องทางชำระของบิลที่จ่ายแล้ว (พนักงานลงผิด เช่น ลูกค้าโอนแต่กดเงินสด)
// กติกาทั้งหมดต้องอยู่ในฐานข้อมูล ไม่ใช่แค่ UI — เพราะมันแตะเงินสดของร้านย้อนหลัง
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildReceiptLines } from "@/modules/printing/receipt-lines";
import { buildEscPosReceipt } from "@/modules/printing/escpos";
import type { ReceiptData } from "@/modules/printing/types";

const read = (relative: string) => readFileSync(join(process.cwd(), relative), "utf8");
const migration = read("supabase/migrations/20260906000001_change_order_payment_method.sql");

describe("กติกาที่บังคับในฐานข้อมูล", () => {
  it("แก้ได้เฉพาะบิลที่จ่ายแล้ว และต้องมีสิทธิ์เท่ากับการยกเลิกบิล", () => {
    expect(migration).toContain("and status = 'paid'");
    expect(migration).toContain("'pos.delete_bill'");
  });

  it("แก้ได้เฉพาะบิลในรอบเงินสดที่เปิดอยู่", () => {
    expect(migration).toContain("where organization_id = v_order.organization_id");
    expect(migration).toContain("and status = 'open'");
    expect(migration).toContain("if v_payment.processed_at < v_session.opened_at then");
  });

  it("บิลแยกจ่ายหลายช่องทางไม่รองรับ (ต้องยกเลิกแล้วออกใหม่)", () => {
    expect(migration).toContain("if v_payment_count > 1 then");
  });

  it("ปรับเงินสดในลิ้นชักด้วยแถว adjustment ตามส่วนต่าง ไม่แก้แถวขายเดิม", () => {
    expect(migration).toContain("v_delta := v_new_cash - v_old_cash;");
    expect(migration).toContain("'adjustment'");
    expect(migration).toContain("if v_delta <> 0 then");
    // ยอดขายไม่เปลี่ยน จึงต้องไม่มีการแก้ transactions
    expect(migration).not.toContain("update public.transactions");
  });

  it("เปลี่ยนเป็นเงินสดต้องมีสิทธิ์รับเงินสด และยอดต้องตรง", () => {
    expect(migration).toContain("'cashflow.record'");
    expect(migration).toContain("if v_new_cash is distinct from v_payment.amount then");
  });

  it("RPC ไม่เปิดให้ anon เรียก", () => {
    expect(migration).toContain("revoke all on function public.change_pos_order_payment_method");
    expect(migration).toContain("from anon");
  });
});

describe("ฝั่งแอป", () => {
  it("action ตรวจสิทธิ์ซ้ำและบันทึก log ทั้งตอนสำเร็จและตอนล้มเหลว", () => {
    const actions = read("src/app/pos/actions.ts");
    expect(actions).toContain('await requirePermission("pos.delete_bill");');
    expect(actions).toContain('action: "changeOrderPaymentMethod",');
    expect(actions).toContain('level: "warn",');
  });

  it("POS มีปุ่มแก้ช่องทางชำระเฉพาะบิลที่จ่ายแล้ว", () => {
    const pos = read("src/app/pos/PosTerminal.tsx");
    expect(pos).toContain('{order.status === "paid" && (');
    expect(pos).toContain("แก้ช่องทางชำระ");
    expect(pos).toContain("changeOrderPaymentMethodAction");
  });

  it("ซ่อน dialog ประวัติบิลชั่วคราวขณะเปิด dialog แก้ช่องทางชำระ", () => {
    const pos = read("src/app/pos/PosTerminal.tsx");
    expect(pos).toContain("open={billHistoryPanelOpen && changePaymentOrder === null}");
  });

  it("เมื่อแก้ไม่สำเร็จ dialog ต้องค้างอยู่และแสดงสาเหตุแบบ alert", () => {
    const pos = read("src/app/pos/PosTerminal.tsx");
    expect(pos).toContain("changePaymentError");
    expect(pos).toContain("setChangePaymentError(result.error);");
    expect(pos).toContain('role="alert"');
    expect(pos).toContain("แก้ช่องทางชำระไม่สำเร็จ");
  });
});

function receipt(payments: ReceiptData["payments"]): ReceiptData {
  return {
    storeName: "ร้านทดสอบ",
    showTaxId: false,
    orderNumber: "A-001",
    items: [{ name: "ลาเต้", modifierNames: [], quantity: 1, unitPrice: 60, totalPrice: 60 }],
    subtotal: 60,
    discount: 0,
    total: 60,
    payments,
    paymentStatus: "paid",
    showQrPayment: false,
    paperWidth: "80mm",
    printedAt: "2026-09-06T10:00:00.000Z",
  } as ReceiptData;
}

// ใบที่แก้ช่องทางแล้วต้องอ่านออกว่า "เดิมลงเป็นอะไร" ไม่งั้นตอนตรวจเงินจะแยกไม่ออก
// ว่าใบนี้เคยลงเงินสดผิดไว้ หรือเป็นบิลโอนตั้งแต่แรก
describe("ใบเสร็จบอกว่าช่องทางถูกแก้", () => {
  it("บิลปกติไม่มีบรรทัดนี้", () => {
    const { lines } = buildReceiptLines(receipt([{ method: "cash", amount: 60 }]));
    expect(lines.some((line) => line.text.includes("แก้ช่องทางชำระ"))).toBe(false);
  });

  it("บิลที่แก้แล้วบอกทั้งช่องทางเดิมและใหม่", () => {
    const { lines } = buildReceiptLines(
      receipt([{ method: "bank_transfer", amount: 60, originalMethod: "cash" }]),
    );
    const text = lines.map((line) => line.text).join(" ");
    expect(text).toContain("แก้ช่องทางชำระจาก เงินสด เป็น โอนเงิน");
  });

  it("แก้กลับมาเป็นช่องทางเดิมแล้วไม่ต้องขึ้นบรรทัดนี้", () => {
    const { lines } = buildReceiptLines(
      receipt([{ method: "cash", amount: 60, originalMethod: "cash" }]),
    );
    expect(lines.some((line) => line.text.includes("แก้ช่องทางชำระ"))).toBe(false);
  });

  it("โหมดข้อความ (ESC/POS) บอกเป็น ASCII ให้เครื่องที่ไม่มี code page ไทยอ่านออก", () => {
    const bytes = buildEscPosReceipt({
      storeName: "Test",
      orderNumber: "A-001",
      items: [{ name: "Latte", modifierNames: [], quantity: 1, totalPrice: 60 }],
      subtotal: 60,
      discount: 0,
      total: 60,
      payments: [{ method: "bank_transfer", amount: 60, originalMethod: "cash" }],
      paperWidth: "80mm",
      printedAt: "2026-09-06T10:00:00.000Z",
    });
    expect(Buffer.from(bytes).toString("latin1")).toContain("Payment changed: Cash -> Transfer");
  });
});

describe("แก้เสร็จต้องพิมพ์ใบใหม่ให้เลย", () => {
  it("action คืนบิลที่อัปเดตแล้ว และ POS สั่งพิมพ์ซ้ำต่อทันที", () => {
    expect(read("src/app/pos/actions.ts")).toContain("const updated = await getOrder(input.orderId);");
    expect(read("src/app/pos/PosTerminal.tsx")).toContain("await handlePrintHistoryOrder(result.order);");
  });
});
