import { describe, it, expect, vi } from "vitest";
import {
  buildRawSpoolScript,
  normalizeWindowsPrinterName,
  parseWindowsPrinterList,
  pickUsbPrinter,
  printUsbJob,
  runPollCycle,
  sendToWindowsPrinter,
} from "../../scripts/print-hub.mjs";
import { validateHubUsbPrinterName } from "@/modules/printing/print-hub";
import { isHubReceiptPrinter } from "@/modules/printing/receipt-printer";
import type { Printer } from "@/modules/stores/types";

const usb = (name: string, port = "USB001", extra: Record<string, unknown> = {}) => ({
  name,
  port,
  isDefault: false,
  isUsb: true,
  offline: false,
  ...extra,
});

describe("Hub USB — ชื่อเครื่องพิมพ์ Windows (validator ฝั่ง server)", () => {
  it("ยอมรับชื่อที่ผู้ผลิตใช้จริง รวมภาษาไทย", () => {
    for (const name of ["XP-80C", "POS-58 Printer", "EPSON TM-T82X Receipt", "เครื่องพิมพ์หน้าร้าน"]) {
      expect(validateHubUsbPrinterName(name)).toEqual({ device: name });
    }
  });

  it("ว่าง/ไม่ระบุ = โหมดตรวจจับอัตโนมัติ ไม่ใช่ข้อผิดพลาด", () => {
    expect(validateHubUsbPrinterName("")).toEqual({ device: null });
    expect(validateHubUsbPrinterName("   ")).toEqual({ device: null });
    expect(validateHubUsbPrinterName(null)).toEqual({ device: null });
    expect(validateHubUsbPrinterName(undefined)).toEqual({ device: null });
  });

  it("ปฏิเสธชื่อที่แทรกคำสั่งเข้า PowerShell ได้", () => {
    // ชื่อจะถูกวางในสตริงเดี่ยวของ PowerShell — quote/backtick/$/; ต้องไม่ผ่านตั้งแต่ต้นทาง
    for (const bad of [
      "XP-80'; Remove-Item C:\\ -Recurse; '",
      'printer"; calc; "',
      "printer`ncalc",
      "printer$(calc)",
      "printer; calc",
      "printer|calc",
      "a".repeat(129),
    ]) {
      expect(validateHubUsbPrinterName(bad).error).toBeTruthy();
      expect(validateHubUsbPrinterName(bad).device).toBeUndefined();
    }
  });

  it("agent normalize ซ้ำอีกชั้น — ชื่ออันตรายไม่ถูกส่งเข้า spooler", async () => {
    expect(normalizeWindowsPrinterName("XP-80C")).toBe("XP-80C");
    expect(normalizeWindowsPrinterName("bad'; calc; '")).toBeNull();
    await expect(sendToWindowsPrinter("bad'; calc; '", Buffer.from("x"))).rejects.toThrow(/Invalid or disallowed/);
  });
});

describe("Hub USB — ตรวจจับเครื่องพิมพ์ที่เสียบอยู่", () => {
  it("อ่านผล Get-CimInstance ได้ทั้งกรณี array และ object เดี่ยว", () => {
    const one = parseWindowsPrinterList(
      JSON.stringify({ Name: "XP-80C", PortName: "USB001", Default: true, WorkOffline: false }),
    );
    expect(one).toEqual([{ name: "XP-80C", port: "USB001", isDefault: true, isUsb: true, offline: false }]);

    const many = parseWindowsPrinterList(
      JSON.stringify([
        { Name: "XP-80C", PortName: "USB001", Default: false, WorkOffline: false },
        { Name: "Microsoft Print to PDF", PortName: "PORTPROMPT:", Default: true, WorkOffline: false },
      ]),
    );
    expect(many.map((p: { name: string }) => p.name)).toEqual(["XP-80C", "Microsoft Print to PDF"]);
    expect(many[1].isUsb).toBe(false);
  });

  it("stdout ที่ไม่ใช่ JSON (เช่น ไม่ใช่ Windows) ไม่ทำให้พัง", () => {
    expect(parseWindowsPrinterList("")).toEqual([]);
    expect(parseWindowsPrinterList("command not found")).toEqual([]);
  });

  it("เลือกเครื่องพิมพ์ใบเสร็จที่ต่อ USB ก่อนเครื่องพิมพ์ตัวอื่น", () => {
    const list = [
      { name: "Microsoft Print to PDF", port: "PORTPROMPT:", isDefault: true, isUsb: false, offline: false },
      { name: "Brother DCP-T220", port: "USB005", isDefault: false, isUsb: true, offline: false },
      usb("XP-80C", "USB001"),
    ];
    expect(pickUsbPrinter(list, null).name).toBe("XP-80C");
  });

  it("ไม่เดาเครื่องพิมพ์เสมือน/แฟกซ์ แม้เป็นค่าเริ่มต้นของ Windows", () => {
    const list = [
      { name: "Microsoft Print to PDF", port: "PORTPROMPT:", isDefault: true, isUsb: false, offline: false },
      { name: "Canon E4500 series FAX", port: "USB007", isDefault: false, isUsb: true, offline: false },
    ];
    expect(pickUsbPrinter(list, null)).toBeNull();
  });

  it("ชื่อที่ร้านตั้งไว้ชนะเสมอถ้ายังเสียบอยู่", () => {
    const list = [usb("XP-80C", "USB001"), usb("POS-58", "USB002")];
    expect(pickUsbPrinter(list, "POS-58").name).toBe("POS-58");
  });

  it("ชื่อที่ตั้งไว้หายไป (ถอดสาย/ย้ายพอร์ต) → ตกไปตรวจจับอัตโนมัติแทนที่จะพัง", () => {
    const list = [usb("XP-80C", "USB003")];
    expect(pickUsbPrinter(list, "เครื่องเก่าที่ถอดไปแล้ว").name).toBe("XP-80C");
  });

  it("ในระดับเดียวกัน เครื่องที่ออนไลน์ชนะเครื่องที่ปิดอยู่", () => {
    const list = [usb("Brother DCP-T220", "USB005", { offline: true }), usb("Canon E4500 series", "USB004")];
    expect(pickUsbPrinter(list, null).name).toBe("Canon E4500 series");
  });

  it("ไม่มีเครื่องพิมพ์เลย → คืน null (ให้ job รายงานสาเหตุที่แก้ได้)", () => {
    expect(pickUsbPrinter([], null)).toBeNull();
    expect(pickUsbPrinter(null, null)).toBeNull();
  });
});

describe("Hub USB — พิมพ์งาน", () => {
  it("โหมดตรวจจับอัตโนมัติเลือกเครื่องพิมพ์ใหม่ทุกครั้งที่พิมพ์", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const chosen = await printUsbJob(null, Buffer.from("x"), { printers: [usb("XP-80C")], send });
    expect(chosen.name).toBe("XP-80C");
    expect(send).toHaveBeenCalledWith("XP-80C", expect.any(Buffer));
  });

  it("ไม่พบเครื่องพิมพ์ → error ภาษาไทยที่บอกวิธีแก้ ไม่ใช่สำเร็จแบบเงียบ", async () => {
    await expect(printUsbJob(null, Buffer.from("x"), { printers: [], send: vi.fn() })).rejects.toThrow(
      /เสียบสาย USB/,
    );
    await expect(printUsbJob("POS-58", Buffer.from("x"), { printers: [], send: vi.fn() })).rejects.toThrow(
      /ไม่พบเครื่องพิมพ์/,
    );
  });

  it("ส่งไบต์ ESC/POS ดิบผ่าน spooler ด้วย datatype RAW (ไม่ใช่ GDI/ข้อความ)", () => {
    const script = buildRawSpoolScript("XP-80C", "C:\\Temp\\job.bin");
    expect(script).toContain("winspool.drv");
    expect(script).toContain('pDataType="RAW"');
    expect(script).toContain("StartDocPrinter");
    expect(script).toContain("WritePrinter");
    expect(script).toContain("[StoreOsRawPrint]::Send('XP-80C'");
    // ตัวปิด here-string ต้องขึ้นบรรทัดใหม่ ไม่งั้น PowerShell parse ไม่ผ่าน
    expect(script).toContain("\n'@\n");
  });
});

describe("Hub USB — เส้นทางคิวงานพิมพ์", () => {
  const config = { serverUrl: "https://hub.example", storeId: "store-1", hubToken: "secret" };
  const jsonResponse = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });

  it("agent รายงานเครื่องพิมพ์ที่สแกนเจอไปกับ poll (ให้หน้า Settings แสดงรายการ)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true, jobs: [] }));
    await runPollCycle({
      config,
      fetchImpl,
      printJob: vi.fn(),
      listDevices: async () => [usb("XP-80C")],
    });
    const pollBody = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(pollBody.devices).toEqual([usb("XP-80C")]);
  });

  it("สแกนไม่ได้ ก็ยัง poll งานพิมพ์ต่อ (การสแกนล้มไม่ทำให้ Hub ตาย)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true, jobs: [] }));
    const result = await runPollCycle({
      config,
      fetchImpl,
      printJob: vi.fn(),
      listDevices: async () => { throw new Error("no powershell"); },
    });
    expect(result.ok).toBe(true);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).devices).toBeUndefined();
  });

  it("พิมพ์งาน usb แล้ว ack กลับพร้อมชื่อเครื่องพิมพ์ที่เลือกจริง", async () => {
    const job = {
      id: "job-usb",
      kind: "usb",
      device: null,
      printJobBase64: Buffer.from("x").toString("base64"),
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, jobs: [job] }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const printJob = vi.fn().mockResolvedValue({ name: "XP-80C", port: "USB001" });

    const result = await runPollCycle({ config, fetchImpl, printJob, listDevices: async () => [] });

    expect(result).toEqual({ ok: true, processed: 1 });
    expect(printJob).toHaveBeenCalledWith({ kind: "usb", device: null }, expect.any(Buffer));
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toMatchObject({
      jobId: "job-usb",
      ok: true,
      kind: "usb",
      target: "XP-80C",
    });
  });

  it("พิมพ์ไม่สำเร็จ → ack ว่าไม่สำเร็จพร้อมเหตุผล (ไม่รายงานสำเร็จหลอก)", async () => {
    const job = { id: "job-usb-2", kind: "usb", printJobBase64: Buffer.from("x").toString("base64") };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, jobs: [job] }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const printJob = vi.fn().mockRejectedValue(new Error("OpenPrinter failed: 1801"));

    await runPollCycle({ config, fetchImpl, printJob, listDevices: async () => [] });

    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toMatchObject({
      ok: false,
      error: "OpenPrinter failed: 1801",
    });
  });
});

describe("Hub USB — การเลือกเส้นทางฝั่ง POS", () => {
  const base: Printer = {
    id: "p1",
    storeId: "s1",
    organizationId: "o1",
    name: "เครื่องพิมพ์",
    type: "usb",
    isDefault: true,
    paperWidth: "80mm",
    createdAt: "2026-09-03T00:00:00Z",
    updatedAt: "2026-09-03T00:00:00Z",
  };

  it("เครื่องพิมพ์ USB ผ่าน Hub เข้าคิวเซิร์ฟเวอร์ (แท็บเล็ต/iPad สั่งพิมพ์ได้ด้วย)", () => {
    expect(isHubReceiptPrinter({ ...base, hubUsbEnabled: true })).toBe(true);
  });

  it("เครื่องพิมพ์ USB แบบเดิม (WebUSB ตรงจากเบราว์เซอร์) พฤติกรรมไม่เปลี่ยน", () => {
    expect(isHubReceiptPrinter(base)).toBe(false);
    expect(isHubReceiptPrinter({ ...base, hubUsbEnabled: false })).toBe(false);
  });
});
