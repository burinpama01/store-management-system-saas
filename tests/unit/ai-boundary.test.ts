import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { redactDeviceDiagnosisInput, maskIp } from "@/modules/ai/redaction";
import { DeviceAdviceSchema } from "@/modules/ai/schemas";
import { evaluateQuota } from "@/modules/ai/quota";
import { generateDeviceAdvice } from "@/modules/ai/gateway";

const repoRoot = process.cwd();
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8");

describe("ai redaction — allowlist only, no PII passthrough (Task 9)", () => {
  it("keeps only allowlisted fields with validated enums", () => {
    const out = redactDeviceDiagnosisInput({
      errorCode: "timeout",
      platform: "windows",
      channel: "usb",
      printerModel: "EPSON TM-T82III",
    });
    expect(out).toEqual({ errorCode: "timeout", platform: "windows", channel: "usb", printerModel: "EPSON TM-T82III" });
  });

  it("drops store names, phones, tokens, IPs and raw logs — never passes unknown keys", () => {
    const out = redactDeviceDiagnosisInput({
      errorCode: "disconnected",
      platform: "android",
      channel: "ble",
      storeName: "ร้านดัง",
      phone: "0812345678",
      hubToken: "secret-token",
      rawLog: "192.168.1.55 connect failed ...",
    }) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toContain("ร้านดัง");
    expect(JSON.stringify(out)).not.toContain("0812345678");
    expect(JSON.stringify(out)).not.toContain("secret-token");
    expect("storeName" in out).toBe(false);
    expect("rawLog" in out).toBe(false);
  });

  it("coerces out-of-enum values to unknown/other instead of trusting them", () => {
    const out = redactDeviceDiagnosisInput({ errorCode: "weird", platform: "temple-os", channel: "carrier-pigeon" });
    expect(out.errorCode).toBe("unknown");
    expect(out.platform).toBe("other");
    expect(out.channel).toBe("browser");
  });

  it("caps printerModel length and strips unsafe characters", () => {
    const out = redactDeviceDiagnosisInput({
      errorCode: "unknown",
      platform: "windows",
      channel: "hub",
      printerModel: "X".repeat(120) + " <script>",
    });
    expect((out.printerModel ?? "").length).toBeLessThanOrEqual(40);
    expect(out.printerModel).not.toContain("<");
  });

  it("maskIp keeps the network prefix only", () => {
    expect(maskIp("192.168.1.55")).toBe("192.168.x.x");
  });
});

describe("device advice schema — strict structured output", () => {
  it("accepts a valid advice object", () => {
    const parsed = DeviceAdviceSchema.safeParse({
      summary: "สาย USB หลวม",
      steps: ["เสียบสายใหม่", "ลองพิมพ์ทดสอบ"],
      requiresConfirmation: true,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects invalid structured output (missing fields / extra keys / too long)", () => {
    expect(DeviceAdviceSchema.safeParse({}).success).toBe(false);
    expect(DeviceAdviceSchema.safeParse({ summary: "s", steps: [], requiresConfirmation: true, extra: 1 }).success).toBe(false);
    expect(
      DeviceAdviceSchema.safeParse({ summary: "x".repeat(241), steps: [], requiresConfirmation: true }).success,
    ).toBe(false);
  });
});

describe("quota — deny before any provider call", () => {
  it("denies when monthly usage + reservation + request exceeds the org budget", () => {
    expect(evaluateQuota({ monthlyUsed: 900, monthlyReserved: 0, budget: 1000, maxTokens: 600 })).toMatchObject({
      granted: false,
      reason: "budget_exceeded",
    });
  });

  it("grants when the budget headroom covers the request", () => {
    expect(evaluateQuota({ monthlyUsed: 100, monthlyReserved: 200, budget: 1000, maxTokens: 600 })).toMatchObject({
      granted: true,
    });
  });

  it("treats invalid request sizes as deny", () => {
    expect(evaluateQuota({ monthlyUsed: 0, monthlyReserved: 0, budget: 1000, maxTokens: 0 }).granted).toBe(false);
  });
});

describe("gateway adapter — disabled/allowlist/timeout mapping", () => {
  const originalKey = process.env.OPENAI_API_KEY;

  afterEach(() => {
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
    vi.restoreAllMocks();
  });

  it("throws ai_disabled without calling the provider when the key is missing", async () => {
    delete process.env.OPENAI_API_KEY;
    vi.resetModules();
    const generateText = vi.fn();
    vi.doMock("ai", async () => {
      const actual = await vi.importActual<typeof import("ai")>("ai");
      return { ...actual, generateText };
    });
    const { generateDeviceAdvice: fresh } = await import("@/modules/ai/gateway");
    await expect(fresh({ errorCode: "timeout", platform: "windows", channel: "usb" }, "gpt-4o-mini")).rejects.toThrow(
      "ai_disabled",
    );
    expect(generateText).not.toHaveBeenCalled();
    vi.doUnmock("ai");
  });

  it("rejects model ids outside the allowlist", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    await expect(generateDeviceAdvice({ errorCode: "timeout", platform: "windows", channel: "usb" }, "gpt-99-turbo")).rejects.toThrow(
      "ai_disabled",
    );
  });

  it("maps provider timeout/abort to ai_timeout (manual path, not a raw 500)", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    vi.resetModules();
    vi.doMock("ai", async () => {
      const actual = await vi.importActual<typeof import("ai")>("ai");
      return {
        ...actual,
        generateText: vi.fn().mockRejectedValue(new DOMException("The operation was aborted", "AbortError")),
      };
    });
    const { generateDeviceAdvice: fresh } = await import("@/modules/ai/gateway");
    await expect(fresh({ errorCode: "timeout", platform: "windows", channel: "usb" }, "gpt-4o-mini")).rejects.toThrow("ai_timeout");
    vi.doUnmock("ai");
  });
});

describe("ai_device_foundation migration contract (source guards)", () => {
  const sql = read("supabase/migrations/20260827000002_ai_device_foundation.sql");

  it("enables RLS on all three tables", () => {
    expect((sql.match(/enable row level security/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("ai_usage_logs is append-only: no client insert/update/delete policies", () => {
    expect(sql).not.toMatch(/create policy[\s\S]*?on public\.ai_usage_logs\s+for insert/i);
    // no grant-style insert policy table for authenticated:
    expect(sql.split("on public.ai_usage_logs").slice(1).join("")).not.toMatch(/for insert|for update|for delete/i);
  });

  it("reserve RPC is security definer + atomic per-org advisory lock + idempotent request_id", () => {
    expect(sql).toContain("security definer");
    expect(sql).toContain("pg_advisory_xact_lock");
    expect(sql).toContain("unique (organization_id, request_id)");
  });

  it("never stores prompt text or raw PII columns in the ledger", () => {
    const noComments = sql.replace(/--[^\n]*/g, "");
    expect(noComments).not.toMatch(/^\s*(prompt|raw_log|ip_address|phone)\b/mi);
  });

  it("device_profiles is platform-level with no store/customer PII columns", () => {
    expect(sql).toContain("device_profiles");
    expect(sql.split("on public.device_profiles").slice(1).join("")).not.toMatch(/store_id|customer_id|phone/i);
  });
});