import { vi, describe, it, expect, beforeEach } from "vitest";
import type { BillingState } from "@/modules/billing/types";

vi.mock("@/modules/billing/billing-service", () => ({
  getOrganizationBillingState: vi.fn(),
}));
vi.mock("@/server/integrations/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(),
  createSupabaseServerClient: vi.fn(),
}));
vi.mock("@/modules/notifications/dispatcher", () => ({
  notifyOwnerSafely: vi.fn(),
}));

import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { listMusicQueueAction, submitMusicRequestAction } from "@/app/qr/[storeSlug]/[tableId]/music-actions";

const STORE = "11111111-1111-1111-1111-111111111111";
const TABLE = "22222222-2222-2222-2222-222222222222";
const SESSION = "33333333-3333-3333-3333-333333333333";

function billing(plan: BillingState["plan"]): BillingState {
  return { plan, status: "active", currentPeriodEnd: "2030-01-01T00:00:00Z", cancelAtPeriodEnd: false, trialEnd: null };
}

interface FakeRows {
  store: Record<string, unknown> | null;
  table: Record<string, unknown> | null;
  rpcResult?: { data: unknown; error: unknown };
}

function fakeClient({ store, table, rpcResult }: FakeRows) {
  const rpc = vi.fn().mockResolvedValue(rpcResult ?? { data: "new-req", error: null });
  return {
    rpc,
    from(tbl: string) {
      const row = tbl === "stores" ? store : tbl === "tables" ? table : null;
      const builder: Record<string, (...args: unknown[]) => unknown> = {
        select: () => builder,
        eq: () => builder,
        in: () => builder,
        gte: () => builder,
        order: () => builder,
        limit: () => Promise.resolve({ data: [], error: null }),
        single: () => Promise.resolve({ data: row, error: row ? null : { message: "not found" } }),
        maybeSingle: () => Promise.resolve({ data: row, error: null }),
      };
      return builder;
    },
  };
}

function storeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: STORE,
    organization_id: "org-1",
    is_active: true,
    qr_ordering_enabled: true,
    qr_ordering_mode: "table_bound",
    music_request_enabled: true,
    music_license_status: "approved",
    ...overrides,
  };
}

function tableRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TABLE,
    store_id: STORE,
    is_active: true,
    qr_enabled: true,
    current_session_id: null,
    session_expires_at: null,
    ...overrides,
  };
}

function setup(rows: FakeRows, plan: BillingState["plan"]) {
  const client = fakeClient(rows);
  vi.mocked(createSupabaseServiceClient).mockResolvedValue(client as never);
  vi.mocked(getOrganizationBillingState).mockResolvedValue(billing(plan));
  return client;
}

beforeEach(() => vi.clearAllMocks());

describe("submitMusicRequestAction — enforcement", () => {
  it("blocks non-Enterprise stores", async () => {
    const client = setup({ store: storeRow(), table: tableRow() }, "premium");
    const res = await submitMusicRequestAction(STORE, TABLE, null, { songTitle: "เพลงรัก" });
    expect(res.error).toContain("Enterprise");
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("blocks Enterprise stores whose license is not approved", async () => {
    const client = setup(
      { store: storeRow({ music_license_status: "pending" }), table: tableRow() },
      "enterprise",
    );
    const res = await submitMusicRequestAction(STORE, TABLE, null, { songTitle: "เพลงรัก" });
    expect(res.error).not.toBeNull();
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("blocks a session_printed QR after the session is cleared (expired)", async () => {
    const client = setup(
      {
        store: storeRow({ qr_ordering_mode: "session_printed" }),
        table: tableRow({ current_session_id: null, session_expires_at: null }),
      },
      "enterprise",
    );
    const res = await submitMusicRequestAction(STORE, TABLE, SESSION, { songTitle: "เพลงรัก" });
    expect(res.error).toContain("หมดอายุ");
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("rejects invalid input before touching the database", async () => {
    const client = setup({ store: storeRow(), table: tableRow() }, "enterprise");
    const res = await submitMusicRequestAction(STORE, TABLE, null, { songTitle: "   " });
    expect(res.error).not.toBeNull();
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("submits when Enterprise + approved + table_bound", async () => {
    const client = setup({ store: storeRow(), table: tableRow() }, "enterprise");
    const res = await submitMusicRequestAction(STORE, TABLE, null, { songTitle: "เพลงรัก", artistName: "ศิลปิน" });
    expect(res.error).toBeNull();
    expect(client.rpc).toHaveBeenCalledWith(
      "create_music_request",
      expect.objectContaining({ p_song_title: "เพลงรัก", p_store_id: STORE }),
    );
  });
});

describe("listMusicQueueAction — enforcement", () => {
  it("reports expired for a stale session_printed QR", async () => {
    setup(
      {
        store: storeRow({ qr_ordering_mode: "session_printed" }),
        table: tableRow({ current_session_id: null }),
      },
      "enterprise",
    );
    const res = await listMusicQueueAction(STORE, TABLE, SESSION);
    expect(res.expired).toBe(true);
    expect(res.queue).toEqual([]);
  });

  it("blocks the queue for non-Enterprise stores", async () => {
    const res = await (async () => {
      setup({ store: storeRow(), table: tableRow() }, "standard");
      return listMusicQueueAction(STORE, TABLE, null);
    })();
    expect(res.queue).toEqual([]);
    expect(res.error).toContain("Enterprise");
  });
});
