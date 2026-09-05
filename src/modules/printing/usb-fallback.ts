/**
 * พิมพ์ไม่ออกเพราะเครื่องพิมพ์ตัวที่ตั้งไว้ไม่อยู่แล้ว — สลับไปเครื่อง USB ที่เสียบอยู่ให้เอง
 *
 * เคสจริง (ร้าน each other II, 2026-09-05): ร้านย้ายจากเครื่องพิมพ์ WiFi มาเป็น USB
 * แต่ค่าเริ่มต้นยังชี้ไปที่ 192.168.1.42 ใบเสร็จทุกใบจึง "Connection timed out" เงียบ ๆ
 * ทั้งที่ POS-80C เสียบอยู่บน USB003 และ Hub เห็นอยู่ตลอด
 *
 * กติกาที่ตั้งใจให้แคบไว้ เพราะการเดาผิดแปลว่าใบเสร็จออกผิดเครื่องโดยไม่มีใครรู้:
 *   - สลับเฉพาะงานที่ยิงออกนอกเครื่อง (ip / bt) เท่านั้น — งาน usb ที่ล้มจะไม่ถูกสลับต่อ
 *     จึงสลับได้อย่างมากหนึ่งทอด ไม่มีทางวนเป็นลูป
 *   - สลับเฉพาะความล้มเหลว "ติดต่อเครื่องพิมพ์ไม่ได้" ไม่ใช่กระดาษหมด/ฝาเปิด
 *     ซึ่งการส่งไปอีกเครื่องไม่ได้ช่วยอะไรและอาจได้ใบซ้ำ
 *   - ต้องมีเครื่องพิมพ์ USB ที่ Hub เห็นว่าเสียบอยู่จริงในรอบล่าสุดเท่านั้น
 */

/** ข้อความผิดพลาดที่แปลว่า "ไปไม่ถึงเครื่องพิมพ์" ไม่ใช่ "เครื่องพิมพ์มีปัญหา" */
const UNREACHABLE_PATTERNS = [
  /timed out/i,
  /timeout/i,
  /ECONNREFUSED/i,
  /ECONNRESET/i,
  /EHOSTUNREACH/i,
  /ENETUNREACH/i,
  /ENOTFOUND/i,
  /EPIPE/i,
  /socket hang up/i,
  /ติดต่อเครื่องพิมพ์ไม่ได้/,
];

export function isPrinterUnreachableError(message: string | null | undefined): boolean {
  if (!message) return false;
  return UNREACHABLE_PATTERNS.some((pattern) => pattern.test(message));
}

export interface HubDeviceLike {
  readonly name?: string | null;
  readonly isUsb?: boolean | null;
  readonly offline?: boolean | null;
}

/** Hub เห็นเครื่องพิมพ์ USB ที่พร้อมใช้อยู่จริงไหมในรอบรายงานล่าสุด */
export function hasUsableUsbDevice(devices: readonly HubDeviceLike[] | null | undefined): boolean {
  if (!devices) return false;
  return devices.some((device) => device?.isUsb === true && device?.offline !== true);
}

export interface UsbFallbackDecisionInput {
  /** ชนิดปลายทางของงานที่เพิ่งล้ม */
  readonly failedKind: string | null;
  readonly errorMessage: string | null;
  /** Hub ยัง poll อยู่ไหม (ถ้าไม่ ก็ไม่มีใครพิมพ์ให้อยู่ดี) */
  readonly hubOnline: boolean;
  readonly devices: readonly HubDeviceLike[] | null;
  /** ร้านนี้ตั้งเครื่องพิมพ์ USB ผ่าน Hub ไว้หรือยัง */
  readonly hasHubUsbPrinter: boolean;
}

export function shouldRetargetToUsb(input: UsbFallbackDecisionInput): boolean {
  if (input.failedKind === "usb") return false; // กันวน — สลับได้ทอดเดียว
  if (!input.hasHubUsbPrinter) return false;
  if (!input.hubOnline) return false;
  if (!hasUsableUsbDevice(input.devices)) return false;
  return isPrinterUnreachableError(input.errorMessage);
}
