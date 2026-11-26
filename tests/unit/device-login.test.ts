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
  let countOnly = false;
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
    select: (_cols?: string, opts?: { count?: string; head?: boolean }) => ((countOnly = Boolean(opts?.head)), api),
    insert: (row: Row) => ((op = "insert"), (inserted = row), api),
    update: (p: Row) => ((op = "update"), (patch = p), api),
    delete: () => ((op = "delete"), api),
    eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), api),
    gt: (k: string, v: string) => (filters.push((r) => String(r[k]) > v), api),
    lt: (k: string, v: string) => (filters.push((r) => String(r[k]) < v), api),
    not: (k: string) => (filters.push((r) => r[k] != null), api),
    // รองรับรูปแบบเดียวที่ใช้: "ticket_hash.is.null,ticket_expires_at.lt.<iso>"
    or: (expr: string) => {
      const [a, b] = expr.split(",");
      const isNullKey = a.split(".")[0];
      const [ltKey, , ...rest] = b.split(".");
      const ltValue = rest.join(".");
      filters.push((r) => r[isNullKey] == null || String(r[ltKey]) < ltValue);
      return api;
    },
    maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
    single: async () => ({ data: run()[0] ?? null, error: null }),
    then: (resolve: (v: { data: Row[]; count: number; error: null }) => unknown) => {
      const data = run();
      return resolve({ data: countOnly ? [] : data, count: data.length, error: null });
    },
  };
  return api;
}

const auth = {
  getUserById: vi.fn(async () => ({ data: { user: { email: "miw@example.com" } }, error: null })),
  generateLink: vi.fn(async () => ({ data: { properties: { hashed_token: "hash-123" } }, error: null })),
  verifyOtp: vi.fn(async () => ({ error: null as null | { message: string } })),
  signOut: vi.fn(async () => ({ error: null })),
};
const cookieSet = vi.fn();

vi.mock("@/server/integrations/supabase/server", () => ({
  createSupabaseServiceClient: async () => ({
    from: (t: string) => builder(t),
    auth: { admin: { getUserById: auth.getUserById, generateLink: auth.generateLink } },
  }),
  createSupabaseServerClient: async () => ({ auth: { verifyOtp: auth.verifyOtp, signOut: auth.signOut } }),
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: cookieSet }) }));
vi.mock("@/modules/system/event-log", () => ({ logSystemEvent: vi.fn(async () => undefined) }));

import {
  DEVICE_LOGIN_MAX_PER_IP,
  DeviceLoginRateLimitError,
  approveDeviceLoginRequest,
  createDeviceLoginRequest,
  generateShortCode,
  getDeviceLoginRequest,
  maskEmail,
  normalizeEmployeeCode,
  pollDeviceLoginRequest,
  verifyDeviceLoginTicket,
} from "@/modules/auth/device-login";
import { POST as completePost } from "@/app/api/device-login/complete/route";

const USER = "11111111-1111-4111-8111-111111111111";
const STORE = "22222222-2222-4222-8222-222222222222";

async function approvedTicket() {
  const req = await createDeviceLoginRequest({ deviceLabel: "StoreOS POS (Windows)", ipHash: "a".repeat(64) });
  await approveDeviceLoginRequest({ requestId: req.requestId, shortCode: req.code, employeeCode: "EMP-014", userId: USER, storeId: STORE });
  const polled = (await pollDeviceLoginRequest(req.requestId, req.secret)) as { status: string; ticket: string };
  return { req, ticket: polled.ticket };
}

function completeRequest(requestId: string, ticket: string) {
  const body = new FormData();
  body.set("requestId", requestId);
  body.set("ticket", ticket);
  return new Request("https://www.store-os.online/api/device-login/complete", { method: "POST", body });
}

describe("device login (QR + รหัสพนักงาน)", () => {
  beforeEach(() => {
    for (const k of Object.keys(tables)) delete tables[k];
    tables.employee_profiles = [{ user_id: USER, store_id: STORE, employee_code: "emp-014" }];
    vi.clearAllMocks();
  });

  it("รหัสสั้นรูปแบบ XXX-XXX ไม่มีตัวที่สับสน + ปิดบังอีเมล", () => {
    for (let i = 0; i < 50; i++) expect(generateShortCode()).toMatch(/^[A-HJKMNP-Z2-9]{3}-[A-HJKMNP-Z2-9]{3}$/);
    expect(normalizeEmployeeCode(" emp - 014 ")).toBe("EMP-014");
    expect(maskEmail("somchai@gmail.com")).toBe("so*****@gmail.com");
  });

  it("ไหลครบ: ขอ → อนุมัติ → poll ได้ตั๋ว → complete สร้าง session + ตั้งสาขา → ตั๋วใช้ซ้ำไม่ได้", async () => {
    const { req, ticket } = await approvedTicket();
    expect(JSON.stringify(tables.device_login_requests)).not.toContain(req.secret); // เก็บแค่ hash
    expect(ticket).toBeTruthy();

    const res = await completePost(completeRequest(req.requestId, ticket));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://www.store-os.online/pos");
    expect(auth.generateLink).toHaveBeenCalledWith({ type: "magiclink", email: "miw@example.com" });
    expect(auth.verifyOtp).toHaveBeenCalledWith({ type: "magiclink", token_hash: "hash-123" });
    expect(cookieSet).toHaveBeenCalledWith("selected_store_id", STORE, expect.objectContaining({ httpOnly: true }));
    expect((await getDeviceLoginRequest(req.requestId))?.status).toBe("completed");

    const again = await completePost(completeRequest(req.requestId, ticket));
    expect(again.headers.get("location")).toContain("/device-login?error=expired");
  });

  it("auth สะดุดตอนสร้าง session → ตั๋วยังใช้ได้ (ไม่ต้องให้พนักงานอนุมัติซ้ำ)", async () => {
    const { req, ticket } = await approvedTicket();
    auth.verifyOtp.mockResolvedValueOnce({ error: { message: "temporarily unavailable" } });
    const failed = await completePost(completeRequest(req.requestId, ticket));
    expect(failed.headers.get("location")).toContain("error=failed");
    expect(await verifyDeviceLoginTicket(req.requestId, ticket)).not.toBeNull();
    const retry = await completePost(completeRequest(req.requestId, ticket));
    expect(retry.headers.get("location")).toBe("https://www.store-os.online/pos");
  });

  it("poll ซ้อนกันไม่ออกตั๋วทับ — ตั๋วใบแรกยังใช้ได้", async () => {
    const { req, ticket } = await approvedTicket();
    expect(await pollDeviceLoginRequest(req.requestId, req.secret)).toEqual({ status: "pending" });
    expect(await verifyDeviceLoginTicket(req.requestId, ticket)).not.toBeNull();
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
    expect((await approveDeviceLoginRequest({ requestId: req.requestId, shortCode: req.code, employeeCode: "WRONG", userId: USER, storeId: STORE })).ok).toBe(false);
    expect((await getDeviceLoginRequest(req.requestId))?.status).toBe("cancelled");
    expect((await approveDeviceLoginRequest({ requestId: req.requestId, shortCode: req.code, employeeCode: "EMP-014", userId: USER, storeId: STORE })).ok).toBe(false);
  });

  it("บัญชีไม่มีรหัสพนักงาน / รหัสบนจอไม่ตรง / หมดอายุ = อนุมัติไม่ได้", async () => {
    const req = await createDeviceLoginRequest({});
    expect((await approveDeviceLoginRequest({ requestId: req.requestId, shortCode: "AAA-AAA", employeeCode: "EMP-014", userId: USER, storeId: STORE })).ok).toBe(false);
    tables.employee_profiles = [];
    const noCode = await approveDeviceLoginRequest({ requestId: req.requestId, shortCode: req.code, employeeCode: "EMP-014", userId: USER, storeId: STORE });
    expect((noCode as { error: string }).error).toContain("ยังไม่มีรหัสพนักงาน");
    tables.employee_profiles = [{ user_id: USER, store_id: STORE, employee_code: "emp-014" }];
    tables.device_login_requests[0].expires_at = new Date(Date.now() - 1000).toISOString();
    const expired = await approveDeviceLoginRequest({ requestId: req.requestId, shortCode: req.code, employeeCode: "EMP-014", userId: USER, storeId: STORE });
    expect((expired as { error: string }).error).toContain("หมดอายุ");
  });

  it("ตั๋วหมดอายุ (เกิน 2 นาที) แลกไม่ได้", async () => {
    const { req, ticket } = await approvedTicket();
    tables.device_login_requests[0].ticket_expires_at = new Date(Date.now() - 1000).toISOString();
    expect(await verifyDeviceLoginTicket(req.requestId, ticket)).toBeNull();
  });

  it("จำกัดคำขอต่อ IP + หน้าอนุมัติบอกว่าเครือข่ายเดียวกันไหม", async () => {
    const ip = "b".repeat(64);
    let created = { requestId: "" };
    for (let i = 0; i < DEVICE_LOGIN_MAX_PER_IP; i++) created = await createDeviceLoginRequest({ ipHash: ip });
    await expect(createDeviceLoginRequest({ ipHash: ip })).rejects.toBeInstanceOf(DeviceLoginRateLimitError);
    expect((await getDeviceLoginRequest(created.requestId, ip))?.sameNetwork).toBe(true);
    expect((await getDeviceLoginRequest(created.requestId, "c".repeat(64)))?.sameNetwork).toBe(false);
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
