import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  authz: null as null | { user: { id: string }; ctx: { organizationId: string; storeId: string } },
  logged: [] as Array<Record<string, unknown>>,
}));
vi.mock("@/modules/auth/guards", () => ({ getOptionalResolvedCurrentPermissions: async () => state.authz }));
vi.mock("@/modules/system/event-log", () => ({
  logSystemEvent: async (row: Record<string, unknown>) => {
    state.logged.push(row);
  },
}));
import { POST } from "@/app/api/app/device-log/route";

const post = (body: unknown, ua = "Mozilla/5.0 StoreOSApp/1.0.4 Android native") =>
  POST(new Request("https://x/api/app/device-log", { method: "POST", body: JSON.stringify(body), headers: { "user-agent": ua } }));

beforeEach(() => {
  state.authz = { user: { id: "u" }, ctx: { organizationId: "org", storeId: "store" } };
  state.logged = [];
});

describe("POST /api/app/device-log", () => {
  it("logs allow-listed native events with sanitized detail and the app version", async () => {
    const res = await post({
      event: "push_received",
      detail: { type: "new_qr_order", notificationsEnabled: true, sdk: 34, nested: { a: 1 }, "bad key": "x" },
    });
    expect(res.status).toBe(200);
    expect(state.logged).toHaveLength(1);
    expect(state.logged[0]).toMatchObject({ source: "mobile.android", action: "push_received", storeId: "store", actorUserId: "u" });
    expect(state.logged[0].context).toEqual({ type: "new_qr_order", notificationsEnabled: true, sdk: 34, appVersion: "1.0.4" });
  });

  it("rejects unknown events, bad JSON and anonymous callers", async () => {
    expect((await post({ event: "drop_table" })).status).toBe(400);
    expect(
      (await POST(new Request("https://x/api/app/device-log", { method: "POST", body: "{" }))).status,
    ).toBe(400);
    state.authz = null;
    expect((await post({ event: "app_open" })).status).toBe(401);
    expect(state.logged).toHaveLength(0);
  });
});
