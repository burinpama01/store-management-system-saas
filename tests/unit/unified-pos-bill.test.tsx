// @vitest-environment jsdom
// U11 — แท็บบิลของ unified shell: บิลจาก server props / replay ไม่ auto-print /
// พิมพ์ซ้ำเป็น explicit action / retry ใช้ idempotency key เดิม
// (ทำงานบน jsdom ตาม pattern U0.5 — ห้าม static-import @testing-library/* บน node env)
//
// หลักการ mock: ความจริงทั้งหมดมาผ่าน server actions (fetchUnifiedPosTableBillAction /
// settleUnifiedPosBillAction / reprintUnifiedPosReceiptAction) — mock จุดเดียวนี้
// ส่วนกลไก source key/idempotent enqueue อยู่ฝั่ง server ทดสอบใน integration test
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../setup/react";
import { BillsPanel } from "@/app/pos/unified/BillsPanel";
import type { UnifiedPosTableBillView } from "@/app/pos/unified/bill-types";
import type { UnifiedTableSummary } from "@/app/pos/unified/types";

const actionMocks = vi.hoisted(() => ({
  fetchUnifiedPosTableBillAction: vi.fn(),
  settleUnifiedPosBillAction: vi.fn(),
  reprintUnifiedPosReceiptAction: vi.fn(),
  fetchKitchenQueueAction: vi.fn(),
  advanceKitchenItemAction: vi.fn(),
}));
vi.mock("@/app/pos/unified/actions", () => actionMocks);

const TABLE_1: UnifiedTableSummary = {
  id: "eeeeeeee-0000-0000-0000-000000000001",
  number: "1",
  status: "occupied",
};
const ORDER_1 = "dddddddd-0000-0000-0000-000000000001";

function makeBill(overrides: Partial<UnifiedPosTableBillView> = {}): UnifiedPosTableBillView {
  return {
    tableId: TABLE_1.id,
    tableNumber: "1",
    orders: [
      {
        orderId: ORDER_1,
        orderNumber: "A-1001",
        source: "qr",
        status: "open",
        revision: 3,
        itemsSubtotal: 135,
        discount: 0,
        total: 135,
        items: [
          {
            itemId: "ffffffff-0000-0000-0000-000000000001",
            productName: "กาแฟดำ",
            variantName: "เล็ก (S)",
            modifierNames: ["ไม่หวาน"],
            quantity: 1,
            unitPrice: 45,
            totalPrice: 45,
          },
          {
            itemId: "ffffffff-0000-0000-0000-000000000002",
            productName: "ลาเต้",
            modifierNames: [],
            quantity: 2,
            unitPrice: 45,
            totalPrice: 90,
          },
        ],
        payments: [],
      },
    ],
    grandTotal: 135,
    fetchedAt: "2026-09-02T00:00:00.000Z",
    ...overrides,
  };
}

const OK_SETTLE = {
  ok: true as const,
  replayed: false,
  result: {
    mode: "whole_table" as const,
    table_id: TABLE_1.id,
    table_closed: true,
    order_ids: [ORDER_1],
    grand_total: 135,
    payments: [{ order_id: ORDER_1, payment_id: "pp-1", amount: 135, received_amount: 135, change_amount: 0 }],
    orders: [{ order_id: ORDER_1, status: "paid", prep_status: "done", revision: 4, points_earned: 0 }],
  },
  receipt: {
    reference: "unified_pos_settlement:op-key-1",
    receiptJobId: "job-receipt-1",
    stationJobIds: [],
    receiptNotice: null,
    stationNotice: null,
  },
};

function renderPanel(props: { selectedTable?: UnifiedTableSummary | null } = {}) {
  // undefined = ใช้โต๊ะ default; null = จงใจส่ง null (ยังไม่เลือกโต๊ะ)
  const selectedTable = props.selectedTable === undefined ? TABLE_1 : props.selectedTable;
  render(<BillsPanel selectedTable={selectedTable} />);
}

beforeEach(() => {
  actionMocks.fetchUnifiedPosTableBillAction.mockReset();
  actionMocks.settleUnifiedPosBillAction.mockReset();
  actionMocks.reprintUnifiedPosReceiptAction.mockReset();
  actionMocks.fetchUnifiedPosTableBillAction.mockResolvedValue({ bill: makeBill(), error: null });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("BillsPanel (U11 — บิลจาก server props)", () => {
  it("ยังไม่เลือกโต๊ะ → empty state และไม่เรียก fetch บิล", () => {
    renderPanel({ selectedTable: null });
    expect(screen.getByText(/เลือกโต๊ะจากแท็บโต๊ะเพื่อดูบิล/)).toBeVisible();
    expect(actionMocks.fetchUnifiedPosTableBillAction).not.toHaveBeenCalled();
  });

  it("บิลแสดงตาม server props: รายการ non-voided + ยอด orders.total + ยอดรวมทั้งโต๊ะ", async () => {
    renderPanel();
    const view = await screen.findByTestId("unified-bill-view");
    await within(view).findByText("ยอดรวมทั้งโต๊ะ: 135.00 บาท"); // รอบิลโหลดจาก server จริง
    expect(within(view).getByText("บิล A-1001")).toBeVisible();
    expect(within(view).getByText(/x1 กาแฟดำ \(เล็ก \(S\)\) · ไม่หวาน — 45\.00 บาท/)).toBeVisible();
    expect(within(view).getByText(/x2 ลาเต้ — 90\.00 บาท/)).toBeVisible();
    // ยอดต่อบิล/ยอดรวมมาจาก props (server truth) — client ไม่คำนวณเอง
    expect(within(view).getByText("ยอดชำระ: 135.00 บาท")).toBeVisible();
    expect(within(view).getByText("ยอดรวมทั้งโต๊ะ: 135.00 บาท")).toBeVisible();
    expect(within(view).getByText("QR")).toBeVisible(); // source badge
  });

  it("ชำระทั้งโต๊ะ: ส่ง mode/idempotency key ให้ action และแสดง receipt reference + job id", async () => {
    actionMocks.settleUnifiedPosBillAction.mockResolvedValue(OK_SETTLE);
    renderPanel();
    await screen.findByTestId("settle-whole-table"); // รอบิลโหลดจาก server (ปุ่มชำระเรนเดอร์เมื่อมีบิล)

    // default method = qr_promptpay → ต้องยืนยันก่อน (notice มีทั้ง live region + ตัวเห็น)
    fireEvent.click(screen.getByRole("button", { name: "ชำระทั้งโต๊ะ" }));
    await waitFor(() => {
      expect(screen.getAllByText(/กรุณายืนยันว่าได้รับเงิน QR แล้ว/).length).toBeGreaterThan(0);
    });
    expect(actionMocks.settleUnifiedPosBillAction).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "ชำระทั้งโต๊ะ" }));

    await waitFor(() => {
      expect(actionMocks.settleUnifiedPosBillAction).toHaveBeenCalledTimes(1);
    });
    const call = actionMocks.settleUnifiedPosBillAction.mock.calls[0]![0] as {
      tableId: string;
      mode: string;
      idempotencyKey: string;
    };
    expect(call.tableId).toBe(TABLE_1.id);
    expect(call.mode).toBe("whole_table");
    expect(call.idempotencyKey).toMatch(/.{8,}/);

    const result = await screen.findByTestId("settle-result");
    expect(result).toHaveAttribute("data-receipt-reference", "unified_pos_settlement:op-key-1");
    expect(result).toHaveAttribute("data-receipt-job-id", "job-receipt-1");
    expect(result).toHaveAttribute("data-replayed", "false");
    expect(within(result).getByText(/ชำระเงินสำเร็จ/)).toBeVisible();
    // บิลถูก refetch หลังชำระ (orders ชำระแล้วหลุดจากบิล)
    expect(actionMocks.fetchUnifiedPosTableBillAction).toHaveBeenCalledTimes(2);
  });

  it("ผล replay: แสดงผลเดิมโดยไม่มีการ auto-print ใดๆ (ไม่ fetch /api/print/enqueue, ไม่ window.print, ไม่ auto reprint)", async () => {
    actionMocks.settleUnifiedPosBillAction.mockResolvedValue({ ...OK_SETTLE, replayed: true });
    const fetchSpy = vi.spyOn(window, "fetch");
    const printSpy = vi.spyOn(window, "print").mockImplementation(() => {});
    renderPanel();
    await screen.findByTestId("settle-whole-table"); // รอบิลโหลดจาก server (ปุ่มชำระเรนเดอร์เมื่อมีบิล)

    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "ชำระทั้งโต๊ะ" }));

    const result = await screen.findByTestId("settle-result");
    expect(result).toHaveAttribute("data-replayed", "true");
    expect(within(result).getByText(/คำขอนี้ถูกส่งซ้ำ \(replay\)/)).toBeVisible();

    // สัญญา U11: client ห้าม browser-auto-print ผล replay
    const enqueueCalls = fetchSpy.mock.calls.filter(([url]) => String(url).includes("/api/print/enqueue"));
    expect(enqueueCalls).toHaveLength(0);
    expect(printSpy).not.toHaveBeenCalled();
    expect(actionMocks.reprintUnifiedPosReceiptAction).not.toHaveBeenCalled();
  });

  it("พิมพ์ซ้ำเป็น explicit action: กดปุ่มเท่านั้น และส่ง reference ตรงกับผลชำระ", async () => {
    actionMocks.settleUnifiedPosBillAction.mockResolvedValue(OK_SETTLE);
    actionMocks.reprintUnifiedPosReceiptAction.mockResolvedValue({ ok: true, jobId: "job-reprint-1" });
    renderPanel();
    await screen.findByTestId("settle-whole-table"); // รอบิลโหลดจาก server (ปุ่มชำระเรนเดอร์เมื่อมีบิล)

    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "ชำระทั้งโต๊ะ" }));
    await screen.findByTestId("settle-result");
    expect(actionMocks.reprintUnifiedPosReceiptAction).not.toHaveBeenCalled(); // ไม่ auto

    fireEvent.click(screen.getByTestId("reprint-receipt"));
    await waitFor(() => {
      expect(actionMocks.reprintUnifiedPosReceiptAction).toHaveBeenCalledTimes(1);
    });
    expect(actionMocks.reprintUnifiedPosReceiptAction).toHaveBeenCalledWith("unified_pos_settlement:op-key-1");
    await waitFor(() => {
      expect(screen.getByTestId("reprint-done")).toHaveTextContent(/job-reprint-1/);
    });
    expect(screen.getByTestId("reprint-done")).toHaveTextContent(/บันทึกประวัติการตรวจสอบแล้ว/);
  });

  it("กดปุ่มซ้ำระหว่างรอ (retry ของคำขอเดิม) → ใช้ idempotency key เดิม ไม่สร้างคำขอใหม่", async () => {
    // holder เก็บ resolve ของ promise แรก (TS narrowing — ห้ามอ่านเป็น null ตอนเรียก)
    const captured: { resolve?: (value: unknown) => void } = {};
    actionMocks.settleUnifiedPosBillAction.mockImplementation(
      () =>
        new Promise((resolve) => {
          captured.resolve = resolve;
        }),
    );
    renderPanel();
    await screen.findByTestId("settle-whole-table"); // รอบิลโหลดจาก server (ปุ่มชำระเรนเดอร์เมื่อมีบิล)

    fireEvent.click(screen.getByRole("checkbox"));
    const button = screen.getByRole("button", { name: "ชำระทั้งโต๊ะ" });
    fireEvent.click(button);
    fireEvent.click(button); // double-submit → คำขอเดิม (key เดิม)
    await waitFor(() => {
      expect(actionMocks.settleUnifiedPosBillAction).toHaveBeenCalledTimes(2);
    });
    const first = actionMocks.settleUnifiedPosBillAction.mock.calls[0]![0] as { idempotencyKey: string };
    const second = actionMocks.settleUnifiedPosBillAction.mock.calls[1]![0] as { idempotencyKey: string };
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    captured.resolve?.({ ...OK_SETTLE, replayed: true });
  });

  it("กดปุ่มต่าง semantic ระหว่างรอ (ทั้งโต๊ะ หลัง partial ค้าง) → ได้คีย์ใหม่ ไม่ reuse คีย์คำขอเก่า", async () => {
    const captured: { resolve?: (value: unknown) => void } = {};
    actionMocks.settleUnifiedPosBillAction.mockImplementation(
      () =>
        new Promise((resolve) => {
          captured.resolve = resolve;
        }),
    );
    renderPanel();
    await screen.findByTestId("settle-whole-table");
    fireEvent.click(screen.getByRole("checkbox"));

    fireEvent.click(screen.getAllByTestId("settle-order")[0]!); // partial บิลแรก (ค้างรอ)
    await waitFor(() => {
      expect(actionMocks.settleUnifiedPosBillAction).toHaveBeenCalledTimes(1);
    });
    fireEvent.click(screen.getByTestId("settle-whole-table")); // คำขอคนละโหมด → คีย์ใหม่
    await waitFor(() => {
      expect(actionMocks.settleUnifiedPosBillAction).toHaveBeenCalledTimes(2);
    });
    const first = actionMocks.settleUnifiedPosBillAction.mock.calls[0]![0] as { idempotencyKey: string; mode: string };
    const second = actionMocks.settleUnifiedPosBillAction.mock.calls[1]![0] as { idempotencyKey: string; mode: string };
    expect(first.mode).toBe("partial");
    expect(second.mode).toBe("whole_table");
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
    captured.resolve?.({ ...OK_SETTLE, replayed: false });
  });

  it("error แบบ stale → แจ้งผู้ใช้ + refetch บิลจาก server", async () => {
    actionMocks.settleUnifiedPosBillAction.mockResolvedValue({
      ok: false,
      code: "up_stale_version",
      error: "ข้อมูลบิลเปลี่ยนไปแล้ว กรุณารีเฟรชหน้าจอ",
      stale: true,
    });
    renderPanel();
    await screen.findByTestId("settle-whole-table"); // รอบิลโหลดจาก server (ปุ่มชำระเรนเดอร์เมื่อมีบิล)

    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "ชำระทั้งโต๊ะ" }));
    await waitFor(() => {
      expect(screen.getAllByText(/ข้อมูลบิลเปลี่ยนไปแล้ว.*โหลดบิลล่าสุดจากระบบแล้ว/).length).toBeGreaterThan(0);
    });
    expect(actionMocks.fetchUnifiedPosTableBillAction).toHaveBeenCalledTimes(2);
  });
});
