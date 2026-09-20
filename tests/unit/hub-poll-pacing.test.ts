import { describe, it, expect } from "vitest";
import {
  HUB_POLL_ACTIVE_MS,
  HUB_POLL_CLOSED_MS,
  HUB_POLL_IDLE_MS,
  STAFF_SHIFT_MAX_MS,
  resolveHubPollPacing,
} from "@/modules/printing/hub-poll-pacing";

const base = {
  claimedJobs: 0,
  staffOnDuty: false,
  cashSessionOpen: false,
  recentOrder: false,
};

describe("hub poll pacing — server บอกจังหวะ poll จากสัญญาณว่าร้านเปิดจริงไหม", () => {
  it("มีงานพิมพ์ = จังหวะเดิม ไม่ยืดเด็ดขาด", () => {
    const pacing = resolveHubPollPacing({ ...base, claimedJobs: 1 });
    expect(pacing.nextPollMs).toBe(HUB_POLL_ACTIVE_MS);
    expect(pacing.reason).toBe("jobs");
  });

  it("พนักงานลงเวลาเข้างานค้างอยู่ = ร้านเปิด ใช้จังหวะ idle", () => {
    const pacing = resolveHubPollPacing({ ...base, staffOnDuty: true });
    expect(pacing.nextPollMs).toBe(HUB_POLL_IDLE_MS);
    expect(pacing.reason).toBe("staff");
  });

  it("ไม่มีใครลงเวลาแต่รอบเงินสดเปิดอยู่ = ยังถือว่าร้านเปิด", () => {
    const pacing = resolveHubPollPacing({ ...base, cashSessionOpen: true });
    expect(pacing.nextPollMs).toBe(HUB_POLL_IDLE_MS);
    expect(pacing.reason).toBe("cashSession");
  });

  it("ไม่มีใครลงเวลา ไม่มีรอบเงินสด แต่เพิ่งมีออเดอร์ = ยังถือว่าร้านเปิด", () => {
    const pacing = resolveHubPollPacing({ ...base, recentOrder: true });
    expect(pacing.nextPollMs).toBe(HUB_POLL_IDLE_MS);
    expect(pacing.reason).toBe("recentOrder");
  });

  it("ไม่มีสัญญาณใดเลย = ร้านปิด ยืดยาวสุด", () => {
    const pacing = resolveHubPollPacing(base);
    expect(pacing.nextPollMs).toBe(HUB_POLL_CLOSED_MS);
    expect(pacing.reason).toBe("idle");
  });

  it("ถามสัญญาณไม่ได้ = ต้องถือว่าร้านเปิด (fail-safe) ห้ามเดาว่าปิด", () => {
    const pacing = resolveHubPollPacing({ ...base, signalsUnavailable: true });
    expect(pacing.nextPollMs).toBe(HUB_POLL_ACTIVE_MS);
  });

  it("signalsUnavailable ชนะสัญญาณอื่นทุกตัว แม้ค่าที่อ่านมาจะบอกว่าปิด", () => {
    const pacing = resolveHubPollPacing({
      claimedJobs: 0,
      staffOnDuty: false,
      cashSessionOpen: false,
      recentOrder: false,
      signalsUnavailable: true,
    });
    expect(pacing.nextPollMs).toBe(HUB_POLL_ACTIVE_MS);
  });

  it("จังหวะร้านปิดต้องยาวกว่าร้านเปิด และร้านเปิดต้องยาวกว่าตอนมีงาน", () => {
    expect(HUB_POLL_CLOSED_MS).toBeGreaterThan(HUB_POLL_IDLE_MS);
    expect(HUB_POLL_IDLE_MS).toBeGreaterThan(HUB_POLL_ACTIVE_MS);
  });
});

describe("อายุของการลงเวลา — กันเคสพนักงานลืมกดออกงาน", () => {
  it("STAFF_SHIFT_MAX_MS ต้องยาวพอสำหรับกะจริง แต่สั้นกว่าหนึ่งวันเต็ม", () => {
    // ระบบไม่มี auto clock-out แถวที่ลืมกดออกค้างถาวร ถ้าเพดานนี้ >= 24 ชม.
    // staffOnDuty จะจริงตลอดกาลและ Hub จะไม่เข้าโหมดร้านปิดอีกเลย
    expect(STAFF_SHIFT_MAX_MS).toBeGreaterThanOrEqual(12 * 60 * 60 * 1000);
    expect(STAFF_SHIFT_MAX_MS).toBeLessThan(24 * 60 * 60 * 1000);
  });
});
