// P0 — session/terminal registry แบบ durable
//
// เทสชุดนี้ไล่ตาม "เหตุผลที่ไฟล์นี้มีอยู่" ไม่ใช่ไล่ตามเมธอด: สองข้อแรกคือบั๊กจริงที่บล็อก
// การเปิด mutation บน production (แท็บที่สองโดนปฏิเสธ / session หายข้าม instance)
// ถ้าสองข้อนั้นแดง แปลว่าเรากลับไปที่เดิม

import { describe, it, expect, beforeEach } from "vitest";
import {
  DurableAssistantSessionStore,
  LEGACY_DEVICE_ID,
  normalizeDeviceId,
} from "@/modules/ai-assistant/durable-session";

type Row = {
  id: string;
  organization_id: string;
  store_id: string;
  user_id: string;
  device_id: string;
  session_id: string;
  bound_cart_id: string | null;
  last_cart_version: number;
  created_at: string;
  expires_at: string;
};

const ORG = "11111111-1111-1111-1111-111111111111";
const STORE = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";

/**
 * Fake ของตาราง ai_assistant_sessions ที่บังคับ constraint จริงสองข้อ:
 * unique ต่อเครื่อง และ unique ของ session_id — ถ้าไม่บังคับ เทสจะผ่านทั้งที่ของจริงพัง
 */
function createFakeTable() {
  const rows: Row[] = [];
  let seq = 0;

  const matches = (row: Row, filters: [string, unknown][]) =>
    filters.every(([col, value]) => {
      if (col.startsWith("gt:")) return row[col.slice(3) as keyof Row]! > (value as string);
      if (col.startsWith("lt:")) return row[col.slice(3) as keyof Row]! < (value as string);
      if (col.startsWith("lte:")) return (row[col.slice(4) as keyof Row] as number) <= (value as number);
      if (col.startsWith("is:")) return row[col.slice(3) as keyof Row] === null;
      return row[col as keyof Row] === value;
    });

  function builder(table: string) {
    if (table !== "ai_assistant_sessions") throw new Error(`unexpected table ${table}`);
    const filters: [string, unknown][] = [];
    let mode: "select" | "insert" | "update" | "delete" = "select";
    let payload: Partial<Row> = {};

    const api = {
      select() { return api; },
      insert(values: Partial<Row>) { mode = "insert"; payload = values; return api; },
      update(values: Partial<Row>) { mode = "update"; payload = values; return api; },
      delete() { mode = "delete"; return api; },
      eq(col: string, value: unknown) { filters.push([col, value]); return api; },
      gt(col: string, value: unknown) { filters.push([`gt:${col}`, value]); return api; },
      lt(col: string, value: unknown) { filters.push([`lt:${col}`, value]); return api; },
      lte(col: string, value: unknown) { filters.push([`lte:${col}`, value]); return api; },
      is(col: string) { filters.push([`is:${col}`, null]); return api; },
      in(col: string, values: unknown[]) { filters.push([`in:${col}`, values]); return api; },
      limit() { return api; },
      maybeSingle() { return run(); },
      single() { return run(); },
      then(resolve: (value: unknown) => unknown) { return Promise.resolve(run()).then(resolve); },
    };

    function run() {
      if (mode === "insert") {
        const candidate = payload as Row;
        const terminalClash = rows.some((r) =>
          r.organization_id === candidate.organization_id && r.store_id === candidate.store_id
          && r.user_id === candidate.user_id && r.device_id === candidate.device_id);
        const sessionClash = rows.some((r) => r.session_id === candidate.session_id);
        if (terminalClash || sessionClash) return { data: null, error: { code: "23505" } };
        seq += 1;
        const row: Row = {
          ...candidate,
          id: candidate.id ?? `row-${seq}`,
          bound_cart_id: candidate.bound_cart_id ?? null,
          last_cart_version: candidate.last_cart_version ?? 0,
          created_at: candidate.created_at ?? new Date().toISOString(),
        };
        rows.push(row);
        return { data: row, error: null };
      }
      const hits = rows.filter((r) =>
        matches(r, filters.filter(([c]) => !c.startsWith("in:"))));
      if (mode === "delete") {
        const inFilter = filters.find(([c]) => c.startsWith("in:"));
        const doomed = inFilter
          ? rows.filter((r) => (inFilter[1] as string[]).includes(r.id))
          : hits;
        for (const row of doomed) rows.splice(rows.indexOf(row), 1);
        return { data: null, error: null };
      }
      if (mode === "update") {
        if (hits.length === 0) return { data: null, error: null };
        Object.assign(hits[0], payload);
        return { data: hits[0], error: null };
      }
      return { data: hits[0] ?? null, error: null };
    }

    return api;
  }

  return {
    rows,
    client: { from: (table: string) => builder(table) } as never,
  };
}

describe("DurableAssistantSessionStore", () => {
  let table: ReturnType<typeof createFakeTable>;
  let now: number;
  const store = () =>
    new DurableAssistantSessionStore(table.client, {
      allowedTools: ["pos.add_item"],
      clock: () => now,
      sweepIntervalMs: 10 ** 9,
    });

  beforeEach(() => {
    table = createFakeTable();
    now = Date.parse("2026-09-22T10:00:00.000Z");
  });

  it("บั๊กที่ต้องหาย: สองแท็บของคนเดียวกันได้คนละ session และผูกตะกร้าคนละใบได้", async () => {
    const s = store();
    const tabA = await s.resolve({ organizationId: ORG, storeId: STORE, userId: USER, deviceId: "dev-aaaaaaaa" });
    const tabB = await s.resolve({ organizationId: ORG, storeId: STORE, userId: USER, deviceId: "dev-bbbbbbbb" });
    expect(tabA.id).not.toBe(tabB.id);

    const ctx = (sessionId: string) => ({ organizationId: ORG, storeId: STORE, userId: USER, sessionId });
    expect(await s.bindCart(ctx(tabA.id), "cart-aaaaaaaa", 1)).toEqual({ activeCartId: "cart-aaaaaaaa", cartVersion: 1 });
    // ก่อนมี registry บรรทัดถัดไปคืน null = CONTEXT_UNAVAILABLE ที่หน้าร้านเจอจริง
    expect(await s.bindCart(ctx(tabB.id), "cart-bbbbbbbb", 1)).toEqual({ activeCartId: "cart-bbbbbbbb", cartVersion: 1 });
  });

  it("บั๊กที่ต้องหาย: instance ใหม่ของเครื่องเดิมได้ session เดิม ไม่ใช่ session ใหม่", async () => {
    const first = await store().resolve({ organizationId: ORG, storeId: STORE, userId: USER, deviceId: "dev-aaaaaaaa" });
    // store ใหม่ = จำลอง process/instance ใหม่ที่ไม่มีหน่วยความจำร่วมกับตัวเดิมเลย
    const second = await store().resolve({ organizationId: ORG, storeId: STORE, userId: USER, deviceId: "dev-aaaaaaaa" });
    expect(second.id).toBe(first.id);
    expect(table.rows).toHaveLength(1);
  });

  it("session หมดอายุแล้วได้ตัวใหม่ และไม่ทิ้งแถวเก่าไว้ให้ชน unique", async () => {
    const s = store();
    const first = await s.resolve({ organizationId: ORG, storeId: STORE, userId: USER, deviceId: "dev-aaaaaaaa" });
    now += 31 * 60 * 1000;
    const second = await s.resolve({ organizationId: ORG, storeId: STORE, userId: USER, deviceId: "dev-aaaaaaaa" });
    expect(second.id).not.toBe(first.id);
    expect(table.rows).toHaveLength(1);
  });

  it("ตะกร้าผูกใบเดียวตลอดอายุ session", async () => {
    const s = store();
    const session = await s.resolve({ organizationId: ORG, storeId: STORE, userId: USER, deviceId: "dev-aaaaaaaa" });
    const ctx = { organizationId: ORG, storeId: STORE, userId: USER, sessionId: session.id };
    expect(await s.bindCart(ctx, "cart-aaaaaaaa", 1)).not.toBeNull();
    expect(await s.bindCart(ctx, "cart-zzzzzzzz", 2)).toBeNull();
    expect(await s.bindCart(ctx, "cart-aaaaaaaa", 2)).toEqual({ activeCartId: "cart-aaaaaaaa", cartVersion: 2 });
  });

  it("version ย้อนหลังถูกปฏิเสธ (คำสั่งค้างเก่าจากสถานะก่อนหน้า)", async () => {
    const s = store();
    const session = await s.resolve({ organizationId: ORG, storeId: STORE, userId: USER, deviceId: "dev-aaaaaaaa" });
    const ctx = { organizationId: ORG, storeId: STORE, userId: USER, sessionId: session.id };
    await s.bindCart(ctx, "cart-aaaaaaaa", 5);
    expect(await s.bindCart(ctx, "cart-aaaaaaaa", 4)).toBeNull();
    expect(await s.bindCart(ctx, "cart-aaaaaaaa", 5)).not.toBeNull();
  });

  it("session id ของคนอื่นยื่นเข้ามาถูกปฏิเสธ", async () => {
    const s = store();
    const session = await s.resolve({ organizationId: ORG, storeId: STORE, userId: USER, deviceId: "dev-aaaaaaaa" });
    const stolen = { organizationId: ORG, storeId: STORE, userId: "44444444-4444-4444-4444-444444444444", sessionId: session.id };
    expect(await s.bindCart(stolen, "cart-aaaaaaaa", 1)).toBeNull();
  });

  it("session ที่หมดอายุผูกตะกร้าไม่ได้", async () => {
    const s = store();
    const session = await s.resolve({ organizationId: ORG, storeId: STORE, userId: USER, deviceId: "dev-aaaaaaaa" });
    const ctx = { organizationId: ORG, storeId: STORE, userId: USER, sessionId: session.id };
    now += 31 * 60 * 1000;
    expect(await s.bindCart(ctx, "cart-aaaaaaaa", 1)).toBeNull();
  });

  it("ค่าตะกร้า/เวอร์ชันที่ผิดรูปถูกปฏิเสธก่อนแตะฐานข้อมูล", async () => {
    const s = store();
    const session = await s.resolve({ organizationId: ORG, storeId: STORE, userId: USER, deviceId: "dev-aaaaaaaa" });
    const ctx = { organizationId: ORG, storeId: STORE, userId: USER, sessionId: session.id };
    for (const bad of ["สั้น", "cart with space", 42, null, undefined]) {
      expect(await s.bindCart(ctx, bad, 1)).toBeNull();
    }
    for (const bad of [-1, 1.5, "1", NaN, undefined]) {
      expect(await s.bindCart(ctx, "cart-aaaaaaaa", bad)).toBeNull();
    }
  });

  it("client เก่าที่ไม่ส่ง device id ยังใช้ได้ และได้พฤติกรรมเดิมหนึ่งผู้ใช้หนึ่ง session", async () => {
    const s = store();
    const a = await s.resolve({ organizationId: ORG, storeId: STORE, userId: USER });
    const b = await s.resolve({ organizationId: ORG, storeId: STORE, userId: USER });
    expect(a.id).toBe(b.id);
    expect(table.rows[0].device_id).toBe(LEGACY_DEVICE_ID);
  });

  it("device id ที่ผิดรูปไม่ทำให้ล้ม แต่ตกไปใช้ค่าเดิมของผู้ใช้", () => {
    expect(normalizeDeviceId("dev-aaaaaaaa")).toBe("dev-aaaaaaaa");
    for (const bad of ["สั้น", "has space", "", null, undefined, 7, "x".repeat(200)]) {
      expect(normalizeDeviceId(bad)).toBe(LEGACY_DEVICE_ID);
    }
  });

  it("identity ที่ไม่ครบถูกปฏิเสธก่อนแตะฐานข้อมูล", async () => {
    const s = store();
    await expect(s.resolve({ organizationId: "", storeId: STORE, userId: USER })).rejects.toThrow();
    expect(table.rows).toHaveLength(0);
  });
});
