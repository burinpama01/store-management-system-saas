import { describe, expect, it } from "vitest";
import {
  hasUsableUsbDevice,
  isPrinterUnreachableError,
  shouldRetargetToUsb,
} from "@/modules/printing/usb-fallback";

const base = {
  failedKind: "ip",
  errorMessage: "Connection timed out (5000ms)",
  hubOnline: true,
  devices: [{ name: "POS-80C", isUsb: true, offline: false }],
  hasHubUsbPrinter: true,
} as const;

describe("สลับไปเครื่องพิมพ์ USB เมื่อเครื่องเดิมติดต่อไม่ได้", () => {
  it("เคสจริงของร้าน: ip timeout + POS-80C เสียบอยู่ → สลับ", () => {
    expect(shouldRetargetToUsb(base)).toBe(true);
  });

  it("งาน usb ที่ล้มต้องไม่ถูกสลับต่อ — กันวนเป็นลูป", () => {
    expect(shouldRetargetToUsb({ ...base, failedKind: "usb" })).toBe(false);
  });

  it("กระดาษหมด/ฝาเปิด ไม่ใช่เรื่องที่เปลี่ยนเครื่องแล้วหาย", () => {
    expect(shouldRetargetToUsb({ ...base, errorMessage: "Out of paper" })).toBe(false);
    expect(shouldRetargetToUsb({ ...base, errorMessage: null })).toBe(false);
  });

  it("ไม่มีเครื่อง USB ที่ใช้ได้ ก็ไม่ต้องสลับ", () => {
    expect(shouldRetargetToUsb({ ...base, devices: [] })).toBe(false);
    expect(shouldRetargetToUsb({ ...base, devices: [{ name: "POS-80C", isUsb: true, offline: true }] })).toBe(false);
    expect(shouldRetargetToUsb({ ...base, devices: [{ name: "Fax", isUsb: false, offline: false }] })).toBe(false);
  });

  it("Hub ออฟไลน์ / ร้านยังไม่ได้ตั้งเครื่องพิมพ์ USB → ไม่สลับ", () => {
    expect(shouldRetargetToUsb({ ...base, hubOnline: false })).toBe(false);
    expect(shouldRetargetToUsb({ ...base, hasHubUsbPrinter: false })).toBe(false);
  });

  it("แยกความล้มเหลวแบบติดต่อไม่ได้ออกจากแบบอื่น", () => {
    for (const m of ["Connection timed out (5000ms)", "connect ECONNREFUSED 192.168.1.42:9100", "socket hang up", "EHOSTUNREACH"]) {
      expect(isPrinterUnreachableError(m)).toBe(true);
    }
    for (const m of ["Out of paper", "Cover open", null, ""]) {
      expect(isPrinterUnreachableError(m)).toBe(false);
    }
  });

  it("อ่านรายการอุปกรณ์แบบทนข้อมูลไม่ครบ", () => {
    expect(hasUsableUsbDevice(null)).toBe(false);
    expect(hasUsableUsbDevice([{ name: "x" }])).toBe(false);
    expect(hasUsableUsbDevice([{ isUsb: true }])).toBe(true);
  });
});
