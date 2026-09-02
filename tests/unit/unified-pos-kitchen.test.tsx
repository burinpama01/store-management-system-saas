// @vitest-environment jsdom
// U10 — คิวครัวของ unified shell: การ์ด / pending กันดับเบิ้ล / optimistic / conflict refetch
// (ทำงานบน jsdom ตาม pattern U0.5 — ห้าม static-import @testing-library/* บน node env)
//
// หลักการ mock: ทุกความจริงจาก server มาผ่าน server actions (advanceKitchenItemAction /
// fetchKitchenQueueAction) และ realtime มาผ่าน browser supabase client — mock สองจุดนี้
// เท่านั้น ส่วน tracker/parser/dedupe ใช้ของจริงจาก U3 (ถูกทดสอบแยกใน unified-pos-realtime)
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../setup/react";
import type { UnifiedKitchenItem } from "@/app/pos/unified/kitchen-types";
import { KitchenQueuePanel } from "@/app/pos/unified/KitchenQueuePanel";

// ── server actions mock ────────────────────────────────────────────────────────
const actionMocks = vi.hoisted(() => ({
  advanceKitchenItemAction: vi.fn(),
  fetchKitchenQueueAction: vi.fn(),
}));
vi.mock("@/app/pos/unified/actions", () => actionMocks);

// ── browser supabase client mock (เก็บ handler ของ postgres_changes ไว้ยิง event จำลอง) ──
const clientMock = vi.hoisted(() => {
  const state = { lastChangeHandler: null as ((payload: unknown) => void) | null };
  return {
    state,
    getClient: () => {
      const makeChannel = () => {
        const channel = {
          // (type, filter, handler) — เก็บเฉพาะ handler ของ postgres_changes ไว้ยิง event จำลอง
          on(...args: unknown[]) {
            state.lastChangeHandler = args[2] as (payload: unknown) => void;
            return channel;
          },
          subscribe(callback: (status: string) => void) {
            callback("SUBSCRIBED");
            return { unsubscribe: () => {} };
          },
        };
        return channel;
      };
      return {
        channel: () => makeChannel(),
        removeChannel: async () => ({}),
      };
    },
  };
});
vi.mock("@/server/integrations/supabase/client", () => ({
  getSupabaseBrowserClient: () => clientMock.getClient(),
}));

const STORE_ID = "cccccccc-0000-0000-0000-000000000001";
const ITEM_1 = "ffffffff-0000-0000-0000-000000000001";
const ITEM_2 = "ffffffff-0000-0000-0000-000000000002";
const ORDER_1 = "dddddddd-0000-0000-0000-000000000001";
const ORDER_2 = "dddddddd-0000-0000-0000-000000000002";

function makeItem(overrides: Partial<UnifiedKitchenItem> = {}): UnifiedKitchenItem {
  return {
    orderId: ORDER_1,
    orderNumber: "A-1001",
    itemId: ITEM_1,
    productName: "กาแฟดำ",
    variantName: "เล็ก (S)",
    quantity: 1,
    note: "ไม่หวาน",
    voided: false,
    fulfillmentStatus: "new",
    fulfillmentVersion: 1,
    source: "qr",
    tableNumber: "1",
    orderCreatedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    ...overrides,
  };
}

/** payload แบบ RealtimePostgresChangesPayload (ย่อเหลือเฉพาะ field ที่ parser อ่าน) */
function itemChangePayload(
  itemId: string,
  fulfillmentVersion: number,
  fulfillmentStatus: string,
  eventType: "INSERT" | "UPDATE" | "DELETE" = "UPDATE",
  voided = false,
) {
  return {
    eventType,
    schema: "public",
    table: "order_items",
    commit_timestamp: new Date().toISOString(),
    new:
      eventType === "DELETE"
        ? {}
        : {
            id: itemId,
            order_id: ORDER_1,
            fulfillment_version: fulfillmentVersion,
            fulfillment_status: fulfillmentStatus,
            voided,
          },
    old: { id: itemId, order_id: ORDER_1 },
  };
}

function cardOf(itemId: string): HTMLElement {
  const card = document.querySelector<HTMLElement>(`[data-kitchen-item="${itemId}"]`);
  expect(card, `ต้องพบการ์ดของ item ${itemId}`).not.toBeNull();
  return card as HTMLElement;
}

function renderPanel(items: UnifiedKitchenItem[]) {
  render(<KitchenQueuePanel storeId={STORE_ID} initialItems={items} />);
}

beforeEach(() => {
  actionMocks.fetchKitchenQueueAction.mockReset();
  actionMocks.advanceKitchenItemAction.mockReset();
  // ค่าเริ่มต้น: refetch คืนคิวว่าง / advance ไม่ควรถูกเรียกโดยไม่ตั้งค่า mock รายเคส
  actionMocks.fetchKitchenQueueAction.mockResolvedValue({ items: [], error: null });
  actionMocks.advanceKitchenItemAction.mockResolvedValue({
    ok: false,
    code: "up_unexpected",
    message: "no-op",
  });
});

afterEach(() => {
  cleanup();
});

describe("KitchenItemCard (ผ่าน KitchenQueuePanel)", () => {
  it("การ์ดแสดง source/table/เวลาออร์เดอร์/สถานะ effective/version ครบ", () => {
    renderPanel([
      makeItem(),
      makeItem({
        itemId: ITEM_2,
        orderId: ORDER_2,
        orderNumber: "A-1002",
        source: "staff",
        fulfillmentStatus: "preparing",
        fulfillmentVersion: 2,
        tableNumber: "2",
        note: undefined,
      }),
    ]);

    const qrCard = within(cardOf(ITEM_1));
    expect(qrCard.getByText("กาแฟดำ (เล็ก (S))")).toBeVisible();
    expect(qrCard.getByText("QR")).toBeVisible(); // source = QR
    expect(qrCard.getByText("โต๊ะ 1")).toBeVisible();
    expect(qrCard.getByText(/นาทีที่แล้ว/)).toBeVisible(); // เวลาออร์เดอร์
    expect(qrCard.getByText("ใหม่")).toBeVisible(); // effective state
    expect(qrCard.getByText("v1")).toBeVisible(); // fulfillment_version
    expect(qrCard.getByText("“ไม่หวาน”")).toBeVisible(); // note

    const staffCard = within(cardOf(ITEM_2));
    expect(staffCard.getByText("พนักงาน")).toBeVisible();
    expect(staffCard.getByText("โต๊ะ 2")).toBeVisible();
    expect(staffCard.getByText("กำลังเตรียม")).toBeVisible();
    expect(staffCard.getByText("v2")).toBeVisible();
  });

  it("voided render แยกชัด (ยกเลิกแล้ว + ตัดขีด + ไม่มีปุ่ม action)", () => {
    renderPanel([
      makeItem({ voided: true, voidedReason: "ของหมด", fulfillmentStatus: "preparing" }),
    ]);
    const card = within(cardOf(ITEM_1));
    expect(card.getByText("ยกเลิกแล้ว")).toBeVisible();
    expect(card.getByText(/ของหมด/)).toBeVisible();
    expect(card.queryByRole("button")).toBeNull(); // ไม่มีปุ่ม — canonical void ปลายทาง
    const nameEl = card.getByText(/กาแฟดำ/);
    expect(nameEl.className).toContain("line-through");
    expect(card.queryByText("พร้อมเสิร์ฟ")).toBeNull();
  });

  it("ปุ่ม action ตามขั้นถัดไปเท่านั้น (new→รับรายการ, preparing→พร้อมเสิร์ฟ, served→ไม่มีปุ่ม)", () => {
    renderPanel([
      makeItem({ fulfillmentStatus: "new" }),
      makeItem({ itemId: ITEM_2, fulfillmentStatus: "preparing", fulfillmentVersion: 2 }),
      makeItem({ itemId: "ffffffff-0000-0000-0000-000000000003", fulfillmentStatus: "served", fulfillmentVersion: 3 }),
    ]);
    expect(within(cardOf(ITEM_1)).getByRole("button", { name: "รับรายการ" })).toBeVisible();
    expect(within(cardOf(ITEM_2)).getByRole("button", { name: "พร้อมเสิร์ฟ" })).toBeVisible();
    expect(cardOf("ffffffff-0000-0000-0000-000000000003").querySelector("button")).toBeNull();
  });
});

describe("Transition flow (optimistic + conflict)", () => {
  it("pending ปิดปุ่ม — กันดับเบิ้ล action ขณะ transition ค้าง", () => {
    actionMocks.advanceKitchenItemAction.mockReturnValue(new Promise(() => {})); // ค้างตลอด
    renderPanel([makeItem()]);

    const button = within(cardOf(ITEM_1)).getByRole("button", { name: "รับรายการ" });
    fireEvent.click(button);
    fireEvent.click(button); // ครั้งที่สองต้องไม่สร้าง action ที่สอง

    expect(actionMocks.advanceKitchenItemAction).toHaveBeenCalledTimes(1);
    const pendingButton = within(cardOf(ITEM_1)).getByRole("button", { name: "กำลังบันทึก…" });
    expect(pendingButton).toBeDisabled();
    expect(pendingButton).toHaveAttribute("aria-busy", "true");
  });

  it("optimistic ordering: UI สลับสถานะทันที (version เดิม) แล้วอัปเดต version จากผล server", async () => {
    let resolveAction!: (value: unknown) => void;
    actionMocks.advanceKitchenItemAction.mockImplementationOnce(
      () => new Promise((resolve) => { resolveAction = resolve; }),
    );
    renderPanel([makeItem()]);

    fireEvent.click(within(cardOf(ITEM_1)).getByRole("button", { name: "รับรายการ" }));

    // ก่อน server ตอบ: แสดงสถานะเป้าหมายแล้ว แต่ version ยังเป็นค่าเดิม
    expect(actionMocks.advanceKitchenItemAction).toHaveBeenCalledWith(
      ORDER_1,
      ITEM_1,
      1,
      "preparing",
    );
    const card = within(cardOf(ITEM_1));
    expect(card.getByText("กำลังเตรียม")).toBeVisible();
    expect(card.getByText("v1")).toBeVisible();

    resolveAction({ ok: true, fulfillmentStatus: "preparing", fulfillmentVersion: 2 });
    await waitFor(() => expect(within(cardOf(ITEM_1)).getByText("v2")).toBeVisible());
    // server ยืนยันแล้ว — ปุ่มถัดไปคือขั้นถัดไปจริง
    expect(within(cardOf(ITEM_1)).getByRole("button", { name: "พร้อมเสิร์ฟ" })).toBeVisible();
  });

  it.each(["up_stale_version", "up_invalid_state_transition"] as const)(
    "conflict (%s): refetch จาก server และแสดง server truth — ไม่ overwrite ด้วย state ท้องถิ่น",
    async (code) => {
      actionMocks.advanceKitchenItemAction.mockResolvedValueOnce({
        ok: false,
        code,
        message: "เวอร์ชันเก่า",
      });
      const serverTruth = [
        makeItem({ fulfillmentStatus: "ready", fulfillmentVersion: 3, note: "server-truth" }),
        makeItem({ itemId: ITEM_2, orderId: ORDER_2, orderNumber: "A-1002", tableNumber: "2" }),
      ];
      actionMocks.fetchKitchenQueueAction.mockResolvedValueOnce({ items: serverTruth, error: null });
      renderPanel([makeItem()]); // UI ยังเชื่อว่า item เป็น v1/new

      fireEvent.click(within(cardOf(ITEM_1)).getByRole("button", { name: "รับรายการ" }));

      // optimistic จะแสดง กำลังเตรียม ชั่วครู่ แต่ปลายทางต้องเป็น server truth (ready v3)
      await waitFor(() => expect(within(cardOf(ITEM_1)).getByText("พร้อมเสิร์ฟ")).toBeVisible());
      await waitFor(() => expect(within(cardOf(ITEM_1)).getByText("v3")).toBeVisible());
      expect(within(cardOf(ITEM_1)).queryByText("กำลังเตรียม")).toBeNull();
      expect(actionMocks.fetchKitchenQueueAction).toHaveBeenCalledTimes(1);
      // item ที่ server คืนมาทั้งชุดต้องแสดงครบ (refetch ทับทั้ง state)
      expect(within(cardOf(ITEM_2)).getByText("ใหม่")).toBeVisible();
      // แจ้งเตือนแบบกู้คืนได้
      expect(screen.getByRole("status")).toHaveTextContent(/ถูกอัปเดตจากเครื่องอื่นก่อนหน้า/);
    },
  );

  it("error อื่น (ไม่ใช่ conflict): revert optimistic กลับ state เดิม + แจ้งข้อความ error", async () => {
    actionMocks.advanceKitchenItemAction.mockResolvedValueOnce({
      ok: false,
      code: "up_forbidden",
      message: "ไม่มีสิทธิ์เปลี่ยนสถานะรายการ",
    });
    renderPanel([makeItem()]);

    fireEvent.click(within(cardOf(ITEM_1)).getByRole("button", { name: "รับรายการ" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/ไม่มีสิทธิ์/));
    const card = within(cardOf(ITEM_1));
    expect(card.getByText("ใหม่")).toBeVisible(); // revert กลับ
    expect(card.getByText("v1")).toBeVisible();
    expect(card.getByRole("button", { name: "รับรายการ" })).toBeEnabled(); // pending หลุดแล้ว
  });
});

describe("Realtime wiring (U3 tracker + parser ของจริง)", () => {
  it("event version ใหม่ apply / event stale ถูกทิ้ง / item ไม่รู้จัก → refetch snapshot", async () => {
    renderPanel([makeItem()]);
    const handler = clientMock.state.lastChangeHandler;
    expect(handler, "panel ต้อง subscribe postgres_changes ของ order_items").not.toBeNull();

    // UPDATE v2 → apply
    handler!(itemChangePayload(ITEM_1, 2, "preparing"));
    await waitFor(() => expect(within(cardOf(ITEM_1)).getByText("v2")).toBeVisible());
    expect(within(cardOf(ITEM_1)).getByText("กำลังเตรียม")).toBeVisible();

    // UPDATE ย้อนหลัง (v1) → dedupe ทิ้ง ห้ามถอย version
    handler!(itemChangePayload(ITEM_1, 1, "new"));
    expect(within(cardOf(ITEM_1)).queryByText("ใหม่")).toBeNull();
    expect(within(cardOf(ITEM_1)).getByText("v2")).toBeVisible();

    // INSERT ของ item ที่ไม่เคยเห็น → ดึง snapshot จาก server หนึ่งครั้ง (collapse burst)
    const callsBefore = actionMocks.fetchKitchenQueueAction.mock.calls.length;
    handler!(itemChangePayload("ffffffff-0000-0000-0000-000000000099", 1, "new", "INSERT"));
    await waitFor(
      () => expect(actionMocks.fetchKitchenQueueAction.mock.calls.length).toBeGreaterThan(callsBefore),
      { timeout: 2000 },
    );
  });

  it("event เปลี่ยนสถานะข้ามชุด (voided) แสดงเป็น ยกเลิกแล้ว ตาม canonical void", async () => {
    renderPanel([makeItem()]);
    const handler = clientMock.state.lastChangeHandler!;
    handler!(itemChangePayload(ITEM_1, 2, "served", "UPDATE", true));
    await waitFor(() => expect(within(cardOf(ITEM_1)).getByText("ยกเลิกแล้ว")).toBeVisible());
    expect(cardOf(ITEM_1)).toHaveAttribute("data-kitchen-state", "voided");
  });
});

describe("Filters (สถานะ + โต๊ะ)", () => {
  const twoItems = () => [
    makeItem(), // QR, ใหม่, โต๊ะ 1
    makeItem({
      itemId: ITEM_2,
      orderId: ORDER_2,
      orderNumber: "A-1002",
      source: "staff",
      fulfillmentStatus: "ready",
      fulfillmentVersion: 2,
      tableNumber: "2",
      note: undefined,
    }),
  ];

  it("filter สถานะแสดงเฉพาะ effective state ที่เลือก", () => {
    renderPanel(twoItems());
    fireEvent.change(screen.getByLabelText("สถานะ"), { target: { value: "ready" } });
    expect(document.querySelectorAll("[data-kitchen-item]")).toHaveLength(1);
    expect(within(cardOf(ITEM_2)).getByText("พร้อมเสิร์ฟ")).toBeVisible();

    fireEvent.change(screen.getByLabelText("สถานะ"), { target: { value: "voided" } });
    expect(document.querySelectorAll("[data-kitchen-item]")).toHaveLength(0);
    expect(screen.getByText("ไม่มีรายการที่ตรงกับตัวกรอง")).toBeVisible();
  });

  it("filter โต๊ะแสดงเฉพาะรายการของโต๊ะที่เลือก", () => {
    renderPanel(twoItems());
    fireEvent.change(screen.getByLabelText("โต๊ะ"), { target: { value: "1" } });
    expect(document.querySelectorAll("[data-kitchen-item]")).toHaveLength(1);
    expect(within(cardOf(ITEM_1)).getByText("โต๊ะ 1")).toBeVisible();

    fireEvent.change(screen.getByLabelText("โต๊ะ"), { target: { value: "all" } });
    expect(document.querySelectorAll("[data-kitchen-item]")).toHaveLength(2);
  });
});
