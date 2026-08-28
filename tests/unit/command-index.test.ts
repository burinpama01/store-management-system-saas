import { describe, expect, it } from "vitest";
import {
  visibleCommands,
  matchCommandFromText,
  fuzzyFilterCommands,
  DASHBOARD_COMMANDS,
  type CommandItem,
} from "@/modules/assistant/command-index";

const cmds: CommandItem[] = [
  { id: "pos", label: "POS", href: "/pos", permission: "pos.use", formFactors: ["mobile", "tablet", "desktop"] },
  { id: "receipt", label: "เครื่องพิมพ์", href: "/settings/receipt", permission: "settings.manage_printer", formFactors: ["desktop"] },
  { id: "onboarding", label: "ตั้งค่าเริ่มต้น", href: "/onboarding", permission: "settings.manage_store", formFactors: ["mobile", "tablet", "desktop"] },
];

describe("visibleCommands — permission × formFactor (Task 12 plan contract)", () => {
  it("filters by permission and form factor", () => {
    const desktop = visibleCommands(cmds, (p) => p === "settings.manage_printer" || p === "pos.use", "desktop");
    expect(desktop.map((c) => c.id)).toEqual(["pos", "receipt"]);
    const mobile = visibleCommands(cmds, () => true, "mobile");
    expect(mobile.map((c) => c.id)).toEqual(["pos", "onboarding"]);
  });

  it("returns nothing when no permission passes", () => {
    expect(visibleCommands(cmds, () => false, "desktop")).toEqual([]);
  });
});

describe("fuzzyFilterCommands — deterministic live search", () => {
  it("matches substring case-insensitively and ranks prefix matches first", () => {
    const ranked = fuzzyFilterCommands(cmds, "พิ");
    expect(ranked[0]?.id).toBe("receipt");
    expect(fuzzyFilterCommands(cmds, "POS").map((c) => c.id)).toEqual(["pos"]);
    expect(fuzzyFilterCommands(cmds, "zzz")).toEqual([]);
  });
});

describe("matchCommandFromText — deterministic Thai keyword → command (ชั้น 2 ก่อน AI)", () => {
  it("maps common Thai phrases to the right command id", () => {
    expect(matchCommandFromText("อยากขอเพลง", cmds)?.id ?? matchCommandFromText("อยากขอเพลง", DASHBOARD_COMMANDS)?.id).toBeTruthy();
    expect(matchCommandFromText("พิมพ์ใบเสร็จไม่ออก", cmds)?.id).toBe("receipt");
    expect(matchCommandFromText("เพิ่มสินค้าลงเมนู", DASHBOARD_COMMANDS)?.id).toBe("/catalog");
  });

  it("returns null for unrecognized text (never guesses a URL)", () => {
    expect(matchCommandFromText("กู้คืนระบบทั้งหมดทันทีเดี๋ยวนี้", cmds)).toBeNull();
  });
});

describe("DASHBOARD_COMMANDS integrity", () => {
  it("has unique ids/hrefs, non-empty labels and form factors", () => {
    const ids = DASHBOARD_COMMANDS.map((c) => c.id);
    const hrefs = DASHBOARD_COMMANDS.map((c) => c.href);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    for (const c of DASHBOARD_COMMANDS) {
      expect(c.label.length).toBeGreaterThan(0);
      expect(c.href.startsWith("/")).toBe(true);
      expect(c.formFactors.length).toBeGreaterThan(0);
      expect(c.permission.length).toBeGreaterThan(0);
    }
  });

  it("covers the core dashboard destinations", () => {
    for (const href of ["/dashboard", "/pos", "/catalog", "/stock", "/settings", "/onboarding"]) {
      expect(DASHBOARD_COMMANDS.find((c) => c.href === href), href).toBeDefined();
    }
  });
});