import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildStationTicketJobs,
  buildStationTicketSourceKey,
  parseStationTicketSourceKey,
} from "@/modules/printing/station-routing";
import { USB_RETARGET_NOTE, decidePriorStationTicket } from "@/modules/printing/station-ticket-status";

vi.mock("@/modules/printing/receipt-printer-bytes", () => ({
  buildReceiptPrinterBytes: vi.fn(async () => new Uint8Array([1, 2, 3])),
}));

const repo = vi.hoisted(() => ({
  resolveStationTicketSource: vi.fn(),
  enqueuePrintJob: vi.fn(),
  getHubStatus: vi.fn(async () => ({ data: { lastSeen: null }, error: null })),
  listPrintJobStatusesBySourceKeys: vi.fn(),
  findPrintJobIdBySourceKey: vi.fn(async () => null),
  countPrintJobsBySourceKeyPrefix: vi.fn(async () => 0),
}));
vi.mock("@/modules/printing/print-hub-repository", () => repo);

const guards = vi.hoisted(() => ({ getOptionalResolvedCurrentPermissions: vi.fn() }));
vi.mock("@/modules/auth/guards", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/auth/guards")>()),
  getOptionalResolvedCurrentPermissions: guards.getOptionalResolvedCurrentPermissions,
}));

const stores = vi.hoisted(() => ({ getPrinter: vi.fn() }));
vi.mock("@/modules/stores/repository", () => stores);

vi.mock("@/modules/system/event-log", () => ({ logSystemEvent: vi.fn(async () => undefined) }));

// fake service client สำหรับ settlement intent — ทุก query คืน fixture ของตารางนั้น
const tables = vi.hoisted(() => ({ rows: {} as Record<string, unknown[]> }));
vi.mock("@/server/integrations/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => ({
    from(table: string) {
      const rows = tables.rows[table] ?? [];
      const builder: Record<string, unknown> = {};
      for (const method of ["select", "eq", "in", "order", "limit"]) builder[method] = () => builder;
      builder.maybeSingle = async () => ({ data: rows[0] ?? null, error: null });
      builder.then = (resolve: (value: unknown) => unknown) => resolve({ data: rows, error: null });
      return builder;
    },
  })),
}));

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const STORE = "99999999-2222-4333-8444-555555555555";
const ORDER = "11111111-2222-4333-8444-555555555555";
const STATION_HOT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const STATION_BAR = "ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ctx = { storeId: STORE, organizationId: "org-1", userId: "user-1" };

beforeEach(() => {
  vi.clearAllMocks();
  guards.getOptionalResolvedCurrentPermissions.mockResolvedValue({ ctx, resolved: { can: () => true } });
  stores.getPrinter.mockImplementation(async (id: string) => ({
    data: { id, type: "ip", ipAddress: "192.168.1.20", port: 9100 },
    error: null,
  }));
  repo.enqueuePrintJob.mockResolvedValue({ data: { id: "job-1", status: "pending" }, error: null });
});

describe("station ticket source key", () => {
  it("round-trips order + station ids", () => {
    const key = buildStationTicketSourceKey(ORDER, STATION_HOT);
    expect(key).toBe(`station_ticket:${ORDER}:${STATION_HOT}`);
    expect(parseStationTicketSourceKey(key)).toEqual({ orderId: ORDER, stationId: STATION_HOT });
  });

  it("normalises case so every screen builds the same key", () => {
    expect(buildStationTicketSourceKey(ORDER.toUpperCase(), STATION_HOT)).toBe(
      buildStationTicketSourceKey(ORDER, STATION_HOT),
    );
  });

  it("rejects anything that is not exactly two uuids", () => {
    expect(parseStationTicketSourceKey("station_ticket:abc:def")).toBeNull();
    expect(parseStationTicketSourceKey(`unified_pos_settlement:${ORDER}:station:${STATION_HOT}`)).toBeNull();
    expect(parseStationTicketSourceKey(`station_ticket:${ORDER}:${STATION_HOT}:x`)).toBeNull();
    expect(parseStationTicketSourceKey(42)).toBeNull();
  });

  it("stamps a source key on each job only when the order id is known", () => {
    const base = {
      orderNumber: "A1",
      paperWidth: "80mm" as const,
      printedAt: "2026-09-19T10:00:00.000Z",
      items: [
        { name: "ข้าวผัด", modifierNames: [], quantity: 1, kitchenStationId: STATION_HOT },
        { name: "เบียร์", modifierNames: [], quantity: 2, kitchenStationId: STATION_BAR },
      ],
      stations: [
        { id: STATION_HOT, name: "ครัว", printerId: "p-hot" },
        { id: STATION_BAR, name: "บาร์", printerId: "p-bar" },
      ],
    };
    const keyed = buildStationTicketJobs({ ...base, orderId: ORDER });
    expect(keyed.jobs.map((job) => job.sourceKey)).toEqual([
      buildStationTicketSourceKey(ORDER, STATION_HOT),
      buildStationTicketSourceKey(ORDER, STATION_BAR),
    ]);
    const legacy = buildStationTicketJobs(base);
    expect(legacy.jobs.every((job) => job.sourceKey === undefined)).toBe(true);
  });
});

describe("decidePriorStationTicket (lifecycle-aware dedupe)", () => {
  it("prints when there is no prior job or the prior job failed", () => {
    expect(decidePriorStationTicket(undefined)).toBe("print");
    expect(decidePriorStationTicket({ status: "failed", error: "Connection timed out" })).toBe("print");
  });

  it("skips jobs that are queued, printing or printed", () => {
    for (const status of ["pending", "claimed", "printed"] as const) {
      expect(decidePriorStationTicket({ status, error: null })).toBe("skip");
    }
  });

  it("never treats unknown as printed — flags it for a human", () => {
    expect(decidePriorStationTicket({ status: "unknown", error: null })).toBe("uncertain");
  });

  it("does not reprint a failed job the Hub already moved to the USB printer", () => {
    expect(decidePriorStationTicket({ status: "failed", error: `timeout — ${USB_RETARGET_NOTE}` })).toBe("skip");
  });
});

describe("POST /api/print/enqueue — station tickets", () => {
  async function post(body: Record<string, unknown>) {
    const { POST } = await import("@/app/api/print/enqueue/route");
    const { NextRequest } = await import("next/server");
    const res = await POST(
      new NextRequest("http://localhost/api/print/enqueue", { method: "POST", body: JSON.stringify(body) }),
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }
  const sourceKey = buildStationTicketSourceKey(ORDER, STATION_HOT);

  it("prints to the station's current printer, not the stale printerId a client sent", async () => {
    repo.resolveStationTicketSource.mockResolvedValue({ data: { status: "ok", printerId: "p-station" }, error: null });
    const res = await post({ printerId: "p-stale", printJobBase64: "AAAA", sourceKey });
    expect(res.status).toBe(200);
    expect(stores.getPrinter).toHaveBeenCalledWith("p-station", STORE, "org-1");
    expect(repo.enqueuePrintJob).toHaveBeenCalledWith(
      expect.objectContaining({ printerId: "p-station", sourceKey, jobKind: "station_ticket", requeueFailed: true }),
    );
  });

  it("rejects a key whose order has no items for that station", async () => {
    repo.resolveStationTicketSource.mockResolvedValue({ data: { status: "no_items" }, error: null });
    const res = await post({ printerId: "p-hot", printJobBase64: "AAAA", sourceKey });
    expect(res.status).toBe(409);
    expect(repo.enqueuePrintJob).not.toHaveBeenCalled();
  });

  it("fails closed when the station/order lookup errors", async () => {
    repo.resolveStationTicketSource.mockResolvedValue({ data: null, error: { userMessage: "db down" } });
    const res = await post({ printerId: "p-hot", printJobBase64: "AAAA", sourceKey });
    expect(res.status).toBe(503);
    expect(repo.enqueuePrintJob).not.toHaveBeenCalled();
  });

  it("skips table bills without enqueuing", async () => {
    repo.resolveStationTicketSource.mockResolvedValue({ data: { status: "table_bill" }, error: null });
    const res = await post({ printerId: "p-hot", printJobBase64: "AAAA", sourceKey });
    expect(res.body.skipped).toBe("table_bill");
    expect(repo.enqueuePrintJob).not.toHaveBeenCalled();
  });

  it("reports the real status of a deduped job (unknown is not success)", async () => {
    repo.resolveStationTicketSource.mockResolvedValue({ data: { status: "ok", printerId: "p-hot" }, error: null });
    repo.enqueuePrintJob.mockResolvedValue({ data: { id: "job-old", status: "unknown", deduped: true }, error: null });
    const res = await post({ printerId: "p-hot", printJobBase64: "AAAA", sourceKey });
    expect(res.body).toMatchObject({ jobId: "job-old", jobStatus: "unknown", deduped: true, requeued: false });
  });
});

describe("enqueueStationTickets client result", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("separates new, already-queued, uncertain and failed tickets", async () => {
    const { enqueueStationTickets, describeStationPrintResult, stationPrintNeedsAttention } = await import(
      "@/modules/printing/station-print-client"
    );
    const replies = [
      { status: 200, body: { ok: true, jobId: "a", jobStatus: "pending", deduped: false } },
      { status: 200, body: { ok: true, jobId: "b", jobStatus: "printed", deduped: true } },
      { status: 200, body: { ok: true, jobId: "c", jobStatus: "unknown", deduped: true } },
      { status: 409, body: { error: "สถานีนี้ยังไม่ได้ผูกเครื่องพิมพ์" } },
    ];
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        const reply = replies[bodies.length - 1]!;
        return new Response(JSON.stringify(reply.body), { status: reply.status });
      }),
    );
    const job = (stationName: string) => ({
      sourceKey: buildStationTicketSourceKey(ORDER, STATION_HOT),
      printerId: "p",
      stationId: STATION_HOT,
      stationName,
      receipt: {} as never,
    });
    const res = await enqueueStationTickets([job("ครัว"), job("บาร์"), job("ของหวาน"), job("ย่าง")]);

    expect(bodies[0]!.sourceKey).toBe(buildStationTicketSourceKey(ORDER, STATION_HOT));
    expect(res.queued).toBe(1);
    expect(res.alreadyQueued).toBe(1);
    expect(res.uncertain).toEqual([{ stationName: "ของหวาน" }]);
    expect(res.failed).toEqual([{ stationName: "ย่าง", error: "สถานีนี้ยังไม่ได้ผูกเครื่องพิมพ์" }]);
    expect(stationPrintNeedsAttention(res)).toBe(true);
    const text = describeStationPrintResult(res);
    expect(text).toContain("ส่งตั๋วครัวเข้าคิว 1 สถานี");
    expect(text).toContain("ของหวาน สถานะไม่แน่ชัด");
    expect(text).toContain("ส่งตั๋วไม่สำเร็จ 1 สถานี (ย่าง)");
    expect(text).not.toContain("พิมพ์ตั๋วครัว");
    expect(describeStationPrintResult({ queued: 0, alreadyQueued: 2, uncertain: [], failed: [] })).toBe(
      "ตั๋วครัวถูกส่งจากอีกจอแล้ว",
    );
  });
});

describe("unified settlement station tickets vs tickets sent earlier", () => {
  const OP_KEY = "op-12345678-abcd";
  function seedSettlement() {
    tables.rows = {
      receipt_settings: [
        { store_name: "ร้าน", paper_width: "80mm", print_copies: 1, auto_print_receipt: false, auto_print_station_tickets: true },
      ],
      orders: [{ id: ORDER, order_number: "A1", table_number: "5", subtotal: 100, discount: 0, total: 100, loyalty_points_earned: null }],
      order_items: [
        {
          order_id: ORDER,
          product_name: "ข้าวผัด",
          variant_name: null,
          modifiers: [],
          quantity: 1,
          unit_price: 100,
          total_price: 100,
          note: null,
          kitchen_station_id: STATION_HOT,
        },
      ],
      payments: [],
      printers: [{ id: "p-hot", name: "ครัว", type: "ip", is_default: true, ip_address: "192.168.1.20", port: 9100, hub_bluetooth_port: null }],
      kitchen_stations: [{ id: STATION_HOT, name: "ครัว", printer_id: "p-hot" }],
    };
  }
  async function settle() {
    const { resolveSettlementPrintIntent } = await import("@/modules/unified-pos/print-intent");
    return resolveSettlementPrintIntent({
      organizationId: "org-1",
      storeId: STORE,
      actorUserId: "user-1",
      settlement: { order_ids: [ORDER] } as never,
      operationKey: OP_KEY,
      replayed: false,
    });
  }

  it("fails closed (no station ticket) when prior ticket state cannot be read", async () => {
    seedSettlement();
    repo.listPrintJobStatusesBySourceKeys.mockResolvedValue({ data: null, error: { userMessage: "db down" } });
    const intent = await settle();
    expect(repo.enqueuePrintJob).not.toHaveBeenCalled();
    expect(intent.stationJobIds).toEqual([]);
    expect(intent.stationNotice).toContain("อ่านสถานะตั๋วครัวเดิมไม่สำเร็จ");
  });

  it("does not reprint an unknown prior ticket but tells the cashier to check", async () => {
    seedSettlement();
    repo.listPrintJobStatusesBySourceKeys.mockResolvedValue({
      data: new Map([[buildStationTicketSourceKey(ORDER, STATION_HOT), { id: "j", status: "unknown", error: null }]]),
      error: null,
    });
    const intent = await settle();
    expect(repo.enqueuePrintJob).not.toHaveBeenCalled();
    expect(intent.stationNotice).toContain("สถานะไม่แน่ชัด");
  });

  it("reprints at settlement when the earlier ticket failed", async () => {
    seedSettlement();
    repo.listPrintJobStatusesBySourceKeys.mockResolvedValue({
      data: new Map([[buildStationTicketSourceKey(ORDER, STATION_HOT), { id: "j", status: "failed", error: "timeout" }]]),
      error: null,
    });
    await settle();
    expect(repo.enqueuePrintJob).toHaveBeenCalledWith(expect.objectContaining({ jobKind: "station_ticket" }));
  });

  it("skips a round whose ticket is already queued/printed", async () => {
    seedSettlement();
    repo.listPrintJobStatusesBySourceKeys.mockResolvedValue({
      data: new Map([[buildStationTicketSourceKey(ORDER, STATION_HOT), { id: "j", status: "printed", error: null }]]),
      error: null,
    });
    const intent = await settle();
    expect(repo.enqueuePrintJob).not.toHaveBeenCalled();
    expect(intent.stationNotice).toBeNull();
  });
});

describe("station ticket dedupe wiring", () => {
  it("QR notifier and delivery dispatch keyed tickets from any screen", () => {
    const notifier = read("src/app/(dashboard)/QrOrderGlobalNotifier.tsx");
    expect(notifier).toContain("dispatchOrderStationTickets({");
    expect(notifier).toContain("orderId: visibleOrder.id,");
    expect(notifier).not.toContain("autoPrintStationTickets && canViewEveryKitchenStation");
    const delivery = read("src/app/(dashboard)/delivery/print-kitchen.ts");
    expect(delivery).toContain("orderId: internalOrderId,");
  });

  it("POS prints kitchen tickets on pay-now (not for held tickets) and on send-to-kitchen", () => {
    const pos = read("src/app/pos/PosTerminal.tsx");
    expect(pos).toMatch(/if \(!activeTicket\) \{\s*sendStationTickets\(order, displayCart\.items, checkoutTicketContext\.tableNumber\);/);
    expect(pos).toContain("sendStationTickets({ orderId: res.orderId, orderNumber: res.orderNumber }, sentItems, table.number);");
    expect(pos).toContain("Boolean(receiptSettings?.autoPrintStationTickets)");
    expect(pos).toContain("stationPrintNeedsAttention(res)");
    const page = read("src/app/pos/page.tsx");
    expect(page).toContain("listKitchenStations(ctx.storeId)");
    expect(page).toContain("stationPrinters={(stationsResult.data ?? [])");
  });
});
