import type { Printer } from "@/modules/stores/types";
import type { ReceiptData } from "./types";
import { bytesToBase64 } from "./print-job-base64";
import { buildReceiptPrinterBytes } from "./receipt-printer-bytes";
import { assertDirectPrinted, isDirectPrintAvailable, isDirectPrintablePrinter, printDirect } from "./launcher-direct-print";

export const DEFAULT_LOCAL_PRINT_BRIDGE_URL = "http://127.0.0.1:17878";

export interface NetworkPrintPayload {
  printerId: string;
  receiptData: ReceiptData;
  printJobBase64: string;
}

type Fetcher = typeof fetch;

interface SendNetworkPrintJobOptions {
  fetcher?: Fetcher;
  hostname?: string;
  bridgeUrl?: string;
}

function getBrowserHostname() {
  return typeof window === "undefined" ? "localhost" : window.location.hostname;
}

function getConfiguredBridgeUrl() {
  if (typeof window === "undefined") return DEFAULT_LOCAL_PRINT_BRIDGE_URL;
  const stored = window.localStorage.getItem("storeos.printBridgeUrl")?.trim();
  return (stored || process.env.NEXT_PUBLIC_PRINT_BRIDGE_URL || DEFAULT_LOCAL_PRINT_BRIDGE_URL).replace(/\/+$/, "");
}

function isPrivateLanHostname(hostname: string) {
  return (
    /^(10)\.(\d{1,3}\.){2}\d{1,3}$/.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\.(\d{1,3}\.)\d{1,3}$/.test(hostname) ||
    /^192\.168\.(\d{1,3}\.)\d{1,3}$/.test(hostname)
  );
}

function parseErrorBody(body: unknown) {
  if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
    return body.error;
  }
  return null;
}

export function shouldUseLocalPrintBridge(hostname: string) {
  const normalized = hostname.trim().toLowerCase();
  return normalized !== "localhost" && normalized !== "127.0.0.1" && normalized !== "::1" && !isPrivateLanHostname(normalized);
}

export function localPrintBridgeUnavailableMessage() {
  return "เครื่องพิมพ์ WiFi บน production ต้องเปิด StoreOS Print Bridge บนเครื่องแคชเชียร์ก่อน แล้วลองพิมพ์ใหม่";
}

export function printHubUnavailableMessage() {
  return "ส่งงานพิมพ์ไม่สำเร็จ: เปิด StoreOS Print Hub บนเครื่องแคชเชียร์ของร้าน แล้วลองพิมพ์ใหม่อีกครั้ง";
}

async function postJson(fetcher: Fetcher, url: string, body: unknown) {
  const res = await fetcher(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new Error(parseErrorBody(json) ?? `เชื่อมต่อ IP / WiFi ไม่สำเร็จ (${res.status})`);
  }
}

/**
 * Renders a receipt to raster bytes and enqueues it to the store's Print Hub by
 * printer id. The enqueue endpoint decides the transport from the printer type
 * (LAN TCP for ip/escpos, COM/Bluetooth for bluetooth-via-Hub), so this works
 * for any Hub-capable printer and on tablets/iPad that cannot print directly.
 */
export async function enqueueReceiptPrintJob(
  printerId: string,
  receiptData: ReceiptData,
  options: { fetcher?: Fetcher; printer?: Printer | null; kind?: "receipt" | "table" } = {},
): Promise<{ hubOnline: boolean | null; direct?: boolean }> {
  const fetcher = options.fetcher ?? fetch;
  const printJobBase64 = bytesToBase64(await buildReceiptPrinterBytes(receiptData, receiptData));
  // เปิดใน StoreOS POS Launcher + เครื่องพิมพ์ IP → ยิงตรงเข้าเครื่องพิมพ์ ไม่ผ่านคิวคลาวด์
  if (isDirectPrintablePrinter(options.printer) && (await isDirectPrintAvailable())) {
    assertDirectPrinted(
      await printDirect({
        printerId,
        host: options.printer!.ipAddress!,
        port: options.printer!.port ?? 9100,
        bytesBase64: printJobBase64,
        kind: options.kind ?? "receipt",
        label: receiptData.orderNumber,
      }),
    );
    return { hubOnline: true, direct: true };
  }
  const res = await fetcher("/api/print/enqueue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ printerId, printJobBase64 }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(parseErrorBody(body) ?? `ส่งงานพิมพ์ผ่าน Hub ไม่สำเร็จ (${res.status})`);
  }
  // hubOnline=false means the job is queued but the cashier PC Hub is offline.
  return { hubOnline: typeof body.hubOnline === "boolean" ? body.hubOnline : null };
}

export async function sendNetworkPrintJob(
  printer: Printer,
  payload: NetworkPrintPayload,
  options: SendNetworkPrintJobOptions = {},
) {
  const fetcher = options.fetcher ?? fetch;
  const hostname = options.hostname ?? getBrowserHostname();

  // StoreOS POS Launcher: พิมพ์ตรงจากเครื่องนี้ (เร็วสุด ไม่ออกอินเทอร์เน็ต) — ล้มแล้วไม่ส่งต่อเข้า Hub
  // เพราะผล "unknown" อาจออกกระดาษไปแล้ว ส่งซ้ำทางอื่นจะได้ใบซ้ำ
  if (isDirectPrintablePrinter(printer) && (await isDirectPrintAvailable())) {
    assertDirectPrinted(
      await printDirect({
        printerId: payload.printerId,
        host: printer.ipAddress!,
        port: printer.port ?? 9100,
        bytesBase64: payload.printJobBase64,
        kind: payload.receiptData.orderNumber ? "receipt" : "test",
        label: payload.receiptData.orderNumber || null,
      }),
    );
    return;
  }

  if (shouldUseLocalPrintBridge(hostname)) {
    if (!printer.ipAddress) throw new Error("ยังไม่ได้ตั้งค่า IP เครื่องพิมพ์");
    const bridgeUrl = (options.bridgeUrl ?? getConfiguredBridgeUrl()).replace(/\/+$/, "");
    try {
      // Fast path: the cashier PC running a loopback bridge prints instantly.
      await postJson(fetcher, `${bridgeUrl}/print`, {
        host: printer.ipAddress,
        port: printer.port ?? 9100,
        printJobBase64: payload.printJobBase64,
      });
      return;
    } catch (error) {
      // A real bridge/printer error (e.g. printer offline) should surface as-is.
      if (!(error instanceof TypeError)) throw error;
      // The loopback bridge is unreachable — typical on a tablet/iPad. Fall back
      // to the central Print Hub queue: enqueue and let the cashier PC Hub print.
      try {
        await postJson(fetcher, "/api/print/enqueue", {
          printerId: payload.printerId,
          printJobBase64: payload.printJobBase64,
        });
        return;
      } catch (enqueueError) {
        if (enqueueError instanceof TypeError) throw new Error(printHubUnavailableMessage());
        throw enqueueError;
      }
    }
  }

  await postJson(fetcher, "/api/print/ip", payload);
}
