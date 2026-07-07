import { printReceiptAuto, type PrintChannel } from "./print-router";
import { printService } from "./print-service";
import { enqueueReceiptPrintJob } from "./network-print-client";
import { getNativeBluetoothPrinterName, isNativePlatform } from "./native-print-client";
import type { EscPosReceiptInput } from "./escpos";
import type { Printer, ReceiptData } from "./types";

/**
 * ในแอปมือถือ ถ้าผู้ใช้จับคู่เครื่องพิมพ์ BLE (แอป) ไว้ นั่นคือเครื่องพิมพ์ที่ตั้งใจใช้ —
 * ต้องพิมพ์ผ่าน BLE ก่อนเสมอ ไม่ใช่ไปลองเครื่องพิมพ์หลัก (IP/Hub/browser) ที่มือถือ
 * เข้าไม่ถึงและมักจะ "สำเร็จ" แบบไม่ออกกระดาษ (เช่น browser print ใน WebView)
 */
function shouldPreferNativeBluetooth(): boolean {
  return isNativePlatform() && Boolean(getNativeBluetoothPrinterName());
}

function isBluetoothPrinterMismatchError(error: unknown): boolean {
  return error instanceof Error && error.name === "BluetoothPrinterMismatchError";
}

export type ReceiptPrintChannel = PrintChannel | "configured";

export interface ReceiptPrintResult {
  channel: ReceiptPrintChannel;
  printer?: Printer;
  fallbackFromPrinter?: Printer;
  configuredPrinterError?: unknown;
  /** For Hub-queued jobs: false = queued but the cashier PC Hub is offline. */
  hubOnline?: boolean | null;
}

export class ReceiptPrintFallbackError extends Error {
  readonly configuredPrinter: Printer;
  readonly configuredPrinterError: unknown;
  readonly fallbackError: unknown;

  constructor(configuredPrinter: Printer, configuredPrinterError: unknown, fallbackError: unknown) {
    const configuredMessage = configuredPrinterError instanceof Error ? configuredPrinterError.message : "ไม่ทราบสาเหตุ";
    const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : "ไม่ทราบสาเหตุ";
    super(`เครื่องพิมพ์ ${configuredPrinter.name} ใช้ไม่ได้ (${configuredMessage}) และช่องทางสำรองพิมพ์ไม่สำเร็จ (${fallbackMessage})`);
    this.name = "ReceiptPrintFallbackError";
    this.configuredPrinter = configuredPrinter;
    this.configuredPrinterError = configuredPrinterError;
    this.fallbackError = fallbackError;
  }
}

interface PrintReceiptWithFallbackInput {
  printers: Printer[];
  preferredPrinterId?: string | null;
  escpos: EscPosReceiptInput;
  browser: ReceiptData;
  onConfiguredPrinterError?: (error: unknown, printer: Printer) => void;
}

export function selectDefaultPrinter(printers: Printer[]): Printer | null {
  return printers.find((printer) => printer.isDefault) ?? null;
}

export function selectConfiguredPrinter(printers: Printer[], preferredPrinterId?: string | null): Printer | null {
  if (preferredPrinterId) {
    const preferredPrinter = printers.find((printer) => printer.id === preferredPrinterId);
    if (preferredPrinter) return preferredPrinter;
  }
  return selectDefaultPrinter(printers);
}

/**
 * A printer the Print Hub can print to: a LAN printer (ip/escpos with an IP) or
 * a Bluetooth printer paired to the cashier PC (bluetooth with a hub COM port).
 * These route through the server queue, so they work on iPad/tablet POS.
 */
export function isHubReceiptPrinter(printer: Printer): boolean {
  return (
    ((printer.type === "ip" || printer.type === "escpos") && Boolean(printer.ipAddress)) ||
    (printer.type === "bluetooth" && Boolean(printer.hubBluetoothPort))
  );
}

/** The configured printer, but only if it can print through the Hub. */
export function selectHubReceiptPrinter(printers: Printer[], preferredPrinterId?: string | null): Printer | null {
  const configured = selectConfiguredPrinter(printers, preferredPrinterId);
  return configured && isHubReceiptPrinter(configured) ? configured : null;
}

/**
 * Auto-prints a receipt, preferring the Print Hub queue for a Hub-capable
 * configured printer (works on iPad, incl. Bluetooth-via-Hub) and falling back
 * to a directly-connected browser printer (BT → USB → PDF) otherwise. Shared by
 * QR + delivery auto-print so every receipt point can reach the Hub.
 */
export async function autoPrintReceipt({
  printers,
  preferredPrinterId,
  escpos,
  browser,
}: PrintReceiptWithFallbackInput): Promise<ReceiptPrintResult> {
  // แอปมือถือที่จับคู่ BLE ไว้ → พิมพ์ BLE ก่อน ไม่ส่งเข้า Hub (มือถือไม่ใช่ตัว Hub)
  if (shouldPreferNativeBluetooth()) {
    const channel = await printReceiptAuto(escpos, browser);
    return { channel };
  }
  const hubPrinter = selectHubReceiptPrinter(printers, preferredPrinterId);
  if (hubPrinter) {
    const { hubOnline } = await enqueueReceiptPrintJob(hubPrinter.id, { ...browser, paperWidth: hubPrinter.paperWidth });
    return { channel: "configured", printer: hubPrinter, hubOnline };
  }
  const channel = await printReceiptAuto(escpos, browser);
  return { channel };
}

export async function printReceiptWithFallback({
  printers,
  preferredPrinterId,
  escpos,
  browser,
  onConfiguredPrinterError,
}: PrintReceiptWithFallbackInput): Promise<ReceiptPrintResult> {
  // แอปมือถือที่จับคู่ BLE ไว้ → พิมพ์ BLE ก่อนเครื่องพิมพ์หลัก (ที่มือถือมักเข้าไม่ถึง
  // และจะ "สำเร็จ" แบบไม่ออกกระดาษ). ปุ่มทดสอบพิมพ์ยิงตรง BLE จึงออก แต่ POS เดิม
  // ไปเข้าเครื่องพิมพ์หลักก่อนเลยไม่ตกมา BLE — บล็อกนี้แก้อาการนั้น
  if (shouldPreferNativeBluetooth()) {
    const channel = await printReceiptAuto(escpos, browser);
    return { channel };
  }

  const configuredPrinter = selectConfiguredPrinter(printers, preferredPrinterId);
  let configuredPrinterError: unknown;

  if (configuredPrinter) {
    try {
      if (configuredPrinter.type === "bluetooth" && configuredPrinter.hubBluetoothPort) {
        // Bluetooth-via-Hub prints through the server queue — Web Bluetooth is
        // unavailable on iPad; the Hub agent writes to the paired COM port.
        const { hubOnline } = await enqueueReceiptPrintJob(configuredPrinter.id, {
          ...browser,
          paperWidth: configuredPrinter.paperWidth,
        });
        return { channel: "configured", printer: configuredPrinter, hubOnline };
      }
      await printService.print(configuredPrinter, {
        ...browser,
        paperWidth: configuredPrinter.paperWidth,
      });
      return { channel: "configured", printer: configuredPrinter };
    } catch (error) {
      configuredPrinterError = error;
      onConfiguredPrinterError?.(error, configuredPrinter);
    }
  }

  let channel: PrintChannel;
  const skipBluetoothFallback =
    configuredPrinter?.type === "bluetooth" && isBluetoothPrinterMismatchError(configuredPrinterError);
  try {
    channel = skipBluetoothFallback
      ? await printReceiptAuto(escpos, browser, { skipBluetooth: true })
      : await printReceiptAuto(escpos, browser);
  } catch (fallbackError) {
    if (configuredPrinterError && configuredPrinter) {
      throw new ReceiptPrintFallbackError(configuredPrinter, configuredPrinterError, fallbackError);
    }
    throw fallbackError;
  }
  return {
    channel,
    fallbackFromPrinter: configuredPrinterError ? configuredPrinter ?? undefined : undefined,
    configuredPrinterError,
  };
}
