import { beforeEach, describe, expect, it, vi } from "vitest";

// PR3-Live (ADR-008) — สมุดจดเจ้าของไมค์: claim ได้คนเดียวต่อหน้าจอ, ซ้ำโดยเจ้าของเดิม
// idempotent (กันเส้นทาง auto-listen ของเสียงเดิมพัง), release โดยคนอื่น = ไม่มีผล
// ทุกเคสโหลดโมดูลใหม่ เพราะ state เป็น singleton ของแท็บ (จำลอง "หน้าจอใหม่" ต่อเทสต์)

async function loadModule() {
  return await import("@/modules/voice-pos/mic-ownership");
}

beforeEach(() => {
  vi.resetModules();
});

describe("claimMicOwnership (ADR-008: one mic owner at a time)", () => {
  it("grants the mic when free and records the owner", async () => {
    const mod = await loadModule();
    expect(mod.readMicOwnership()).toBeNull();
    expect(mod.claimMicOwnership("voice-pos")).toBe(true);
    expect(mod.readMicOwnership()).toBe("voice-pos");
  });

  it("is idempotent for the same owner and notifies only on the first claim", async () => {
    const mod = await loadModule();
    const listener = vi.fn();
    mod.subscribeMicOwnership(listener);
    expect(mod.claimMicOwnership("ai-live")).toBe(true);
    expect(mod.claimMicOwnership("ai-live")).toBe(true);
    expect(mod.readMicOwnership()).toBe("ai-live");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("refuses a different owner while held — fail closed, holder unchanged", async () => {
    const mod = await loadModule();
    const listener = vi.fn();
    mod.subscribeMicOwnership(listener);
    expect(mod.claimMicOwnership("voice-pos")).toBe(true);
    expect(mod.claimMicOwnership("ai-live")).toBe(false);
    expect(mod.readMicOwnership()).toBe("voice-pos");
    expect(listener).toHaveBeenCalledTimes(1); // ไม่มี event ใหม่จากการถูกปฏิเสธ
  });

  it("grants to the next owner only after a real release", async () => {
    const mod = await loadModule();
    mod.claimMicOwnership("voice-pos");
    mod.releaseMicOwnership("voice-pos");
    expect(mod.claimMicOwnership("ai-live")).toBe(true);
    expect(mod.readMicOwnership()).toBe("ai-live");
  });
});

describe("releaseMicOwnership", () => {
  it("ignores a release by someone who does not hold the mic (stale session guard)", async () => {
    const mod = await loadModule();
    mod.claimMicOwnership("voice-pos");
    const listener = vi.fn();
    mod.subscribeMicOwnership(listener);
    // release ของ session เก่า (คนอื่น) ต้องไม่ปลดไมค์ของเจ้าของปัจจุบัน
    mod.releaseMicOwnership("ai-live");
    expect(mod.readMicOwnership()).toBe("voice-pos");
    expect(listener).not.toHaveBeenCalled();
    // เจ้าของปัจจุบันคืนได้ และการคืนซ้ำตอนว่าง = ไม่มีผล
    mod.releaseMicOwnership("voice-pos");
    mod.releaseMicOwnership("voice-pos");
    expect(mod.readMicOwnership()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when the mic is already free", async () => {
    const mod = await loadModule();
    const listener = vi.fn();
    mod.subscribeMicOwnership(listener);
    mod.releaseMicOwnership("voice-pos");
    expect(mod.readMicOwnership()).toBeNull();
    expect(listener).not.toHaveBeenCalled();
  });

  it("stops notifying after unsubscribe and still works for others", async () => {
    const mod = await loadModule();
    const listener = vi.fn();
    const unsubscribe = mod.subscribeMicOwnership(listener);
    mod.claimMicOwnership("voice-pos");
    unsubscribe();
    mod.releaseMicOwnership("voice-pos");
    mod.claimMicOwnership("ai-live");
    expect(mod.readMicOwnership()).toBe("ai-live");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
