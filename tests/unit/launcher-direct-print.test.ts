// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  POS_CHANNEL,
  __resetPosLauncherForTests,
  assertDirectPrinted,
  isDirectPrintAvailable,
  isDirectPrintablePrinter,
  parseDirectPrintResult,
  printDirect,
} from "@/modules/printing/launcher-direct-print";
import { enqueueReceiptPrintJob, sendNetworkPrintJob } from "@/modules/printing/network-print-client";

vi.mock("@/modules/printing/receipt-printer-bytes", () => ({
  buildReceiptPrinterBytes: vi.fn(async () => new Uint8Array([0x1b, 0x40])),
}));

type Listener = (event: { data: unknown }) => void;

/** POS Launcher ปลอม: ตอบ hello และผลการพิมพ์ตามที่กำหนด */
function installFakeLauncher(opts: { hello?: boolean; outcome?: "printed" | "failed" | "unknown" | null } = {}) {
  const listeners: Listener[] = [];
  const posted: Record<string, unknown>[] = [];
  const emit = (data: unknown) => setTimeout(() => listeners.forEach((l) => l({ data })), 0);
  (window as unknown as { chrome: unknown }).chrome = {
    webview: {
      addEventListener: (_t: string, l: Listener) => listeners.push(l),
      postMessage: (message: Record<string, unknown>) => {
        posted.push(message);
        if (message.channel !== POS_CHANNEL) return;
        if (message.type === "hello.request" && opts.hello !== false) {
          emit({ channel: POS_CHANNEL, type: "hello", version: "1.0.0", capabilities: ["print.direct"] });
        }
        if (message.type === "print.job" && opts.outcome) {
          emit({ channel: POS_CHANNEL, type: "print.result", jobId: message.jobId, outcome: opts.outcome, error: opts.outcome === "printed" ? null : "เครื่องพิมพ์ไม่ตอบ", attempts: 1, elapsedMs: 1400 });
        }
      },
    },
  };
  return posted;
}

const ipPrinter = { id: "p1", type: "ip", ipAddress: "192.168.1.20", port: 9100, paperWidth: "80mm" } as never;
const receipt = { orderNumber: "261126-0042" } as never;

describe("launcher direct print (storeos.pos)", () => {
  beforeEach(() => __resetPosLauncherForTests());
  afterEach(() => {
    delete (window as unknown as { chrome?: unknown }).chrome;
    vi.useRealTimers();
  });

  it("เบราว์เซอร์ปกติ (ไม่มี chrome.webview) = ไม่ใช่ POS Launcher", async () => {
    expect(await isDirectPrintAvailable()).toBe(false);
  });

  it("Launcher เดิมที่ไม่ตอบช่อง storeos.pos = ไม่ใช้ทางตรง (หมดเวลา hello)", async () => {
    installFakeLauncher({ hello: false });
    expect(await isDirectPrintAvailable()).toBe(false);
  });

  it("POS Launcher ตอบ hello → ส่ง print.job พร้อม IP/ไบต์ แล้วรอผลตาม jobId", async () => {
    const posted = installFakeLauncher({ outcome: "printed" });
    expect(await isDirectPrintAvailable()).toBe(true);
    const result = await printDirect({ host: "192.168.1.20", bytesBase64: "G0A=", kind: "receipt", label: "#42" });
    expect(result.outcome).toBe("printed");
    const job = posted.find((m) => m.type === "print.job")!;
    expect(job).toMatchObject({ host: "192.168.1.20", port: 9100, bytesBase64: "G0A=", kind: "receipt" });
    expect(typeof job.jobId).toBe("string");
  });

  it("ใบเสร็จ (enqueueReceiptPrintJob) ในโปรแกรม = พิมพ์ตรง ไม่เรียก /api/print/enqueue", async () => {
    installFakeLauncher({ outcome: "printed" });
    const fetcher = vi.fn();
    const res = await enqueueReceiptPrintJob("p1", receipt, { fetcher: fetcher as never, printer: ipPrinter });
    expect(res).toEqual({ hubOnline: true, direct: true });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("พิมพ์ตรงล้ม = โยน error ไม่ส่งต่อเข้า Hub (กันใบซ้ำ)", async () => {
    installFakeLauncher({ outcome: "unknown" });
    const fetcher = vi.fn();
    await expect(
      sendNetworkPrintJob(ipPrinter, { printerId: "p1", receiptData: receipt, printJobBase64: "G0A=" }, { fetcher: fetcher as never, hostname: "www.store-os.online" }),
    ).rejects.toThrow("ตรวจกระดาษก่อนกดพิมพ์ซ้ำ");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("นอกโปรแกรม = ทางเดิม (เข้าคิว Hub)", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ hubOnline: true }), { status: 200 }));
    const res = await enqueueReceiptPrintJob("p1", receipt, { fetcher: fetcher as never, printer: ipPrinter });
    expect(res.hubOnline).toBe(true);
    expect(fetcher).toHaveBeenCalledWith("/api/print/enqueue", expect.anything());
  });

  it("เรียกพร้อมกันหลายจุด = ส่ง hello ครั้งเดียว", async () => {
    const posted = installFakeLauncher();
    const both = await Promise.all([isDirectPrintAvailable(), isDirectPrintAvailable()]);
    expect(both).toEqual([true, true]);
    expect(posted.filter((m) => m.type === "hello.request")).toHaveLength(1);
  });

  it("hello หมดเวลา (โปรแกรมยังไม่พร้อม) → ถามใหม่ได้หลัง 10 วิ ไม่ค้าง false ทั้งหน้า", async () => {
    const posted = installFakeLauncher({ hello: false });
    expect(await isDirectPrintAvailable()).toBe(false);
    const now = Date.now();
    const spy = vi.spyOn(Date, "now").mockReturnValue(now + 11_000);
    await isDirectPrintAvailable();
    expect(posted.filter((m) => m.type === "hello.request")).toHaveLength(2);
    spy.mockRestore();
  });

  it("เครื่องพิมพ์ที่พิมพ์ตรงได้ = IP/escpos ที่มี IP เท่านั้น", () => {
    expect(isDirectPrintablePrinter({ type: "ip", ipAddress: "192.168.1.20" } as never)).toBe(true);
    expect(isDirectPrintablePrinter({ type: "usb", ipAddress: null } as never)).toBe(false);
    expect(isDirectPrintablePrinter({ type: "ip", ipAddress: null } as never)).toBe(false);
  });

  it("ไม่ได้ผลกลับ = unknown (ห้ามพิมพ์ซ้ำอัตโนมัติ)", () => {
    expect(parseDirectPrintResult(null).outcome).toBe("unknown");
    expect(parseDirectPrintResult({ outcome: "weird" }).outcome).toBe("unknown");
    expect(() => assertDirectPrinted({ outcome: "failed", error: "ไม่ตอบ", attempts: 3, elapsedMs: 0 })).toThrow("ไม่ตอบ");
  });
});
