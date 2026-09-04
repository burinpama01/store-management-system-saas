import { describe, it, expect, vi } from "vitest";
import {
  classifyPrintOutcome,
  isEligibleReceiptCandidate,
  printUsbJob,
  mergePrinterIdentities,
  parsePnpPrinterDevices,
  parseWindowsPrinterList,
  selectUsbPrinter,
} from "../../scripts/print-hub.mjs";

// v3 Task 5 — selection engine ที่ไม่มี Windows default เป็น fallback
// กติกาที่ต้องพิสูจน์ (แผน v3 §4):
//   * เครื่องพิมพ์เริ่มต้นของ Windows ไม่มีคะแนนในการเลือกเลย (แค่แสดงผลได้)
//   * identity เดิมชนะทุกอย่าง แม้ย้ายพอร์ต USB หรือชื่อคิวเปลี่ยน
//   * หลายตัว / รุ่นเดียวกันไม่มี serial = ambiguous ห้ามพิมพ์
//   * ทุกผลลัพธ์มี reason code ให้ผู้ใช้อ่านออกว่าทำไมถึงเลือก/ไม่เลือก

type FakePrinter = {
  name: string;
  port?: string;
  isDefault?: boolean;
  offline?: boolean;
  identity?: Record<string, unknown>;
};

const p = (name: string, port = "USB001", extra: Partial<FakePrinter> = {}): FakePrinter => ({
  name,
  port,
  isDefault: false,
  offline: false,
  ...extra,
});

const EPSON_PNP = "USB\\VID_04B8&PID_0E15\\583132593034323734";

describe("selectUsbPrinter — ไม่ใช้เครื่องพิมพ์เริ่มต้นของ Windows", () => {
  it("เครื่องพิมพ์ A4 ที่เป็น default ของ Windows ไม่ถูกเลือก", () => {
    const list = [p("HP LaserJet MFP M141", "USB002", { isDefault: true })];
    expect(selectUsbPrinter(list, {})).toEqual({ printer: null, reason: "unavailable" });
  });

  it("PDF/XPS/FAX ที่เป็น default ไม่ถูกเลือกแม้ไม่มีตัวเลือกอื่น", () => {
    const list = [
      p("Microsoft Print to PDF", "PORTPROMPT:", { isDefault: true }),
      p("Fax", "SHRFAX:", { isDefault: true }),
    ];
    expect(selectUsbPrinter(list, {}).printer).toBeNull();
  });

  it("เครื่องพิมพ์ใบเสร็จ USB ตัวเดียว = ผูกอัตโนมัติพร้อมเหตุผล", () => {
    const list = [p("Microsoft Print to PDF", "PORTPROMPT:", { isDefault: true }), p("XP-80C", "USB001")];
    expect(selectUsbPrinter(list, {})).toEqual({ printer: list[1], reason: "auto_single" });
  });

  it("เครื่องพิมพ์ใบเสร็จสองตัว = ambiguous (ให้คนเลือก ห้ามเดา)", () => {
    const list = [p("XP-80C", "USB001"), p("RONGTA 58", "USB003")];
    expect(selectUsbPrinter(list, {})).toEqual({ printer: null, reason: "ambiguous" });
  });

  it("เครื่องใบเสร็จ 1 ตัว + เครื่องเอกสาร 1 ตัว = เลือกเครื่องใบเสร็จ", () => {
    const list = [p("Brother DCP-T220", "USB005"), p("POS-58", "USB001")];
    expect(selectUsbPrinter(list, {}).printer?.name).toBe("POS-58");
  });
});

describe("selectUsbPrinter — identity ที่เสถียร", () => {
  it("identity เดิมตรง = reconnect แม้ชื่อคิวและพอร์ตเปลี่ยน", () => {
    const list = [
      p("POS-58", "USB001"),
      p("EPSON TM-T82III Receipt (Copy 1)", "USB004", { identity: { pnpDeviceId: EPSON_PNP } }),
    ];
    const result = selectUsbPrinter(list, { identity: { pnpDeviceId: EPSON_PNP }, name: "EPSON TM-T82III Receipt" });
    expect(result.reason).toBe("exact_reconnect");
    expect(result.printer?.port).toBe("USB004");
  });

  it("VID/PID + serial ตรงและมีตัวเดียว = identity_match", () => {
    const list = [p("Thermal Printer", "USB002", { identity: { vid: "04B8", pid: "0E15", serial: "SN123" } })];
    const result = selectUsbPrinter(list, { identity: { vid: "04B8", pid: "0E15", serial: "SN123" } });
    expect(result.reason).toBe("identity_match");
  });

  it("รุ่นเดียวกันสองเครื่องแต่ไม่มี serial = ambiguous", () => {
    const list = [
      p("XP-80C", "USB001", { identity: { vid: "0483", pid: "5743", serial: null } }),
      p("XP-80C (Copy 1)", "USB002", { identity: { vid: "0483", pid: "5743", serial: null } }),
    ];
    expect(selectUsbPrinter(list, { identity: { vid: "0483", pid: "5743", serial: null } }).reason).toBe("ambiguous");
  });

  it("ชื่อที่ร้านผูกไว้ยังใช้ได้ (binding เดิมก่อนมี identity)", () => {
    const list = [p("XP-80C", "USB001"), p("POS-58", "USB002")];
    expect(selectUsbPrinter(list, { name: "POS-58" })).toEqual({ printer: list[1], reason: "legacy_name" });
  });
});

describe("selectUsbPrinter — binding policy", () => {
  it("confirm_multi ไม่ผูกให้เองแม้พบเครื่องเดียว", () => {
    expect(selectUsbPrinter([p("XP-80C")], { policy: "confirm_multi" })).toEqual({
      printer: null,
      reason: "ambiguous",
    });
  });

  it("manual ต้องมีชื่อ/identity เท่านั้น", () => {
    expect(selectUsbPrinter([p("XP-80C")], { policy: "manual" })).toEqual({
      printer: null,
      reason: "manual_required",
    });
    expect(selectUsbPrinter([p("XP-80C")], { policy: "manual", name: "XP-80C" }).reason).toBe("legacy_name");
  });

  it("manual + เครื่องที่ผูกไว้หายไป = ไม่เดาตัวอื่นให้", () => {
    const result = selectUsbPrinter([p("POS-58")], { policy: "manual", name: "XP-80C" });
    expect(result).toEqual({ printer: null, reason: "unavailable" });
  });

  it("auto_single: เครื่องที่ผูกไว้หายไปแล้วมีตัวเดียวเสียบอยู่ → เลือกตัวนั้น", () => {
    const result = selectUsbPrinter([p("POS-58")], { name: "เครื่องเก่าที่ถอดไปแล้ว" });
    expect(result.reason).toBe("auto_single");
  });

  it("ออนไลน์ชนะออฟไลน์เมื่ออยู่ระดับเดียวกัน", () => {
    const list = [p("XP-80C", "USB001", { offline: true }), p("POS-58", "USB002")];
    expect(selectUsbPrinter(list, {}).printer?.name).toBe("POS-58");
  });
});

describe("การอ่าน identity จากผลสแกนของ Windows", () => {
  const payload = {
    printers: [
      {
        Name: "EPSON TM-T82III Receipt",
        PortName: "USB001",
        Default: false,
        WorkOffline: false,
        DriverName: "EPSON TM-T82III ReceiptE4",
      },
    ],
    devices: [{ Name: "EPSON TM-T82III Receipt", PNPDeviceID: EPSON_PNP }],
  };

  it("แยก VID/PID/serial ออกจาก PNPDeviceID ได้", () => {
    const [device] = parsePnpPrinterDevices(payload.devices);
    expect(device).toMatchObject({ pnpDeviceId: EPSON_PNP, vid: "04B8", pid: "0E15", serial: "583132593034323734" });
  });

  it("instance number ที่ Windows ตั้งเอง (ขึ้นต้นด้วย &) ไม่ถูกนับเป็น serial", () => {
    const [device] = parsePnpPrinterDevices([
      { Name: "Generic Printer", PNPDeviceID: "USB\\VID_0483&PID_5743\\&2a1b3c4d&0&0002" },
    ]);
    expect(device.serial).toBeNull();
    expect(device.vid).toBe("0483");
  });

  it("จับคู่คิวเครื่องพิมพ์กับอุปกรณ์ USB แล้วแนบ identity", () => {
    const merged = mergePrinterIdentities(
      parseWindowsPrinterList(JSON.stringify(payload)),
      parsePnpPrinterDevices(payload.devices),
    );
    expect(merged[0].identity).toMatchObject({ v: 1, pnpDeviceId: EPSON_PNP, vid: "04B8", pid: "0E15" });
  });

  it("จับคู่ไม่ได้ก็ยังทำงานต่อด้วยชื่อคิวเหมือนเดิม", () => {
    const merged = mergePrinterIdentities(parseWindowsPrinterList(JSON.stringify(payload)), []);
    expect(merged[0].identity).toBeUndefined();
    expect(selectUsbPrinter(merged, {}).reason).toBe("auto_single");
  });

  it("เกณฑ์ eligible ตัดพอร์ตเสมือนและอุปกรณ์ที่ไม่ใช่ USB ออก", () => {
    expect(isEligibleReceiptCandidate(p("XP-80C", "USB001"))).toBe(true);
    expect(isEligibleReceiptCandidate(p("Printer on 192.168.1.50", "IP_192.168.1.50"))).toBe(false);
    expect(isEligibleReceiptCandidate(p("Microsoft XPS Document Writer", "PORTPROMPT:"))).toBe(false);
  });
});

describe("printUsbJob — ใช้ binding จากเซิร์ฟเวอร์ และบอกเหตุผลเมื่อเลือกไม่ได้", () => {
  it("เลือกด้วย identity แล้วส่งไบต์เข้า spooler ของเครื่องนั้น", async () => {
    const printers = [
      { name: "POS-58", port: "USB001" },
      { name: "TM-T82 (Copy 1)", port: "USB004", identity: { pnpDeviceId: EPSON_PNP } },
    ];
    const send = vi.fn().mockResolvedValue(undefined);
    const chosen = await printUsbJob(
      { name: "TM-T82", identity: { pnpDeviceId: EPSON_PNP }, policy: "auto_single" },
      Buffer.from("x"),
      { printers, send },
    );
    expect(send).toHaveBeenCalledWith("TM-T82 (Copy 1)", expect.any(Buffer));
    expect(chosen.reason).toBe("exact_reconnect");
  });

  it("กำกวม = ไม่พิมพ์ และบอกให้ไปเลือกเครื่องในหน้าตั้งค่า", async () => {
    const printers = [
      { name: "XP-80C", port: "USB001" },
      { name: "RONGTA 58", port: "USB002" },
    ];
    const send = vi.fn();
    await expect(printUsbJob({ policy: "auto_single" }, Buffer.from("x"), { printers, send })).rejects.toThrow(
      /มากกว่าหนึ่งเครื่อง/,
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("เลือกปลายทางไม่ได้ = failed (ยังไม่ได้ส่งไบต์) ไม่ใช่ unknown", async () => {
    try {
      await printUsbJob({ policy: "manual" }, Buffer.from("x"), { printers: [{ name: "XP-80C", port: "USB001" }] });
      throw new Error("should not reach");
    } catch (error) {
      expect(classifyPrintOutcome(error)).toBe("failed");
    }
  });
});

describe("binding policy — ค่าที่มาจากฟอร์ม/ฐานข้อมูล", () => {
  it("รับเฉพาะสามค่าที่รู้จัก ที่เหลือตกมาที่ค่าปลอดภัยสุด", async () => {
    const { parseUsbBindingPolicy, HUB_USB_BINDING_POLICIES } = await import("@/modules/printing/print-hub");

    expect(parseUsbBindingPolicy("confirm_multi")).toBe("confirm_multi");
    expect(parseUsbBindingPolicy("manual")).toBe("manual");
    expect(parseUsbBindingPolicy("auto_single")).toBe("auto_single");
    // ค่าแปลก/ว่าง = auto_single (พฤติกรรมเดิมของร้าน ไม่ใช่หยุดพิมพ์)
    expect(parseUsbBindingPolicy("' OR 1=1")).toBe("auto_single");
    expect(parseUsbBindingPolicy(null)).toBe("auto_single");
    expect(parseUsbBindingPolicy(undefined)).toBe("auto_single");

    // ตัวเลือกที่โชว์บนหน้าจอต้องครบทุกค่าที่ selection engine รู้จัก
    expect(HUB_USB_BINDING_POLICIES.map((option) => option.value)).toEqual([
      "auto_single",
      "confirm_multi",
      "manual",
    ]);
  });
});
