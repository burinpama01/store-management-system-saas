import { afterEach, describe, expect, it } from "vitest";
import { registerWakeTarget, routeWakeToLive } from "@/modules/voice-pos/wake-routing";

// PR3-Live (fix) — คำปลุกของเครื่องต้องเปิดโหมดเสียงสดได้ ไม่ใช่เปิดได้แค่ปุ่มเสียงเดิม
// สัญญาที่ฝั่งคำปลุกพึ่งพา: ตอบทันที (ไม่ใช่ Promise) และไม่มีปลายทาง = เส้นทางเดิมต้องไม่เปลี่ยน

let cleanup: (() => void) | null = null;

afterEach(() => {
  cleanup?.();
  cleanup = null;
});

describe("wake routing", () => {
  it("ไม่มีใครลงทะเบียน = unavailable (คำปลุกเดินเส้นทาง Voice POS เดิม)", () => {
    expect(routeWakeToLive()).toBe("unavailable");
  });

  it("ปลายทางที่ว่างอยู่ = started, กำลังคุยอยู่ = busy (ห้ามเปิดไมค์ซ้อน)", () => {
    let phase: "idle" | "active" = "idle";
    let starts = 0;
    cleanup = registerWakeTarget(() => {
      if (phase !== "idle") return "busy";
      starts += 1;
      phase = "active";
      return "started";
    });

    expect(routeWakeToLive()).toBe("started");
    expect(routeWakeToLive()).toBe("busy");
    expect(starts).toBe(1);
  });

  it("ถอนทะเบียนแล้วกลับไปเส้นทางเดิม และถอนของเก่าต้องไม่ลบปลายทางใหม่", () => {
    const unregisterOld = registerWakeTarget(() => "started");
    cleanup = registerWakeTarget(() => "busy");

    unregisterOld(); // ของเก่าถูกแทนที่ไปแล้ว — ถอนต้องไม่มีผลกับของใหม่
    expect(routeWakeToLive()).toBe("busy");

    cleanup();
    cleanup = null;
    expect(routeWakeToLive()).toBe("unavailable");
  });

  it("ปลายทางพังต้องไม่ทำให้คำปลุกทั้งระบบตาย — ถอยไปเส้นทางเดิม", () => {
    cleanup = registerWakeTarget(() => {
      throw new Error("live core exploded");
    });

    expect(routeWakeToLive()).toBe("unavailable");
  });
});
