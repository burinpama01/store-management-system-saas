import { describe, it, expect } from "vitest";
import {
  describeUsbError,
  isUsbAccessDeniedError,
  USB_ACCESS_DENIED_MESSAGE,
} from "@/modules/printing/usb-client";

/**
 * อาการจริงหน้าร้าน: กดปุ่ม USB บนพีซี Windows แล้วได้
 * "Failed to execute 'open' on 'USBDevice': Access denied."
 * ซึ่งไม่บอกสาเหตุและไม่บอกทางแก้ แคชเชียร์จึงได้แต่กดซ้ำทั้งที่ไม่มีวันติด
 */
describe("แปล error ของ WebUSB ให้ผู้ใช้ทำอะไรต่อได้", () => {
  it("จับกรณีที่ Windows ยึดอุปกรณ์ไว้ (ข้อความ/ชื่อ error ที่เบราว์เซอร์ใช้จริง)", () => {
    const raw = new Error("Failed to execute 'open' on 'USBDevice': Access denied.");
    expect(isUsbAccessDeniedError(raw)).toBe(true);

    const securityError = new Error("blocked");
    securityError.name = "SecurityError";
    expect(isUsbAccessDeniedError(securityError)).toBe(true);

    const notAllowed = new Error("blocked");
    notAllowed.name = "NotAllowedError";
    expect(isUsbAccessDeniedError(notAllowed)).toBe(true);
  });

  it("ข้อความที่ได้ต้องบอกว่ากดซ้ำไม่ช่วย และชี้ไปที่ Print Hub", () => {
    const raw = new Error("Failed to execute 'open' on 'USBDevice': Access denied.");
    const message = describeUsbError(raw);
    expect(message).toBe(USB_ACCESS_DENIED_MESSAGE);
    expect(message).toContain("Print Hub");
    expect(message).toContain("กดซ้ำก็ไม่หาย");
    // ห้ามโยนข้อความดิบของเบราว์เซอร์ให้ผู้ใช้อ่านเอง
    expect(message).not.toContain("USBDevice");
  });

  it("ปิดหน้าต่างเลือกอุปกรณ์ = บอกให้เลือกใหม่ ไม่ใช่ error น่ากลัว", () => {
    const cancelled = new Error("No device selected.");
    cancelled.name = "NotFoundError";
    expect(describeUsbError(cancelled)).toContain("เลือกจากรายการอุปกรณ์");
    expect(isUsbAccessDeniedError(cancelled)).toBe(false);
  });

  it("error อื่นยังคงข้อความเดิมไว้ (ไม่กลบสาเหตุจริง)", () => {
    expect(describeUsbError(new Error("ไม่พบ endpoint สำหรับส่งข้อมูลไปเครื่องพิมพ์"))).toBe(
      "ไม่พบ endpoint สำหรับส่งข้อมูลไปเครื่องพิมพ์",
    );
    expect(describeUsbError("อะไรก็ไม่รู้")).toBe("เชื่อมต่อ USB ไม่สำเร็จ");
  });
});
