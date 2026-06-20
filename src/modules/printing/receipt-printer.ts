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
  escpos: EscPosReceiptInput;
  browser: ReceiptData;
  onConfiguredPrinterError?: (error: unknown, printer: Printer) => void;
}

export function selectDefaultPrinter(printers: Printer[]): Printer | null {
  return printers.find((printer) => printer.isDefault) ?? null;
}

export async function printReceiptWithFallback({
  printers,
  escpos,
  browser,
  onConfiguredPrinterError,
}: PrintReceiptWithFallbackInput): Promise<ReceiptPrintResult> {
  const defaultPrinter = selectDefaultPrinter(printers);
  let configuredPrinterError: unknown;

  if (defaultPrinter) {
    try {
      await printService.print(defaultPrinter, {
        ...browser,
        paperWidth: defaultPrinter.paperWidth,
      });
      return { channel: "configured", printer: defaultPrinter };
    } catch (error) {
      configuredPrinterError = error;
      onConfiguredPrinterError?.(error, defaultPrinter);
    }
  }

  let channel: PrintChannel;
  const skipBluetoothFallback =
    defaultPrinter?.type === "bluetooth" && isBluetoothPrinterMismatchError(configuredPrinterError);
  try {
    channel = skipBluetoothFallback
      ? await printReceiptAuto(escpos, browser, { skipBluetooth: true })
      : await printReceiptAuto(escpos, browser);
  } catch (fallbackError) {
    if (configuredPrinterError && defaultPrinter) {
      throw new ReceiptPrintFallbackError(defaultPrinter, configuredPrinterError, fallbackError);
    }
    throw fallbackError;
  }
  return {
    channel,
    fallbackFromPrinter: configuredPrinterError ? defaultPrinter ?? undefined : undefined,
    configuredPrinterError,
  };
}
