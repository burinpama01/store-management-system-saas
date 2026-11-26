import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ฐานข้อมูลปลอมในหน่วยความจำ — รองรับเฉพาะคำสั่งที่ device-login.ts ใช้
type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {};

function builder(table: string) {
  const filters: ((r: Row) => boolean)[] = [];
  let op: "select" | "update" | "insert" | "delete" = "select";
  let patch: Row = {};
  let inserted: Row | null = null;
  const rows = () => (tables[table] ??= []);
  const run = () => {
    if (op === "insert") {
      const row = { id: crypto.randomUUID(), status: "pending", failed_attempts: 0, created_at: new Date().toISOString(), ...inserted };
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
    insert: (row: Row) => ((op = "insert"), (inserted = row), api),
    update: (p: Row) => ((op = "update"), (patch = p), api),
    delete: () => ((op = "delete"), api),
    eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), api),
    gt: (k: string, v: string) => (filters.push((r) => String(r[k]) > v), api),
    lt: (k: string, v: string) => (filters.push((r) => String(r[k]) < v), api),
    not: (k: string) => (filters.push((r) => r[k] != null), api),
    maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
    single: async () => ({ data: run()[0] ?? null, error: null }),
    then: (resolve: (v: { data: Row[]; error: null }) => unknown) => resolve({ data: run(), error: null }),
  };
  return api;
}

vi.mock("@/server/integrations/supabase/server", () => ({
  createSupabaseServiceClient: async () => ({ from: (t: string) => builder(t) }),
}));

import {
  approveDeviceLoginRequest,
  consumeDeviceLoginTicket,
  createDeviceLoginRequest,
  generateShortCode,
  getDeviceLoginRequest,
  normalizeEmployeeCode,
  pollDeviceLoginRequest,
} from "@/modules/auth/device-login";

const USER = "11111111-1111-4111-8111-111111111111";
const STORE = "22222222-2222-4222-8222-222222222222";

describe("device login (QR + รหัสพนักงาน)", () => {
  beforeEach(() => {
    for (const k of Object.keys(tables)) delete tables[k];
    tables.employee_profiles = [{ user_id: USER, store_id: STORE, employee_code: "emp-014" }];
  });

  it("รหัสสั้นรูปแบบ XXX-XXX ไม่มีตัวที่สับสน (0/O/1/I/L)", () => {
    for (let i = 0; i < 50; i++) expect(generateShortCode()).toMatch(/^[A-HJKMNP-Z2-9]{3}-[A-HJKMNP-Z2-9]{3}$/);
    expect(normalizeEmployeeCode(" emp - 014 ")).toBe("EMP-014");
  });

  it("ไหลครบ: ขอ → อนุมัติด้วยรหัสพนักงาน → poll ได้ตั๋ว → แลกได้ครั้งเดียว", async () => {
    const req = await createDeviceLoginRequest({ deviceLabel: "StoreOS POS (Windows)" });
    // DB เก็บแค่ hash ของรหัสลับ
    expect(JSON.stringify(tables.device_login_requests)).not.toContain(req.secret);
    expect(await pollDeviceLoginRequest(req.requestId, req.secret)).toEqual({ status: "pending" });

    const approved = await approveDeviceLoginRequest({ requestId: req.requestId, shortCode: req.code, employeeCode: "EMP-014", userId: USER, storeId: STORE });
    expect(approved).toEqual({ ok: true, deviceLabel: "StoreOS POS (Windows)" });

    const polled = await pollDeviceLoginRequest(req.requestId, req.secret);
    expect(polled.status).toBe("approved");
    const ticket = (polled as { ticket: string }).ticket;

    expect(await consumeDeviceLoginTicket(req.requestId, ticket)).toEqual({ userId: USER, storeId: STORE, deviceLabel: "StoreOS POS (Windows)" });
    // ใช้ซ้ำไม่ได้
    expect(await consumeDeviceLoginTicket(req.requestId, ticket)).toBeNull();
    expect((await getDeviceLoginRequest(req.requestId))?.status).toBe("completed");
  });

  it("รหัสลับเครื่องผิด = poll ไม่ได้ (ถือ QR อย่างเดียวเข้าระบบไม่ได้)", async () => {
    const req = await createDeviceLoginRequest({});
    await approveDeviceLoginRequest({ requestId: req.requestId, shortCode: req.code, employeeCode: "EMP-014", userId: USER, storeId: STORE });
    expect(await pollDeviceLoginRequest(req.requestId, "x".repeat(43))).toEqual({ status: "invalid" });
  });

  it("รหัสพนักงานผิด 5 ครั้ง = ยกเลิกคำขอ", async () => {
    const req = await createDeviceLoginRequest({});
    for (let i = 1; i <= 4; i++) {
      const r = await approveDeviceLoginRequest({ requestId: req.requestId, shortCode: req.code, employeeCode: "WRONG", userId: USER, storeId: STORE });
      expect(r).toEqual({ ok: false, error: "รหัสพนักงานไม่ถูกต้อง", attemptsLeft: 5 - i });
    }
    const last = await approveDeviceLoginRequest({ requestId: req.requestId, shortCode: req.code, employeeCode: "WRONG", userId: USER, storeId: STORE });
    expect(last.ok).toBe(false);
    expect((await getDeviceLoginRequest(req.requestId))?.status).toBe("cancelled");
    // รหัสถูกหลังถูกยกเลิกก็ไม่ผ่าน
    const after = await approveDeviceLoginRequest({ requestId: req.requestId, shortCode: req.code, employeeCode: "EMP-014", userId: USER, storeId: STORE });
    expect(after.ok).toBe(false);
  });

  it("บัญชีไม่มีรหัสพนักงาน = อนุมัติไม่ได้ (ให้เจ้าของตั้งก่อน)", async () => {
    tables.employee_profiles = [];
    const req = await createDeviceLoginRequest({});
    const r = await approveDeviceLoginRequest({ requestId: req.requestId, shortCode: req.code, employeeCode: "EMP-014", userId: USER, storeId: STORE });
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toContain("ยังไม่มีรหัสพนักงาน");
  });

  it("รหัสบนจอไม่ตรง / หมดอายุ = อนุมัติไม่ได้", async () => {
    const req = await createDeviceLoginRequest({});
    expect((await approveDeviceLoginRequest({ requestId: req.requestId, shortCode: "AAA-AAA", employeeCode: "EMP-014", userId: USER, storeId: STORE })).ok).toBe(false);
    tables.device_login_requests[0].expires_at = new Date(Date.now() - 1000).toISOString();
    const expired = await approveDeviceLoginRequest({ requestId: req.requestId, shortCode: req.code, employeeCode: "EMP-014", userId: USER, storeId: STORE });
    expect((expired as { error: string }).error).toContain("หมดอายุ");
  });

  it("ตั๋วหมดอายุ (เกิน 2 นาที) แลกไม่ได้", async () => {
    const req = await createDeviceLoginRequest({});
    await approveDeviceLoginRequest({ requestId: req.requestId, shortCode: req.code, employeeCode: "EMP-014", userId: USER, storeId: STORE });
    const { ticket } = (await pollDeviceLoginRequest(req.requestId, req.secret)) as { ticket: string };
    tables.device_login_requests[0].ticket_expires_at = new Date(Date.now() - 1000).toISOString();
    expect(await consumeDeviceLoginTicket(req.requestId, ticket)).toBeNull();
  });

  it("middleware: หน้า QR + start/poll/complete public แต่หน้าอนุมัติบนมือถือต้องล็อกอิน", () => {
    const mw = readFileSync("src/server/integrations/supabase/middleware.ts", "utf8");
    expect(mw).toContain('request.nextUrl.pathname === "/device-login" ||');
    expect(mw).toContain('request.nextUrl.pathname === "/api/device-login/complete" ||');
    expect(mw).not.toContain('pathname.startsWith("/device-login")');
    const migration = readFileSync("supabase/migrations/20261210120000_device_login_requests.sql", "utf8");
    expect(migration).toContain("enable row level security");
    expect(migration).toContain("revoke all on public.device_login_requests from anon, authenticated");
  });
});
