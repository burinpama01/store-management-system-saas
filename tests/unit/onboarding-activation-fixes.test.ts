import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getStepCopy, recommendedAnswers } from "@/modules/onboarding/step-copy";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const cronRoute = "src/app/api/notifications/cron/activation/route.ts";

describe("ถ้อยคำขั้นเตรียมร้านปรับตามประเภทร้าน", () => {
  it("เรียกรายการที่ขายตามประเภท: เมนูสินค้า / สินค้า / บริการ", () => {
    expect(getStepCopy("catalog", "restaurant").title).toBe("เพิ่มเมนูสินค้า");
    expect(getStepCopy("catalog", "retail").title).toBe("เพิ่มสินค้า");
    expect(getStepCopy("catalog", "service").title).toBe("เพิ่มบริการ");
    // ร้านเก่าที่ยังไม่เคยตอบคำถาม (profile = null) ต้องได้ถ้อยคำเดิม
    expect(getStepCopy("catalog", null).title).toBe("เพิ่มเมนูสินค้า");
  });

  it("ทุกขั้นมีลิงก์ หัวข้อ คำอธิบาย และข้อความแจ้งเตือนครบ", () => {
    for (const step of ["store-profile", "catalog", "table", "printer", "first-paid-order"] as const) {
      const copy = getStepCopy(step, null);
      expect(copy.href.startsWith("/")).toBe(true);
      expect(copy.title.length).toBeGreaterThan(0);
      expect(copy.desc.length).toBeGreaterThan(0);
      expect(copy.nudge.length).toBeGreaterThan(0);
    }
  });

  it("ค่าแนะนำของแต่ละประเภท: ร้านอาหารมีโต๊ะ ร้านขายของไม่มีโต๊ะแต่พิมพ์ใบเสร็จ", () => {
    expect(recommendedAnswers("restaurant")).toEqual({ usesTables: true, needsPrinting: true });
    expect(recommendedAnswers("retail")).toEqual({ usesTables: false, needsPrinting: true });
    expect(recommendedAnswers("service")).toEqual({ usesTables: false, needsPrinting: false });
  });
});

describe("cron activation nudge — ข้อมูลที่ป้อนเข้า engine ต้องถูกชนิด", () => {
  it("แปลงแถว { step } เป็นรายชื่อ step ก่อนเช็คซ้ำในวันเดียวกัน", () => {
    const source = read(cronRoute);
    expect(source).toContain('as Array<{ step: string }>).map((row) => row.step)');
    // ของเดิม cast เป็น Array<string> ทำให้ includes() ไม่เคยตรง
    expect(source).not.toContain('?? []) as Array<string>');
  });

  it("อ่าน opt-out จาก notification_settings จริง ไม่ใช่ค่าคงที่ false", () => {
    const source = read(cronRoute);
    expect(source).toContain('.from("notification_settings")');
    expect(source).toContain('"activation_nudge" as Database');
    expect(source).toContain("optedOut: optedOutStoreIds.has(store.id)");
    expect(source).not.toContain("optedOut: false,");
  });

  it("ใช้ถ้อยคำกลางจาก step-copy แทนตารางซ้ำในรูท", () => {
    const source = read(cronRoute);
    expect(source).toContain('import { getStepCopy } from "@/modules/onboarding/step-copy"');
    expect(source).not.toContain("const STEP_COPY");
  });
});

describe("การ์ดเตรียมร้านบนแดชบอร์ด", () => {
  it("แสดงเฉพาะผู้มีสิทธิ์ตั้งค่าร้าน และข้ามการโหลดเมื่อขายจริงแล้ว", () => {
    const source = read("src/app/(dashboard)/dashboard/page.tsx");
    expect(source).toContain('resolved.can("settings.manage_store") ? await loadSetupPrompt');
    expect(source).toContain("if ((await countPaidOrders(storeId, organizationId)) > 0) return null;");
    expect(source).toContain('href="/onboarding"');
  });
});
