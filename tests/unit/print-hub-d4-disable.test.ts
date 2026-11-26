import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---- ฐานข้อมูลปลอม: เฉพาะ stores / print_hub_device_tokens ที่ authenticateHubRequest ใช้ ----
type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {};
function builder(table: string) {
  const filters: ((r: Row) => boolean)[] = [];
  const run = () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
  const api = {
    select: () => api,
    update: () => api,
    eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), api),
    is: (k: string, v: unknown) => (filters.push((r) => (r[k] ?? null) === v), api),
    single: async () => {
      const row = run()[0];
      return row ? { data: row, error: null } : { data: null, error: { message: "not found" } };
    },
    then: (resolve: (v: { data: Row[]; error: null }) => unknown) => resolve({ data: run(), error: null }),
  };
  return api;
}
vi.mock("@/server/integrations/supabase/server", () => ({
  createSupabaseServiceClient: async () => ({ from: (t: string) => builder(t) }),
}));

const { authenticateHubRequest } = await import("@/modules/printing/print-hub-repository");
const { hashHubToken } = await import("@/modules/printing/print-hub");
const { HUB_POLL_DISABLED_MS } = await import("@/modules/printing/hub-poll-pacing");

const STORE = "store-1";
const TOKEN = "hub-token-abcdefghijklmnopqrstuvwxyz";

describe("D4 ปิด Print Hub — auth บอกโหมดพิมพ์ของร้าน", () => {
  beforeEach(() => {
    for (const key of Object.keys(tables)) delete tables[key];
    tables.print_hub_device_tokens = [];
  });

  it("ร้านโหมดพิมพ์ตรง: token ยังผ่าน แต่ได้ printMode=direct (route จะตอบว่างแล้วให้พัก)", async () => {
    tables.stores = [{ id: STORE, organization_id: "org-1", print_hub_token_hash: hashHubToken(TOKEN), print_mode: "direct" }];
    await expect(authenticateHubRequest(STORE, TOKEN)).resolves.toEqual({ ok: true, organizationId: "org-1", printMode: "direct" });
  });

  it("ร้านโหมดเดิม / ค่าแปลก: printMode=hub (พฤติกรรมเดิม)", async () => {
    tables.stores = [{ id: STORE, organization_id: "org-1", print_hub_token_hash: hashHubToken(TOKEN), print_mode: "weird" }];
    await expect(authenticateHubRequest(STORE, TOKEN)).resolves.toMatchObject({ ok: true, printMode: "hub" });
  });

  it("token ผิดยังเป็น 401 ตามเดิม", async () => {
    tables.stores = [{ id: STORE, organization_id: "org-1", print_hub_token_hash: hashHubToken(TOKEN), print_mode: "direct" }];
    await expect(authenticateHubRequest(STORE, "wrong-token")).resolves.toMatchObject({ ok: false });
  });

  it("จังหวะพัก = เพดานที่ agent ยอมยืด (60 วิ) ไม่ใช่ revoke ที่ทำให้ถอยแค่ 8 วิ", () => {
    const agent = readFileSync("scripts/print-hub.mjs", "utf8");
    const max = Number(agent.match(/MAX_SERVER_POLL_INTERVAL_MS = ([\d_]+)/)?.[1].replace(/_/g, ""));
    expect(HUB_POLL_DISABLED_MS).toBe(max);
  });
});

describe("D4 ปิด Print Hub — route", () => {
  const poll = readFileSync("src/app/api/print/hub/poll/route.ts", "utf8");
  const provision = readFileSync("src/app/api/print/hub/provision/route.ts", "utf8");

  it("poll: โหมดพิมพ์ตรงตอบว่างก่อน heartbeat/เคลม/long-poll", () => {
    const direct = poll.indexOf('auth.printMode === "direct"');
    expect(direct).toBeGreaterThan(0);
    expect(direct).toBeLessThan(poll.indexOf("await touchHubHeartbeat(storeId)"));
    expect(direct).toBeLessThan(poll.indexOf("claimPendingPrintJobs(storeId"));
    expect(poll).toContain("nextPollMs: HUB_POLL_DISABLED_MS");
    expect(poll).toContain("jobs: []");
    expect(poll).toContain('action: "hubPolledWhileDirect"');
  });

  it("provision: โหมดพิมพ์ตรงไม่ออก token ใหม่ (409) และ log", () => {
    const refuse = provision.indexOf('fail("hub_disabled_direct_mode", 409)');
    expect(refuse).toBeGreaterThan(0);
    expect(refuse).toBeLessThan(provision.indexOf("provisionHubDeviceToken({"));
    expect(provision).toContain('action: "provisionRefusedDirectMode"');
  });
});
