import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildSettingsTabs } from "@/app/(dashboard)/settings/settings-tabs";
import { resolvePermissions } from "@/modules/auth/permission-resolver";
import { DEFAULT_BILLING_STATE } from "@/modules/billing/types";

// 2026-09-18 — แคชเชียร์เปิดเครื่องเล่นเพลงได้: หน้า /player ใช้สิทธิ์ orders.manage_qr (แคชเชียร์มีอยู่แล้ว)
// แต่ปุ่มเปิดอยู่ในแท็บตั้งค่าที่เห็นเฉพาะ settings.manage_store — แคชเชียร์จึงหาทางเข้าไม่เจอ

const enterprise = { ...DEFAULT_BILLING_STATE, plan: "enterprise" as const, status: "active" as const };

describe("แคชเชียร์เข้าถึงเครื่องเล่นเพลง", () => {
  it("แคชเชียร์มีสิทธิ์เดียวกับที่หน้าเครื่องเล่นตรวจ", () => {
    expect(resolvePermissions("cashier", [], "org", "store").can("orders.manage_qr")).toBe(true);
    expect(readFileSync("src/app/player/[storeSlug]/page.tsx", "utf8")).toContain('resolved.can("orders.manage_qr")');
  });

  it("แท็บเครื่องเล่นเพลงขึ้นให้แคชเชียร์ (แพ็กที่มีฟีเจอร์) แต่พนักงานทั่วไปไม่เห็น", () => {
    const cashierTabs = buildSettingsTabs(resolvePermissions("cashier", [], "org", "store"), enterprise).map((tab) => tab.href);
    expect(cashierTabs).toContain("/settings/music-player");
    // แท็บตั้งค่าร้านอื่น ๆ ยังไม่เปิดให้แคชเชียร์
    expect(cashierTabs).not.toContain("/settings/store");
    const staffTabs = buildSettingsTabs(resolvePermissions("staff", [], "org", "store"), enterprise).map((tab) => tab.href);
    expect(staffTabs).not.toContain("/settings/music-player");
  });

  it("หน้าคิวขอเพลงมีปุ่มเปิดเครื่องเล่น และหน้าตั้งค่ายังล็อกการบันทึกไว้ที่ settings.manage_store", () => {
    expect(readFileSync("src/app/(dashboard)/music-requests/MusicRequestsBoard.tsx", "utf8")).toContain("href={`/player/${storeSlug}`}");
    expect(readFileSync("src/app/(dashboard)/settings/music-player/page.tsx", "utf8")).toContain('canEdit={resolved.can("settings.manage_store")}');
  });
});
