// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- ฐานข้อมูลปลอม (เฉพาะคำสั่งที่ direct-print-repository ใช้) ----
type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {};
function builder(table: string) {
  const filters: ((r: Row) => boolean)[] = [];
  let op: "select" | "update" | "upsert" | "delete" = "select";
  let patch: Row = {};
  let upsertRow: Row | null = null;
  const rows = () => (tables[table] ??= []);
  const run = () => {
    if (op === "upsert") {
      const dup = rows().find((r) => r.store_id === upsertRow!.store_id && r.source_key === upsertRow!.source_key);
      if (dup) return [];
      const row = { id: crypto.randomUUID(), status: "claimed", claimed_at: new Date().toISOString(), ...upsertRow };
      rows().push(row);
      return [row];
    }
    const matched = rows().filter((r) => filters.every((f) => f(r)));
    if (op === "update") matched.forEach((r) => Object.assign(r, patch));
    if (op === "delete") tables[table] = rows().filter((r) => !matched.includes(r));
    return matched;
  };
  const api = {
    select: () => api,
    upsert: (row: Row) => ((op = "upsert"), (upsertRow = row), api),
    update: (p: Row) => ((op = "update"), (patch = p), api),
    delete: () => ((op = "delete"), api),
    eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), api),
    lt: (k: string, v: string) => (filters.push((r) => String(r[k]) < v), api),
    maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
    then: (resolve: (v: { data: Row[]; error: null }) => unknown) => resolve({ data: run(), error: null }),
  };
  return api;
}
vi.mock("@/server/integrations/supabase/server", () => ({
  createSupabaseServiceClient: async () => ({ from: (t: string) => builder(t) }),
}));
vi.mock("@/modules/printing/receipt-printer-bytes", () => ({
  buildReceiptPrinterBytes: vi.fn(async () => new Uint8Array([0x1b, 0x40])),
}));
const launcher = vi.hoisted(() => ({
  available: true,
  outcome: "printed" as "printed" | "failed" | "unknown",
  printed: [] as unknown[],
}));
vi.mock("@/modules/printing/launcher-direct-print", () => ({
  isDirectPrintAvailable: async () => launcher.available,
  printDirect: async (req: unknown) => {
    launcher.printed.push(req);
    return { outcome: launcher.outcome, error: launcher.outcome === "printed" ? null : "ไม่ตอบ", attempts: 1, elapsedMs: 900 };
  },
}));

import {
  DIRECT_CLAIM_STALE_MS,
  __clearPrintModeCache,
  claimDirectStationTicket,
  finishDirectStationTicket,
  getStorePrintMode,
  parsePrintMode,
} from "@/modules/printing/direct-print-repository";
import { describeStationPrintResult, enqueueStationTickets } from "@/modules/printing/station-print-client";

const STORE = "22222222-2222-4222-8222-222222222222";
const ORG = "33333333-3333-4333-8333-333333333333";
const KEY = "station_ticket:44444444-4444-4444-8444-444444444444:55555555-5555-4555-8555-555555555555";
const claimInput = (userId: string) => ({ organizationId: ORG, storeId: STORE, sourceKey: KEY, printerId: "p1", userId });

describe("D3 วิธีพิมพ์ระดับร้าน + จองตั๋วครัว", () => {
  beforeEach(() => {
    for (const k of Object.keys(tables)) delete tables[k];
    __clearPrintModeCache();
    launcher.available = true;
    launcher.outcome = "printed";
    launcher.printed = [];
  });
  afterEach(() => vi.unstubAllGlobals());

  it("ค่าแปลก/อ่านไม่ได้ = hub (พฤติกรรมเดิม)", async () => {
    expect(parsePrintMode("weird")).toBe("hub");
    tables.stores = [{ id: STORE, print_mode: "direct" }];
    expect(await getStorePrintMode(STORE)).toBe("direct");
    expect(await getStorePrintMode("missing")).toBe("hub");
  });

  it("สองจอจองตั๋วเดียวกัน = ได้จอเดียว", async () => {
    expect(await claimDirectStationTicket(claimInput("u1"))).toEqual({ claim: "mine" });
    expect(await claimDirectStationTicket(claimInput("u2"))).toEqual({ claim: "taken", status: "claimed" });
  });

  it("พิมพ์ล้มแบบยังไม่ได้ส่ง = ปล่อยการจอง ลองใหม่ได้ / unknown = ห้ามพิมพ์ซ้ำ", async () => {
    await claimDirectStationTicket(claimInput("u1"));
    await finishDirectStationTicket({ storeId: STORE, sourceKey: KEY, userId: "u1", outcome: "failed" });
    expect(await claimDirectStationTicket(claimInput("u2"))).toEqual({ claim: "mine" });
    await finishDirectStationTicket({ storeId: STORE, sourceKey: KEY, userId: "u2", outcome: "unknown", error: "ECONNRESET" });
    expect(await claimDirectStationTicket(claimInput("u1"))).toEqual({ claim: "taken", status: "unknown" });
  });

  it("จองค้างเกิน 2 นาที (จอเดิมหาย) = จอถัดไปจองต่อได้", async () => {
    await claimDirectStationTicket(claimInput("u1"));
    tables.print_direct_claims[0].claimed_at = new Date(Date.now() - DIRECT_CLAIM_STALE_MS - 1000).toISOString();
    expect(await claimDirectStationTicket(claimInput("u2"))).toEqual({ claim: "mine" });
  });

  const job = { sourceKey: KEY, printerId: "p1", stationId: "s1", stationName: "บาร์", receipt: { orderNumber: "261126-0042" } } as never;
  function stubFetch(claim: Record<string, unknown>) {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      if (url === "/api/print/direct-claim") return new Response(JSON.stringify(claim), { status: 200 });
      if (url === "/api/print/direct-result") return new Response("{}", { status: 200 });
      return new Response(JSON.stringify({ deduped: false }), { status: 200 });
    }));
    return calls;
  }

  it("โปรแกรม POS + ร้านโหมดพิมพ์ตรง: จอง → พิมพ์ตรงเข้าเครื่องของสถานี → รายงานผล (ไม่เข้าคิว)", async () => {
    const calls = stubFetch({ mode: "direct", claim: "mine", printer: { id: "p1", host: "192.168.1.21", port: 9100 } });
    const result = await enqueueStationTickets([job]);
    expect(result.printedDirect).toBe(1);
    expect(result.queued).toBe(0);
    expect(describeStationPrintResult(result)).toBe("พิมพ์ตั๋วครัวแล้ว 1 สถานี");
    expect(launcher.printed[0]).toMatchObject({ host: "192.168.1.21", kind: "kitchen" });
    expect(calls.map((c) => c.url)).toEqual(["/api/print/direct-claim", "/api/print/direct-result"]);
    expect(calls[1].body).toMatchObject({ sourceKey: KEY, outcome: "printed" });
  });

  it("วิธีพิมพ์ถูกแคช (ไม่ query ทุกงานพิมพ์)", async () => {
    tables.stores = [{ id: STORE, print_mode: "direct" }];
    expect(await getStorePrintMode(STORE)).toBe("direct");
    tables.stores[0].print_mode = "hub";
    expect(await getStorePrintMode(STORE)).toBe("direct");
  });

  it("รายงานผลไม่ถึงครั้งแรก = ลองซ้ำจนถึง", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let resultCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/print/direct-claim") {
        return new Response(JSON.stringify({ mode: "direct", claim: "mine", printer: { id: "p1", host: "192.168.1.21", port: 9100 } }), { status: 200 });
      }
      resultCalls += 1;
      if (resultCalls === 1) throw new TypeError("network down");
      return new Response("{}", { status: 200 });
    }));
    const pending = enqueueStationTickets([job]);
    await vi.advanceTimersByTimeAsync(2000);
    const result = await pending;
    vi.useRealTimers();
    expect(resultCalls).toBe(2);
    expect(result.printedDirect).toBe(1);
  });

  it("จออื่นจองไปแล้ว = ไม่พิมพ์ซ้ำ", async () => {
    stubFetch({ mode: "direct", claim: "taken", status: "printed" });
    const result = await enqueueStationTickets([job]);
    expect(result.alreadyQueued).toBe(1);
    expect(launcher.printed).toHaveLength(0);
  });

  it("ร้านยังโหมด hub = ไปทางคิวเดิม", async () => {
    const calls = stubFetch({ mode: "hub" });
    await enqueueStationTickets([job]);
    expect(calls.map((c) => c.url)).toEqual(["/api/print/direct-claim", "/api/print/enqueue"]);
    expect(launcher.printed).toHaveLength(0);
  });

  it("นอกโปรแกรม POS = คิวเดิม ไม่ถาม direct-claim", async () => {
    launcher.available = false;
    const calls = stubFetch({});
    await enqueueStationTickets([job]);
    expect(calls.map((c) => c.url)).toEqual(["/api/print/enqueue"]);
  });

  it("enqueue ปฏิเสธเมื่อร้านโหมดพิมพ์ตรง + migration ปิดสิทธิ์ client + โปรแกรม POS เปิด QR ก่อนล็อกอิน", () => {
    const enqueue = readFileSync("src/app/api/print/enqueue/route.ts", "utf8");
    expect(enqueue).toContain('(await getStorePrintMode(ctx.storeId)) === "direct"');
    expect(enqueue).toContain("status: 409");
    const migration = readFileSync("supabase/migrations/20261211120000_store_print_mode_direct.sql", "utf8");
    expect(migration).toContain("check (print_mode in ('hub', 'direct'))");
    expect(migration).toContain("revoke all on public.print_direct_claims from anon, authenticated");
    const login = readFileSync("src/app/(auth)/login/page.tsx", "utf8");
    expect(login).toContain('router.replace("/device-login")');
    expect(login).toContain('params.get("method") === "password"');
    expect(readFileSync("src/app/device-login/DeviceLoginQr.tsx", "utf8")).toContain('href="/login?method=password"');
  });
});
