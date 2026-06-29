import { describe, it, expect } from "vitest";
import { resolveQrMusicEligibility } from "@/modules/music-requests/gates";
import type { QrMusicEligibilityInput } from "@/modules/music-requests/gates";

function input(overrides: Partial<QrMusicEligibilityInput> = {}): QrMusicEligibilityInput {
  return {
    qrMode: "table_bound",
    querySessionId: null,
    currentSessionId: null,
    sessionActive: false,
    isEnterprise: true,
    musicLicenseStatus: "approved",
    musicRequestEnabled: true,
    ...overrides,
  };
}

describe("resolveQrMusicEligibility — table_bound", () => {
  it("allows music without an active session when the music gate passes", () => {
    const r = resolveQrMusicEligibility(input({ sessionActive: false }));
    expect(r.canViewQueue).toBe(true);
    expect(r.canSubmitRequest).toBe(true);
    expect(r.expiredWholeQr).toBe(false);
    expect(r.reason).toBeNull();
  });

  it("still allows music after checkout (session cleared)", () => {
    const r = resolveQrMusicEligibility(
      input({ sessionActive: false, currentSessionId: null }),
    );
    expect(r.canSubmitRequest).toBe(true);
    expect(r.expiredWholeQr).toBe(false);
  });

  it("blocks music for non-Enterprise stores", () => {
    const r = resolveQrMusicEligibility(input({ isEnterprise: false }));
    expect(r.canViewQueue).toBe(false);
    expect(r.canSubmitRequest).toBe(false);
    expect(r.expiredWholeQr).toBe(false);
    expect(r.reason).toContain("Enterprise");
  });

  it("blocks music when the license is not approved", () => {
    const r = resolveQrMusicEligibility(input({ musicLicenseStatus: "pending" }));
    expect(r.canSubmitRequest).toBe(false);
    expect(r.reason).not.toBeNull();
  });

  it("blocks music when the store toggle is off", () => {
    const r = resolveQrMusicEligibility(input({ musicRequestEnabled: false }));
    expect(r.canSubmitRequest).toBe(false);
    expect(r.reason).not.toBeNull();
  });
});

describe("resolveQrMusicEligibility — session_printed", () => {
  const SESSION = "11111111-1111-1111-1111-111111111111";

  it("allows music when the query session matches the active session", () => {
    const r = resolveQrMusicEligibility(
      input({
        qrMode: "session_printed",
        sessionActive: true,
        currentSessionId: SESSION,
        querySessionId: SESSION,
      }),
    );
    expect(r.canViewQueue).toBe(true);
    expect(r.canSubmitRequest).toBe(true);
    expect(r.expiredWholeQr).toBe(false);
  });

  it("expires the whole QR when no session query is present", () => {
    const r = resolveQrMusicEligibility(
      input({
        qrMode: "session_printed",
        sessionActive: true,
        currentSessionId: SESSION,
        querySessionId: null,
      }),
    );
    expect(r.expiredWholeQr).toBe(true);
    expect(r.canSubmitRequest).toBe(false);
    expect(r.reason).toContain("หมดอายุ");
  });

  it("expires the whole QR when the query session no longer matches (after checkout)", () => {
    const r = resolveQrMusicEligibility(
      input({
        qrMode: "session_printed",
        sessionActive: false,
        currentSessionId: null,
        querySessionId: SESSION,
      }),
    );
    expect(r.expiredWholeQr).toBe(true);
    expect(r.canSubmitRequest).toBe(false);
  });

  it("expires when the printed QR's session was replaced by a newer one", () => {
    const r = resolveQrMusicEligibility(
      input({
        qrMode: "session_printed",
        sessionActive: true,
        currentSessionId: "22222222-2222-2222-2222-222222222222",
        querySessionId: SESSION,
      }),
    );
    expect(r.expiredWholeQr).toBe(true);
  });
});
