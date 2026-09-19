import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildStationTicketJobs,
  buildStationTicketSourceKey,
  parseStationTicketSourceKey,
} from "@/modules/printing/station-routing";

vi.mock("@/modules/printing/receipt-printer-bytes", () => ({
  buildReceiptPrinterBytes: vi.fn(async () => new Uint8Array([1, 2, 3])),
}));

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const ORDER = "11111111-2222-4333-8444-555555555555";
const STATION_HOT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const STATION_BAR = "ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee";

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

describe("enqueueStationTickets", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the source key and counts server-deduped tickets separately", async () => {
    const { enqueueStationTickets, describeStationPrintResult } = await import(
      "@/modules/printing/station-print-client"
    );
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      const deduped = bodies.length === 2;
      return new Response(JSON.stringify({ ok: true, jobId: "j", deduped }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { jobs } = buildStationTicketJobs({
      orderId: ORDER,
      orderNumber: "A1",
      paperWidth: "80mm",
      printedAt: "2026-09-19T10:00:00.000Z",
      items: [
        { name: "ข้าวผัด", modifierNames: [], quantity: 1, kitchenStationId: STATION_HOT },
        { name: "เบียร์", modifierNames: [], quantity: 1, kitchenStationId: STATION_BAR },
      ],
      stations: [
        { id: STATION_HOT, name: "ครัว", printerId: "p-hot" },
        { id: STATION_BAR, name: "บาร์", printerId: "p-bar" },
      ],
    });
    const res = await enqueueStationTickets(jobs);

    expect(bodies[0].sourceKey).toBe(buildStationTicketSourceKey(ORDER, STATION_HOT));
    expect(bodies[0].printerId).toBe("p-hot");
    expect(res).toEqual({ printed: 1, deduped: 1, failed: [] });
    expect(describeStationPrintResult(res)).toBe("พิมพ์ตั๋วครัว 2 สถานีแล้ว");
    expect(describeStationPrintResult({ printed: 0, deduped: 2, failed: [] })).toBe("ตั๋วครัวถูกส่งจากอีกจอแล้ว");
  });
});

describe("station ticket dedupe wiring", () => {
  it("enqueue route validates the key against the store and forwards it for schema dedupe", () => {
    const route = read("src/app/api/print/enqueue/route.ts");
    expect(route).toContain("parseStationTicketSourceKey(body.sourceKey)");
    expect(route).toContain("checkStationTicketSource(ctx.storeId, parsed.orderId, parsed.stationId)");
    expect(route).toContain('skipped: "table_bill"');
    expect(route.match(/\.\.\.dedupeFields/g)).toHaveLength(3);
    expect(route).toContain("deduped: Boolean(");
    expect(route).toContain('source: "printing.station-ticket"');
  });

  it("the source check is scoped to the store and refuses table bills", () => {
    const repo = read("src/modules/printing/print-hub-repository.ts");
    expect(repo).toContain("export async function checkStationTicketSource");
    expect(repo).toMatch(/from\("orders"\)\.select\("id, table_bill_key"\)\.eq\("id", orderId\)\.eq\("store_id", storeId\)/);
    expect(repo).toMatch(/from\("kitchen_stations"\)\.select\("id"\)\.eq\("id", stationId\)\.eq\("store_id", storeId\)/);
  });

  it("QR notifier and delivery dispatch keyed tickets from any screen", () => {
    const notifier = read("src/app/(dashboard)/QrOrderGlobalNotifier.tsx");
    expect(notifier).toContain("dispatchOrderStationTickets({");
    expect(notifier).toContain("orderId: visibleOrder.id,");
    expect(notifier).not.toContain("autoPrintStationTickets && canViewEveryKitchenStation");
    const delivery = read("src/app/(dashboard)/delivery/print-kitchen.ts");
    expect(delivery).toContain("orderId: internalOrderId,");
  });

  it("unified settlement skips rounds already ticketed at send-to-kitchen", () => {
    const intent = read("src/modules/unified-pos/print-intent.ts");
    expect(intent).toContain("listExistingPrintJobSourceKeys(");
    expect(intent).toContain("if (alreadyTicketed.has(buildStationTicketSourceKey(item.order_id, item.kitchen_station_id))) continue;");
  });

  it("POS prints kitchen tickets on pay-now (not for held tickets) and on send-to-kitchen", () => {
    const pos = read("src/app/pos/PosTerminal.tsx");
    expect(pos).toMatch(/if \(!activeTicket\) \{\s*sendStationTickets\(order, displayCart\.items, checkoutTicketContext\.tableNumber\);/);
    expect(pos).toContain("sendStationTickets({ orderId: res.orderId, orderNumber: res.orderNumber }, sentItems, table.number);");
    expect(pos).toContain("Boolean(receiptSettings?.autoPrintStationTickets)");
    const page = read("src/app/pos/page.tsx");
    expect(page).toContain("listKitchenStations(ctx.storeId)");
    expect(page).toContain("stationPrinters={(stationsResult.data ?? [])");
  });
});
