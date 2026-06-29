import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/modules/auth/guards", () => {
  class AuthorizationError extends Error {}
  return {
    AuthorizationError,
    requirePermission: vi.fn(),
    requireSystemAccess: vi.fn(),
  };
});

vi.mock("@/modules/auth/session", () => ({
  getCurrentUser: vi.fn().mockResolvedValue({ id: "u1" }),
  getUserStores: vi.fn().mockResolvedValue({ organizations: [], stores: [], memberships: [] }),
  resolveCurrentStore: vi.fn().mockResolvedValue({ storeId: "s1", organizationId: "o1", role: "manager" }),
}));

vi.mock("@/modules/music-requests/repository", () => ({
  decideMusicRequest: vi.fn().mockResolvedValue({ ok: true, error: null }),
  listStoreMusicQueue: vi.fn().mockResolvedValue({ data: [], error: null }),
}));

vi.mock("@/modules/music-requests/license-repository", () => ({
  updateMusicLicense: vi.fn().mockResolvedValue({ ok: true, error: null }),
}));

import { requirePermission, requireSystemAccess, AuthorizationError } from "@/modules/auth/guards";
import { decideMusicRequest } from "@/modules/music-requests/repository";
import { updateMusicLicense } from "@/modules/music-requests/license-repository";
import { decideMusicRequestAction } from "@/app/(dashboard)/music-requests/actions";
import { updateMusicLicenseAction } from "@/app/system/music-licenses/actions";

const REQ = "11111111-1111-1111-1111-111111111111";
const STORE = "22222222-2222-2222-2222-222222222222";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requirePermission).mockResolvedValue(undefined as never);
  vi.mocked(requireSystemAccess).mockResolvedValue(undefined as never);
});

describe("decideMusicRequestAction — staff permission", () => {
  it("blocks callers without orders.manage_qr", async () => {
    vi.mocked(requirePermission).mockRejectedValueOnce(new AuthorizationError("denied"));
    const res = await decideMusicRequestAction(REQ, "approve");
    expect(res.error).not.toBeNull();
    expect(decideMusicRequest).not.toHaveBeenCalled();
  });

  it("rejects an unknown decision", async () => {
    const res = await decideMusicRequestAction(REQ, "explode" as never);
    expect(res.error).toBe("การกระทำไม่ถูกต้อง");
    expect(decideMusicRequest).not.toHaveBeenCalled();
  });

  it("rejects a malformed request id", async () => {
    const res = await decideMusicRequestAction("not-a-uuid", "approve");
    expect(res.error).toBe("คำขอไม่ถูกต้อง");
    expect(decideMusicRequest).not.toHaveBeenCalled();
  });

  it("applies a valid decision", async () => {
    const res = await decideMusicRequestAction(REQ, "approve");
    expect(res.error).toBeNull();
    expect(decideMusicRequest).toHaveBeenCalledWith(REQ, "approve");
  });
});

describe("updateMusicLicenseAction — system admin only", () => {
  function form(fields: Record<string, string>) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    return fd;
  }

  it("does nothing for non-system callers", async () => {
    vi.mocked(requireSystemAccess).mockRejectedValueOnce(new AuthorizationError("denied"));
    await updateMusicLicenseAction(form({ storeId: STORE, status: "approved" }));
    expect(updateMusicLicense).not.toHaveBeenCalled();
  });

  it("ignores an invalid status", async () => {
    await updateMusicLicenseAction(form({ storeId: STORE, status: "bogus" }));
    expect(updateMusicLicense).not.toHaveBeenCalled();
  });

  it("approves with note when system admin", async () => {
    await updateMusicLicenseAction(form({ storeId: STORE, status: "approved", note: "ok" }));
    expect(updateMusicLicense).toHaveBeenCalledWith(STORE, "approved", "ok");
  });
});
