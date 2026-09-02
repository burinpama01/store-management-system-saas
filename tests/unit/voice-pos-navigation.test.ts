// U14 — Voice Tier A navigation: allowlist ปลายทาง + เหตุผลที่ block ต้องชัดเจน
// กติกาหลัก: "ห้ามสร้าง URL/action ขึ้นเอง" — route ต้องมาจาก command index เดิมเท่านั้น
import { describe, expect, it } from "vitest";
import { DASHBOARD_COMMANDS, type CommandItem } from "@/modules/assistant/command-index";
import { parseVoiceCommand } from "@/modules/voice-pos/parser";
import {
  resolveVoiceNavigation,
  stripNavigationPrefixes,
  type VoiceNavigationContext,
} from "@/modules/voice-pos/navigation";

const OWNER_COMMANDS: readonly CommandItem[] = DASHBOARD_COMMANDS;

function contextFor(allowed: readonly CommandItem[], voiceEnabled = true): VoiceNavigationContext {
  return { voiceEnabled, allowedCommands: allowed, allCommands: DASHBOARD_COMMANDS };
}

function navigate(phrase: string, context: VoiceNavigationContext) {
  return resolveVoiceNavigation(parseVoiceCommand(phrase), context);
}

describe("stripNavigationPrefixes", () => {
  it("ตัดคำนำหน้าที่ไม่ใช่ชื่อปลายทางออกจนหมด", () => {
    expect(stripNavigationPrefixes("แท็บครัว")).toBe("ครัว");
    expect(stripNavigationPrefixes("หน้าขาย")).toBe("ขาย");
    expect(stripNavigationPrefixes("ที่โต๊ะ")).toBe("โต๊ะ");
    expect(stripNavigationPrefixes("รายงานยอดขาย")).toBe("รายงานยอดขาย");
  });
});

describe("resolveVoiceNavigation — แท็บของ POS รวม", () => {
  it("เปิดได้ครบทั้ง 4 แท็บจากคำพูดไทย", () => {
    const context = contextFor(OWNER_COMMANDS);
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["เปิดแท็บขาย", "sell"],
      ["ไปที่โต๊ะ", "tables"],
      ["เปิดครัว", "kitchen"],
      ["ไปที่แท็บบิล", "bills"],
      ["แสดงคิวครัว", "kitchen"],
      ["เปิดหน้าขาย", "sell"],
    ];
    for (const [phrase, tabId] of cases) {
      const outcome = navigate(phrase, context);
      expect(outcome, phrase).toMatchObject({ status: "navigate", target: { kind: "tab", tabId } });
    }
  });

  it("ประกาศผลโดยไม่มีคำพูดของผู้ใช้อยู่ในข้อความ", () => {
    const outcome = navigate("เปิดครัว", contextFor(OWNER_COMMANDS));
    expect(outcome.announcement).toBe("เปิดแท็บครัวแล้ว");
  });

  it("ชื่อแท็บต้องตรงทั้งคำ — 'รายงานยอดขาย' ต้องไม่ไปโดนแท็บขาย", () => {
    const outcome = navigate("เปิดรายงานยอดขาย", contextFor(OWNER_COMMANDS));
    expect(outcome).toMatchObject({ status: "navigate", target: { kind: "route", href: "/reports" } });
  });
});

describe("resolveVoiceNavigation — โฟกัสในหน้า", () => {
  it("ค้นหา/ตะกร้า อยู่ใน allowlist", () => {
    const context = contextFor(OWNER_COMMANDS);
    expect(navigate("เปิดค้นหา", context)).toMatchObject({
      status: "navigate",
      target: { kind: "focus", action: "search" },
    });
    expect(navigate("ไปที่ตะกร้า", context)).toMatchObject({
      status: "navigate",
      target: { kind: "focus", action: "cart" },
    });
  });
});

describe("resolveVoiceNavigation — route จาก command index เท่านั้น", () => {
  it("ใช้ href จาก command index ไม่ประกอบ URL เอง", () => {
    const outcome = navigate("เปิดสต๊อก", contextFor(OWNER_COMMANDS));
    expect(outcome).toMatchObject({ status: "navigate", target: { kind: "route", commandId: "/stock", href: "/stock" } });
    if (outcome.status === "navigate" && outcome.target.kind === "route") {
      const target = outcome.target;
      expect(DASHBOARD_COMMANDS.some((c) => c.id === target.commandId)).toBe(true);
    }
  });

  it("ทุกปลายทางชนิด route ต้องมีอยู่ใน DASHBOARD_COMMANDS เสมอ", () => {
    const context = contextFor(OWNER_COMMANDS);
    for (const phrase of ["เปิดรายงาน", "เปิดสต๊อก", "เปิดพนักงาน", "เปิดบัญชี", "เปิดแจ้งเตือน"]) {
      const outcome = navigate(phrase, context);
      if (outcome.status !== "navigate" || outcome.target.kind !== "route") continue;
      const target = outcome.target;
      const hit = DASHBOARD_COMMANDS.find((c) => c.id === target.commandId);
      expect(hit, phrase).toBeTruthy();
      expect(target.href).toBe(hit?.href);
    }
  });

  it("ไม่มีสิทธิ์เข้าหน้านั้น → blocked permission_denied ไม่ใช่พาไปเงียบๆ", () => {
    const withoutReports = DASHBOARD_COMMANDS.filter((c) => c.id !== "/reports");
    const outcome = navigate("เปิดรายงาน", contextFor(withoutReports));
    expect(outcome).toMatchObject({ status: "blocked", reason: "permission_denied" });
  });

  it("คำที่ไม่มีในรายการ → no_match (ไม่เดา URL)", () => {
    const outcome = navigate("เปิดยานอวกาศ", contextFor(OWNER_COMMANDS));
    expect(outcome).toMatchObject({ status: "blocked", reason: "no_match" });
  });
});

describe("resolveVoiceNavigation — ประตูความปลอดภัย", () => {
  it("flag ปิด → ไม่ทำอะไรเลย", () => {
    const outcome = navigate("เปิดครัว", contextFor(OWNER_COMMANDS, false));
    expect(outcome).toMatchObject({ status: "blocked", reason: "feature_disabled" });
  });

  it("คำสั่งต้องห้าม (Tier D) → ต้องทำบนหน้าจอ", () => {
    const outcome = navigate("ชำระเงิน", contextFor(OWNER_COMMANDS));
    expect(outcome).toMatchObject({ status: "blocked", reason: "not_navigate" });
    expect(outcome.announcement).toBe("คำสั่งนี้ต้องทำบนหน้าจอ");
  });

  it("คำสั่งตะกร้า (Tier B) ยังไม่ใช่หน้าที่ของ U14", () => {
    const outcome = navigate("เพิ่มลาเต้ 2 แก้ว", contextFor(OWNER_COMMANDS));
    expect(outcome).toMatchObject({ status: "blocked", reason: "not_navigate" });
  });

  it("ฟังไม่ชัด (decision ไม่ใช่ execute) → ไม่เปิดหน้าอัตโนมัติ", () => {
    const result = parseVoiceCommand("เปิดครัว", { recognitionConfidence: 0.2 });
    const outcome = resolveVoiceNavigation(result, contextFor(OWNER_COMMANDS));
    expect(outcome).toMatchObject({ status: "blocked", reason: "not_executable" });
  });

  it("ข้อความว่าง → block ไม่ throw", () => {
    const outcome = navigate("   ", contextFor(OWNER_COMMANDS));
    expect(outcome.status).toBe("blocked");
  });

  it("ทุกข้อความประกาศต้องไม่มีคำพูดของผู้ใช้", () => {
    const context = contextFor(OWNER_COMMANDS);
    for (const phrase of ["เปิดครัว", "เปิดยานอวกาศ", "ชำระเงิน", "เพิ่มลาเต้ 2 แก้ว"]) {
      const outcome = navigate(phrase, context);
      expect(outcome.announcement).not.toContain("ยานอวกาศ");
      expect(outcome.announcement).not.toContain("ลาเต้");
    }
  });
});
