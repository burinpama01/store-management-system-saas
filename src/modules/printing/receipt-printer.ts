import { printReceiptAuto, type PrintChannel } from "./print-router";
import { printService } from "./print-service";
import type { EscPosReceiptInput } from "./escpos";
import type { Printer, ReceiptData } from "./types";

function isBluetoothPrinterMismatchError(error: unknown): boolean {
  return error instanceof Error && error.name === "BluetoothPrinterMismatchError";
}

export type ReceiptPrintChannel = PrintChannel | "configured";

export interface ReceiptPrintResult {
  channel: ReceiptPrintChannel;
  printer?: Printer;
  fallbackFromPrinter?: Printer;
  configuredPrinterError?: unknown;
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

export async function printReceiptWithFallback({
  printers,
  preferredPrinterId,
  escpos,
  browser,
  onConfiguredPrinterError,
}: PrintReceiptWithFallbackInput): Promise<ReceiptPrintResult> {
  const configuredPrinter = selectConfiguredPrinter(printers, preferredPrinterId);
  let configuredPrinterError: unknown;

  if (configuredPrinter) {
    try {
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
