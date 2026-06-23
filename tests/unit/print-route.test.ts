import { afterEach, describe, expect, it, vi } from "vitest";

const user = { id: "user-1" };
const ctx = {
  userId: "user-1",
  organizationId: "org-1",
  storeId: "store-1",
  storeName: "Main",
  orgName: "Demo",
  role: "cashier",
};

function mockRouteAuth(canUsePos: boolean) {
  vi.doMock("@/modules/auth/guards", () => ({
    getOptionalResolvedCurrentPermissions: vi.fn().mockResolvedValue({
      user,
      ctx,
      resolved: { can: (key: string) => (key === "pos.use" ? canUsePos : true) },
    }),
  }));
}

const receiptData = {
  storeName: "Test Cafe",
  orderNumber: "R-001",
  items: [{ name: "Coffee", quantity: 1, totalPrice: 45 }],
  subtotal: 45,
  discount: 0,
  total: 45,
  payments: [{ method: "cash", amount: 45 }],
  paperWidth: "58mm" as const,
  printedAt: new Date().toISOString(),
};

function scopedPrinter() {
  return {
    id: "printer-1",
    storeId: "store-1",
    organizationId: "org-1",
    name: "Kitchen",
    type: "ip",
    isDefault: true,
    ipAddress: "192.168.1.50",
    port: 9100,
    paperWidth: "58mm",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unmock("@/modules/auth/guards");
  vi.unmock("@/modules/auth/session");
  vi.unmock("@/modules/auth/permission-resolver");
  vi.unmock("@/modules/stores/repository");
  vi.unmock("@/server/integrations/supabase/server");
  vi.unmock("net");
});

describe("POST /api/print/ip", () => {
  it("denies printing when the resolved current permissions revoke pos.use", async () => {
    vi.resetModules();
    const getPrinter = vi.fn();

    mockRouteAuth(false);
    vi.doMock("@/modules/auth/session", () => ({
      getCurrentUser: vi.fn().mockResolvedValue(user),
      getUserStores: vi.fn().mockResolvedValue({
        organizations: [{ id: "org-1", name: "Demo" }],
        stores: [{ id: "store-1", organization_id: "org-1", name: "Main" }],
        memberships: [{ user_id: "user-1", organization_id: "org-1", store_id: "store-1", role: "cashier" }],
      }),
      resolveCurrentStore: vi.fn().mockResolvedValue(ctx),
    }));
    vi.doMock("@/modules/auth/permission-resolver", () => ({
      resolvePermissions: vi.fn(() => ({ can: () => true })),
    }));
    vi.doMock("@/modules/stores/repository", () => ({ getPrinter }));

    const { POST } = await import("@/app/api/print/ip/route");
    const response = await POST(new Request("http://local/api/print/ip", {
      method: "POST",
      body: JSON.stringify({ receiptData, printerId: "printer-1" }),
    }) as never);

    expect(response.status).toBe(403);
    expect(getPrinter).not.toHaveBeenCalled();
  });

  it("returns 404 when the scoped printer is missing", async () => {
    vi.resetModules();
    const getPrinter = vi.fn().mockResolvedValue({ data: null, error: null });

    mockRouteAuth(true);
    vi.doMock("@/modules/stores/repository", () => ({ getPrinter }));

    const { POST } = await import("@/app/api/print/ip/route");
    const response = await POST(new Request("http://local/api/print/ip", {
      method: "POST",
      body: JSON.stringify({ receiptData, printerId: "missing-printer" }),
    }) as never);

    expect(response.status).toBe(404);
    expect(getPrinter).toHaveBeenCalledWith("missing-printer", "store-1", "org-1");
  });

  it("sends prebuilt printJobBase64 bytes after scoped printer validation", async () => {
    vi.resetModules();
    const socketWrites: number[][] = [];
    class MockSocket {
      connect(_port: number, _host: string, cb: () => void) {
        cb();
      }
      write(data: Uint8Array, cb: (err?: Error) => void) {
        socketWrites.push(Array.from(data));
        cb();
      }
      end() {}
      destroy() {}
      on() {
        return this;
      }
    }
    const getPrinter = vi.fn().mockResolvedValue({ data: scopedPrinter(), error: null });

    mockRouteAuth(true);
    vi.doMock("net", () => ({
      default: { Socket: MockSocket, isIPv4: () => true, isIPv6: () => false },
      Socket: MockSocket,
      isIPv4: () => true,
      isIPv6: () => false,
    }));
    vi.doMock("@/modules/stores/repository", () => ({ getPrinter }));

    const printJob = Uint8Array.from([0x1b, 0x40, 0x1d, 0x56, 0x41]);
    const { POST } = await import("@/app/api/print/ip/route");
    const response = await POST(new Request("http://local/api/print/ip", {
      method: "POST",
      body: JSON.stringify({
        receiptData,
        printerId: "printer-1",
        printJobBase64: Buffer.from(printJob).toString("base64"),
      }),
    }) as never);

    expect(response.status).toBe(200);
    expect(getPrinter).toHaveBeenCalledWith("printer-1", "store-1", "org-1");
    expect(socketWrites).toEqual([Array.from(printJob)]);
  });

  it("rejects PromptPay QR receipts without prebuilt raster bytes", async () => {
    vi.resetModules();
    const socketWrites: number[][] = [];
    class MockSocket {
      connect(_port: number, _host: string, cb: () => void) {
        cb();
      }
      write(data: Uint8Array, cb: (err?: Error) => void) {
        socketWrites.push(Array.from(data));
        cb();
      }
      end() {}
      destroy() {}
      on() {
        return this;
      }
    }
    const getPrinter = vi.fn().mockResolvedValue({ data: scopedPrinter(), error: null });

    mockRouteAuth(true);
    vi.doMock("net", () => ({
      default: { Socket: MockSocket, isIPv4: () => true, isIPv6: () => false },
      Socket: MockSocket,
      isIPv4: () => true,
      isIPv6: () => false,
    }));
    vi.doMock("@/modules/stores/repository", () => ({ getPrinter }));

    const { POST } = await import("@/app/api/print/ip/route");
    const response = await POST(new Request("http://local/api/print/ip", {
      method: "POST",
      body: JSON.stringify({
        receiptData: {
          ...receiptData,
          payments: [{ method: "qr_promptpay", amount: 45 }],
          paymentStatus: "unpaid",
          showQrPayment: true,
          promptpayId: "0812345678",
        },
        printerId: "printer-1",
      }),
    }) as never);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain("QR PromptPay");
    expect(socketWrites).toEqual([]);
  });

  it("rejects invalid printJobBase64 before socket writes", async () => {
    vi.resetModules();
    const getPrinter = vi.fn().mockResolvedValue({ data: scopedPrinter(), error: null });

    mockRouteAuth(true);
    vi.doMock("@/modules/stores/repository", () => ({ getPrinter }));

    const { POST } = await import("@/app/api/print/ip/route");
    const response = await POST(new Request("http://local/api/print/ip", {
      method: "POST",
      body: JSON.stringify({ receiptData, printerId: "printer-1", printJobBase64: "not-valid-base64***" }),
    }) as never);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("Invalid print job");
  });

  it("rejects oversized printJobBase64 before socket writes", async () => {
    vi.resetModules();
    const getPrinter = vi.fn().mockResolvedValue({ data: scopedPrinter(), error: null });
    const oversized = Buffer.alloc((256 * 1024) + 1).toString("base64");

    mockRouteAuth(true);
    vi.doMock("@/modules/stores/repository", () => ({ getPrinter }));

    const { POST } = await import("@/app/api/print/ip/route");
    const response = await POST(new Request("http://local/api/print/ip", {
      method: "POST",
      body: JSON.stringify({ receiptData, printerId: "printer-1", printJobBase64: oversized }),
    }) as never);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("Receipt too large");
  });
});

describe("auth and printer repositories", () => {
  it("fails closed when permission override lookup fails", async () => {
    vi.resetModules();
    vi.doUnmock("@/modules/auth/guards");
    const overrideQuery = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({
        data: null,
        error: { message: "override query failed" },
      }),
    };

    vi.doMock("@/server/integrations/supabase/server", () => ({
      createSupabaseServerClient: vi.fn().mockResolvedValue({
        from: vi.fn(() => overrideQuery),
        auth: { getUser: vi.fn().mockResolvedValue({ data: { user } }) },
      }),
    }));
    vi.doMock("@/modules/auth/session", () => ({
      getCurrentUser: vi.fn().mockResolvedValue(user),
      getUserStores: vi.fn().mockResolvedValue({
        organizations: [{ id: "org-1", name: "Demo" }],
        stores: [{ id: "store-1", organization_id: "org-1", name: "Main" }],
        memberships: [{
          id: "membership-1",
          user_id: "user-1",
          organization_id: "org-1",
          store_id: "store-1",
          role: "cashier",
        }],
      }),
      pickMembershipForStore: vi.fn().mockReturnValue({ id: "membership-1" }),
      resolveCurrentStore: vi.fn().mockResolvedValue(ctx),
    }));

    const { AuthorizationError, getOptionalResolvedCurrentPermissions } = await import("@/modules/auth/guards");

    await expect(getOptionalResolvedCurrentPermissions()).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("returns a null printer without an error when the scoped printer row is not found", async () => {
    vi.resetModules();
    vi.doUnmock("@/modules/stores/repository");
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    };

    vi.doMock("@/server/integrations/supabase/server", () => ({
      createSupabaseServerClient: vi.fn().mockResolvedValue({
        from: vi.fn(() => query),
      }),
    }));

    const { getPrinter } = await import("@/modules/stores/repository");
    const result = await getPrinter("missing-printer", "store-1", "org-1");

    expect(result).toEqual({ data: null, error: null });
    expect(query.eq).toHaveBeenCalledWith("id", "missing-printer");
    expect(query.eq).toHaveBeenCalledWith("store_id", "store-1");
    expect(query.eq).toHaveBeenCalledWith("organization_id", "org-1");
  });
});
