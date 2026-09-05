import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ctx = { organizationId: "org-1", storeId: "store-1" };
const user = { id: "user-1" };

async function loadAction(options: { authed?: boolean; canUsePos?: boolean } = {}) {
  const { authed = true, canUsePos = true } = options;
  vi.resetModules();
  const logSystemEvent = vi.fn().mockResolvedValue(undefined);
  vi.doMock("@/modules/auth/guards", () => ({
    getOptionalResolvedCurrentPermissions: vi
      .fn()
      .mockResolvedValue(authed ? { ctx, user, resolved: { can: () => canUsePos } } : null),
  }));
  vi.doMock("@/modules/system/event-log", () => ({ logSystemEvent }));
  const mod = await import("@/app/pos/unified/voice-telemetry-actions");
  return { record: mod.recordVoiceTelemetryAction, logSystemEvent };
}

const valid = {
  intentType: "pos.add_item",
  resultCode: "matched",
  locale: "th-TH",
  confidenceBucket: "high",
  source: "deterministic",
};

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("บันทึก telemetry ของคำสั่งเสียงลง server", () => {
  it("บันทึกเหตุการณ์ที่ถูกต้อง พร้อม org/store/actor", async () => {
    const { record, logSystemEvent } = await loadAction();
    await record(valid);

    expect(logSystemEvent).toHaveBeenCalledTimes(1);
    const call = logSystemEvent.mock.calls[0][0];
    expect(call).toMatchObject({
      level: "info",
      source: "voice.command",
      action: "recognize",
      organizationId: "org-1",
      storeId: "store-1",
      actorUserId: "user-1",
    });
    expect(call.context).toEqual({
      intentType: "pos.add_item",
      resultCode: "matched",
      locale: "th-TH",
      confidenceBucket: "high",
      source: "deterministic",
    });
  });

  it("ผลที่ไม่ใช่ matched บันทึกเป็น warn (ต้องเห็นว่าระบบไม่เข้าใจบ่อยแค่ไหน)", async () => {
    const { record, logSystemEvent } = await loadAction();
    await record({ ...valid, resultCode: "no_match" });
    expect(logSystemEvent.mock.calls[0][0].level).toBe("warn");
  });

  it("ไม่มีคำพูดหลุดเข้าไปได้ แม้ client จะแอบส่งมา", async () => {
    const { record, logSystemEvent } = await loadAction();
    await record({ ...valid, transcript: "ลาเต้สองแก้ว", utterance: "ลาเต้" } as never);

    const wire = JSON.stringify(logSystemEvent.mock.calls[0][0]);
    expect(wire).not.toContain("ลาเต้");
    expect(wire).not.toContain("transcript");
    expect(wire).not.toContain("utterance");
    // context ประกอบใหม่จาก allowlist เท่านั้น จึงมีได้แค่ 5 คีย์
    expect(Object.keys(logSystemEvent.mock.calls[0][0].context).sort()).toEqual([
      "confidenceBucket",
      "intentType",
      "locale",
      "resultCode",
      "source",
    ]);
  });

  it("ค่านอก allowlist = ไม่บันทึกเลย (fail closed)", async () => {
    for (const bad of [
      { ...valid, intentType: "pos.checkout" },
      { ...valid, resultCode: "paid" },
      { ...valid, confidenceBucket: "certain" },
    ]) {
      const { record, logSystemEvent } = await loadAction();
      await record(bad);
      expect(logSystemEvent, JSON.stringify(bad)).not.toHaveBeenCalled();
    }
  });

  it("source ที่ไม่ใช่ ai ถือเป็น deterministic เสมอ", async () => {
    const { record, logSystemEvent } = await loadAction();
    await record({ ...valid, source: "somewhere-else" });
    expect(logSystemEvent.mock.calls[0][0].context.source).toBe("deterministic");
  });

  it("ตัด locale ที่ยาวผิดปกติ", async () => {
    const { record, logSystemEvent } = await loadAction();
    await record({ ...valid, locale: "x".repeat(200) });
    expect(logSystemEvent.mock.calls[0][0].context.locale).toHaveLength(16);
  });

  it("ไม่ล็อกอิน หรือไม่มีสิทธิ์ pos.use = ไม่บันทึก", async () => {
    const anon = await loadAction({ authed: false });
    await anon.record(valid);
    expect(anon.logSystemEvent).not.toHaveBeenCalled();

    const noPerm = await loadAction({ canUsePos: false });
    await noPerm.record(valid);
    expect(noPerm.logSystemEvent).not.toHaveBeenCalled();
  });

  it("ไม่โยน error ออกไปหา UI แม้ log จะพัง", async () => {
    vi.resetModules();
    vi.doMock("@/modules/auth/guards", () => ({
      getOptionalResolvedCurrentPermissions: vi.fn().mockResolvedValue({ ctx, user, resolved: { can: () => true } }),
    }));
    vi.doMock("@/modules/system/event-log", () => ({
      logSystemEvent: vi.fn().mockRejectedValue(new Error("db down")),
    }));
    const mod = await import("@/app/pos/unified/voice-telemetry-actions");
    await expect(mod.recordVoiceTelemetryAction(valid)).resolves.toBeUndefined();
  });
});

describe("การต่อสายฝั่ง UI", () => {
  const controller = readFileSync(
    join(process.cwd(), "src/app/pos/unified/VoicePosController.tsx"),
    "utf8",
  );

  it("ยิงทั้งผลของ parser เดิมและผลของ AI", () => {
    expect(controller).toContain('reportVoiceTelemetry({ ...event, source: "deterministic" })');
    expect(controller).toContain('source: "ai",');
  });

  it("ยิงแบบ fire-and-forget ไม่ await ในเส้นทางที่ผู้ใช้รออยู่", () => {
    expect(controller).toContain("void recordVoiceTelemetryAction(event)");
  });
});
