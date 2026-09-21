import { describe, it, expect } from "vitest";
import {
  HUB_POLL_ACTIVE_MS,
  HUB_POLL_CLOSED_MS,
  HUB_POLL_IDLE_MS,
  HUB_QUIET_UNTIL_CLOSED_MS,
  resolveHubPollPacing,
  sanitizeHubIdleMs,
} from "@/modules/printing/hub-poll-pacing";

describe("hub poll pacing — คิดจากสิ่งที่ Hub ส่งมาเอง ไม่แตะฐานข้อมูล", () => {
  it("เพิ่งเคลมงานไปพิมพ์ = จังหวะเดิม ไม่ยืดเด็ดขาด", () => {
    const pacing = resolveHubPollPacing({ claimedJobs: 1, idleMs: HUB_QUIET_UNTIL_CLOSED_MS * 10 });
    expect(pacing.nextPollMs).toBe(HUB_POLL_ACTIVE_MS);
    expect(pacing.reason).toBe("jobs");
  });

  it("คิวว่างแต่เพิ่งมีงานไม่นาน = จังหวะที่หน้าร้านไม่ทันสังเกต", () => {
    const pacing = resolveHubPollPacing({ claimedJobs: 0, idleMs: 60_000 });
    expect(pacing.nextPollMs).toBe(HUB_POLL_IDLE_MS);
    expect(pacing.reason).toBe("recent");
  });

  it("เงียบเกินเกณฑ์ = ถือว่าร้านปิด ยืดยาวสุด", () => {
    const pacing = resolveHubPollPacing({ claimedJobs: 0, idleMs: HUB_QUIET_UNTIL_CLOSED_MS });
    expect(pacing.nextPollMs).toBe(HUB_POLL_CLOSED_MS);
    expect(pacing.reason).toBe("quiet");
  });

  it("Hub รุ่นเก่าที่ไม่บอกว่าว่างมานานแค่ไหน = ต้องถือว่าร้านเปิด", () => {
    const pacing = resolveHubPollPacing({ claimedJobs: 0, idleMs: null });
    expect(pacing.nextPollMs).toBe(HUB_POLL_IDLE_MS);
    expect(pacing.reason).toBe("recent");
  });

  it("จังหวะร้านปิดต้องยาวกว่าคิวว่าง และคิวว่างต้องยาวกว่าตอนมีงาน", () => {
    expect(HUB_POLL_CLOSED_MS).toBeGreaterThan(HUB_POLL_IDLE_MS);
    expect(HUB_POLL_IDLE_MS).toBeGreaterThan(HUB_POLL_ACTIVE_MS);
  });

  describe("sanitizeHubIdleMs — ค่าที่ใช้ไม่ได้ต้องกลายเป็น null ไม่ใช่เดา", () => {
    it("ตัวเลขปกติผ่าน", () => {
      expect(sanitizeHubIdleMs(1234)).toBe(1234);
      expect(sanitizeHubIdleMs(0)).toBe(0);
    });

    it("ค่าติดลบ ไม่ใช่ตัวเลข หรือไม่มีค่า = null (ถือว่าร้านเปิด)", () => {
      for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, "5000", null, undefined, {}]) {
        expect(sanitizeHubIdleMs(bad)).toBeNull();
      }
    });
  });
});
