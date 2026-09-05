import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ctx = { organizationId: "org-1", storeId: "store-1" };
const user = { id: "user-1" };

async function loadRoute(options: { authed?: boolean; canManage?: boolean; provision?: unknown } = {}) {
  const {
    authed = true,
    canManage = true,
    provision = { data: { rotated: true, token: "tok-new" }, error: null },
  } = options;

  vi.resetModules();
  const provisionHubDeviceToken = vi.fn().mockResolvedValue(provision);
  const logSystemEvent = vi.fn().mockResolvedValue(undefined);

  vi.doMock("@/modules/auth/guards", () => ({
    getResolvedCurrentPermissions: vi
      .fn()
      .mockResolvedValue(authed ? { ctx, user, resolved: { can: () => canManage } } : null),
  }));
  vi.doMock("@/modules/printing/print-hub-repository", () => ({
    MAX_HUB_DEVICE_ID_LENGTH: 128,
    provisionHubDeviceToken,
  }));
  vi.doMock("@/modules/system/event-log", () => ({ logSystemEvent }));

  const route = await import("@/app/api/print/hub/provision/route");
  return { route, provisionHubDeviceToken, logSystemEvent };
}

const post = (body: unknown) =>
  new Request("https://www.store-os.online/api/print/hub/provision", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const validBody = { deviceId: "a".repeat(64), deviceLabel: "CASHIER-PC", currentToken: "tok-old" };

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("POST /api/print/hub/provision — ด่านความปลอดภัย", () => {
  it("ไม่ได้ล็อกอิน = 401 และไม่แตะ token เลย", async () => {
    const { route, provisionHubDeviceToken } = await loadRoute({ authed: false });
    expect((await route.POST(post(validBody))).status).toBe(401);
    expect(provisionHubDeviceToken).not.toHaveBeenCalled();
  });

  it("ไม่มีสิทธิ์จัดการเครื่องพิมพ์ = 403", async () => {
    const { route, provisionHubDeviceToken } = await loadRoute({ canManage: false });
    expect((await route.POST(post(validBody))).status).toBe(403);
    expect(provisionHubDeviceToken).not.toHaveBeenCalled();
  });

  it("ออก token ให้เฉพาะร้านที่ผู้ใช้กำลังใช้อยู่ (client เลือกร้านเองไม่ได้)", async () => {
    const { route, provisionHubDeviceToken } = await loadRoute();
    await route.POST(post({ ...validBody, storeId: "store-อื่น" }));
    // storeId เป็นคีย์เกิน → schema .strict() ต้องปฏิเสธทั้งคำขอ
    expect(provisionHubDeviceToken).not.toHaveBeenCalled();

    const clean = await loadRoute();
    await clean.route.POST(post(validBody));
    expect(clean.provisionHubDeviceToken).toHaveBeenCalledWith(
      expect.objectContaining({ storeId: "store-1", organizationId: "org-1" }),
    );
  });

  it("body ผิดรูปถูกปฏิเสธ", async () => {
    const { route } = await loadRoute();
    for (const bad of ["not json", { deviceId: "sh" }, { ...validBody, deviceId: "a".repeat(129) }, {}]) {
      expect((await route.POST(post(bad))).status, JSON.stringify(bad).slice(0, 40)).toBe(400);
    }
  });
});

describe("POST /api/print/hub/provision — พฤติกรรม", () => {
  it("token เดิมยังใช้ได้ = ไม่ออกใบใหม่ และไม่ส่ง config กลับ", async () => {
    const { route } = await loadRoute({ provision: { data: { rotated: false, token: null }, error: null } });
    const res = await route.POST(post(validBody));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ ok: true, rotated: false, config: null });
  });

  it("ออกใบใหม่ = คืน config ที่เอาไปเขียนไฟล์ได้ทันที", async () => {
    const { route } = await loadRoute();
    const res = await route.POST(post(validBody));
    const json = await res.json();

    expect(json.ok).toBe(true);
    expect(json.rotated).toBe(true);
    expect(json.config).toMatchObject({
      serverUrl: "https://www.store-os.online",
      storeId: "store-1",
      hubToken: "tok-new",
      pollIntervalMs: 2500,
    });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("ไม่มี token อยู่ใน log", async () => {
    const { route, logSystemEvent } = await loadRoute();
    await route.POST(post(validBody));
    expect(JSON.stringify(logSystemEvent.mock.calls)).not.toContain("tok-new");
    expect(JSON.stringify(logSystemEvent.mock.calls)).not.toContain("tok-old");
  });

  it("repository ล้มเหลว = 500 ไม่ใช่ส่ง token เปล่า ๆ กลับ", async () => {
    const { route } = await loadRoute({ provision: { data: null, error: { userMessage: "พัง" } } });
    expect((await route.POST(post(validBody))).status).toBe(500);
  });
});

describe("token รายเครื่อง — สัญญาที่ต้องไม่พัง", () => {
  const root = process.cwd();
  const read = (p: string) => readFileSync(join(root, p), "utf8");

  it("migration สร้างตารางแบบ token ต่อเครื่อง และให้มีใบที่ใช้งานได้ใบเดียวต่อเครื่อง", () => {
    const sql = read("supabase/migrations/20260905000008_print_hub_device_tokens.sql");
    expect(sql).toContain("create table if not exists public.print_hub_device_tokens");
    expect(sql).toContain("device_id text not null");
    expect(sql).toContain("revoked_at");
    expect(sql).toMatch(/unique index[\s\S]*\(store_id, device_id\)[\s\S]*where revoked_at is null/);
    // ห้ามเปิดให้อ่าน hash ผ่าน PostgREST
    expect(sql).toContain("revoke all privileges on table public.print_hub_device_tokens from anon, authenticated");
  });

  it("provision ยกเลิกเฉพาะใบของเครื่องตัวเอง (ไม่เตะเครื่องอื่น)", () => {
    const repo = read("src/modules/printing/print-hub-repository.ts");
    const fn = repo.slice(repo.indexOf("export async function provisionHubDeviceToken"));
    expect(fn).toContain('.eq("store_id", input.storeId)');
    expect(fn).toContain('.eq("device_id", deviceId)');
    // ต้องเช็คของเดิมก่อนเสมอ ไม่งั้นเปิดโปรแกรมทีก็ rotate ที
    expect(fn.indexOf("authenticateHubRequest")).toBeLessThan(fn.indexOf("generateHubToken()"));
  });

  it("ตัวตรวจ token รับได้ทั้งแบบเดิมและแบบรายเครื่อง", () => {
    const repo = read("src/modules/printing/print-hub-repository.ts");
    const fn = repo.slice(
      repo.indexOf("export async function authenticateHubRequest"),
      repo.indexOf("export async function provisionHubDeviceToken"),
    );
    expect(fn).toContain("print_hub_token_hash");
    expect(fn).toContain("print_hub_device_tokens");
  });

  it("ทุก route ของ Hub ใช้ตัวตรวจตัวเดียวกัน", () => {
    for (const path of [
      "src/app/api/print/hub/poll/route.ts",
      "src/app/api/print/hub/ack/route.ts",
      "src/app/api/launcher/logs/route.ts",
    ]) {
      const source = read(path);
      expect(source, path).toContain("authenticateHubRequest");
      expect(source, path).not.toContain("getStoreHubAuth");
    }
  });
});
