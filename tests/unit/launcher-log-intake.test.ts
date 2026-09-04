import { describe, it, expect } from "vitest";
import {
  MAX_LAUNCHER_LOG_ENTRIES,
  MAX_LAUNCHER_MESSAGE_CHARS,
  redactSensitive,
  sanitizeLauncherLogBatch,
  sanitizeLauncherVersion,
} from "@/modules/launcher/log-intake";

// Launcher ส่ง log จากเครื่องแคชเชียร์ของร้านกลับมาที่เซิร์ฟเวอร์ เพื่อไล่ปัญหาบนเครื่อง
// ที่เราเข้าไปดูไม่ได้ — เนื้อหาทั้งหมดเป็นข้อมูลจากเครื่องคนอื่น จึงต้องตรวจ/ตัด/กลบก่อนบันทึก

describe("redactSensitive", () => {
  it("กลบค่าที่ตามหลังคำว่า token/password/authorization", () => {
    expect(redactSensitive("POST /api/print/hub/poll hubToken=abc123def456")).toContain("[ซ่อนไว้]");
    expect(redactSensitive("POST /api/print/hub/poll hubToken=abc123def456")).not.toContain("abc123def456");
    expect(redactSensitive('header authorization: "Bearer eyJhbGciOi"')).not.toContain("eyJhbGciOi");
    expect(redactSensitive("password: hunter2xyz")).not.toContain("hunter2xyz");
  });

  it("สตริงยาวติดกันเกิน 40 ตัวถือว่าเป็นโทเค็นและถูกกลบทั้งก้อน", () => {
    const token = "a".repeat(48);
    expect(redactSensitive(`request failed for ${token}`)).not.toContain(token);
  });

  it("ไม่กลบข้อความปกติที่ผู้ดูแลต้องอ่าน", () => {
    const message = "ไม่พบเครื่องพิมพ์ USB บนเครื่องแคชเชียร์ (USB001)";
    expect(redactSensitive(message)).toBe(message);
  });
});

describe("sanitizeLauncherLogBatch", () => {
  const entry = (extra: Record<string, unknown> = {}) => ({
    at: "2026-09-04T01:00:00.000Z",
    level: "error",
    code: "hub_start_failed",
    message: "สั่ง Scheduled Task ไม่สำเร็จ",
    ...extra,
  });

  it("รับรายการที่ถูกต้องพร้อม normalize ระดับความรุนแรง", () => {
    const batch = sanitizeLauncherLogBatch([
      entry(),
      entry({ level: "warning", code: "webview2_missing" }),
      entry({ level: "weird", code: "hub_ready" }),
    ]);
    expect(batch.dropped).toBe(0);
    expect(batch.entries.map((e) => e.level)).toEqual(["error", "warn", "info"]);
  });

  it("ทิ้งรายการที่ไม่มี code หรือ code รูปแบบผิด และนับจำนวนที่ทิ้งไว้", () => {
    const batch = sanitizeLauncherLogBatch([
      entry({ code: "" }),
      entry({ code: "มีภาษาไทย" }),
      entry({ code: "ok_code" }),
      "ไม่ใช่ object",
      null,
    ]);
    expect(batch.entries).toHaveLength(1);
    expect(batch.dropped).toBe(4);
  });

  it("จำกัดจำนวนต่อหนึ่งครั้งและตัดข้อความยาว", () => {
    const many = Array.from({ length: MAX_LAUNCHER_LOG_ENTRIES + 5 }, () => entry());
    const batch = sanitizeLauncherLogBatch(many);
    expect(batch.entries).toHaveLength(MAX_LAUNCHER_LOG_ENTRIES);
    expect(batch.dropped).toBe(5);

    // ข้อความจริงที่ยาวเกิน (stack trace ของ Windows) ถูกตัด ไม่ใช่ถูกทิ้ง
    const long = sanitizeLauncherLogBatch([entry({ message: "เปิด Print Hub ไม่สำเร็จ ".repeat(80) })]);
    expect(long.entries[0].message).toHaveLength(MAX_LAUNCHER_MESSAGE_CHARS);
  });

  it("กลบความลับใน message และ context ก่อนบันทึก", () => {
    const batch = sanitizeLauncherLogBatch([
      entry({ message: "poll failed hubToken=supersecretvalue123456", context: { url: "https://x/y?token=abcdef123456" } }),
    ]);
    expect(batch.entries[0].message).not.toContain("supersecretvalue123456");
    expect(JSON.stringify(batch.entries[0].context)).not.toContain("abcdef123456");
  });

  it("เวลาที่ล้ำอนาคตเกินหนึ่งวัน หรือรูปแบบผิด = null (นาฬิกาเครื่องร้านเพี้ยนได้)", () => {
    const future = new Date(Date.now() + 7 * 24 * 3600_000).toISOString();
    expect(sanitizeLauncherLogBatch([entry({ at: future })]).entries[0].at).toBeNull();
    expect(sanitizeLauncherLogBatch([entry({ at: "เมื่อวาน" })]).entries[0].at).toBeNull();
    expect(sanitizeLauncherLogBatch([entry()]).entries[0].at).toBe("2026-09-04T01:00:00.000Z");
  });

  it("context รับเฉพาะค่าพื้นฐานและจำกัดจำนวนคีย์", () => {
    const context: Record<string, unknown> = { taskState: "Running", attempts: 3, ready: true, blob: { a: 1 } };
    for (let i = 0; i < 20; i += 1) context[`k${i}`] = i;
    const [first] = sanitizeLauncherLogBatch([entry({ context })]).entries;
    expect(first.context).toBeTruthy();
    expect(Object.keys(first.context!).length).toBeLessThanOrEqual(12);
    expect(first.context).not.toHaveProperty("blob");
  });

  it("ไม่ใช่ array = ไม่รับอะไรเลย (ไม่ throw)", () => {
    expect(sanitizeLauncherLogBatch(null)).toEqual({ entries: [], dropped: 0 });
    expect(sanitizeLauncherLogBatch({ entries: [] })).toEqual({ entries: [], dropped: 0 });
  });
});

describe("sanitizeLauncherVersion", () => {
  it("รับเวอร์ชันปกติ ปฏิเสธของแปลก", () => {
    expect(sanitizeLauncherVersion("0.1.0")).toBe("0.1.0");
    expect(sanitizeLauncherVersion(" 0.1.0-beta ")).toBe("0.1.0-beta");
    expect(sanitizeLauncherVersion("<script>")).toBeNull();
    expect(sanitizeLauncherVersion(123)).toBeNull();
  });
});
