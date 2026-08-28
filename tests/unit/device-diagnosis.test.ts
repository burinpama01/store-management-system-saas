import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { diagnoseDeviceError, buildManualPath } from "@/modules/ai/device-diagnosis";
import { redactDeviceDiagnosisInput } from "@/modules/ai/redaction";

const repoRoot = process.cwd();
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8");

describe("D1 device diagnosis — golden fixture (explain an error)", () => {
  it("returns advice-only output with requiresConfirmation forced true", async () => {
    let captured: unknown;
    vi.doMock("@/modules/ai/gateway", () => ({
      generateDeviceAdvice: vi.fn(async (input: unknown) => {
        captured = input;
        return { advice: { summary: "สายพิมพ์หลวม", steps: ["เสียบให้แน่น", "ทดสอบพิมพ์"], requiresConfirmation: false }, usage: {} };
      }),
      isAiEnabled: () => true,
      AI_DEFAULT_MODEL: "gpt-4o-mini",
    }));
    vi.resetModules();
    const { diagnoseDeviceError: fresh } = await import("@/modules/ai/device-diagnosis");
    const result = await fresh(
      { errorCode: "timeout", platform: "windows", channel: "usb", printerModel: "EPSON TM-T82III" },
      { approvedModelId: "gpt-4o-mini" },
    );
    expect(result.advice.requiresConfirmation).toBe(true);
    expect(result.advice.summary).toBe("สายพิมพ์หลวม");
    expect(result.model).toBe("gpt-4o-mini");
    // no-PII snapshot: what actually left for the provider is the allowlisted shape only
    expect(captured).toEqual({ errorCode: "timeout", platform: "windows", channel: "usb", printerModel: "EPSON TM-T82III" });
    vi.doUnmock("@/modules/ai/gateway");
  });

  it("input with store name/token/phone can never reach the provider (redaction upstream)", () => {
    const out = redactDeviceDiagnosisInput({
      errorCode: "disconnected",
      platform: "android",
      channel: "ble",
      storeName: "ร้านอะไรก็ได้",
      hubToken: "tok",
      phone: "0890000000",
    }) as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual(["channel", "errorCode", "platform"]);
  });

  it("every failure reason has a Thai manual path (never a raw provider error)", () => {
    for (const reason of ["ai_disabled", "ai_timeout", "quota_denied", "error"] as const) {
      const path = buildManualPath(reason);
      expect(path.length).toBeGreaterThan(10);
    }
    expect(buildManualPath("ai_timeout")).toContain("ลองใหม่");
  });
});

describe("device-diagnosis route governance (source guards)", () => {
  const route = read("src/app/api/ai/device-diagnosis/route.ts");

  it("authenticates and requires printer/store management permissions (tenant isolation)", () => {
    expect(route).toContain("getResolvedCurrentPermissions");
    expect(route).toContain('"Forbidden"');
    expect(route).toContain("settings.manage_printer");
  });

  it("reserves quota BEFORE the provider call (deny-before-call)", () => {
    const reserveIdx = route.indexOf("reserveQuota(");
    const callIdx = route.indexOf("diagnoseDeviceError(");
    expect(reserveIdx).toBeGreaterThan(-1);
    expect(callIdx).toBeGreaterThan(reserveIdx);
  });

  it("maps failures to manual paths and never leaks raw provider errors", () => {
    expect(route).toContain("buildManualPath");
    expect(route).toContain('"quota_denied"');
    expect(route).toContain("ai_timeout");
  });

  it("settles usage idempotently after the call", () => {
    expect(route).toContain("settleUsage(");
    expect(route).toContain('status: "ok"');
  });
});

describe("device profile success recording contract (source guards)", () => {
  const repo = read("src/modules/stores/printer-admin-repository.ts");
  const sql = read("supabase/migrations/20260827000003_device_profile_success_rpc.sql");

  it("records via the atomic security-definer RPC (server-only path)", () => {
    expect(repo).toContain('rpc("record_device_profile_success"');
    expect(sql).toContain("security definer");
    expect(sql).toContain("success_count = public.device_profiles.success_count + 1");
  });
});