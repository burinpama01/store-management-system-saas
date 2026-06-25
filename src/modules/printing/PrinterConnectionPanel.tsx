"use client";

import { useActionState, useEffect, useState } from "react";
import { connectBluetoothPrinter, getBluetoothPrinterName, isBluetoothPrinterConnected } from "@/modules/printing/bluetooth-client";
import { sendNetworkPrintJob } from "@/modules/printing/network-print-client";
import { bytesToBase64 } from "@/modules/printing/print-job-base64";
import { buildReceiptPrinterBytes } from "@/modules/printing/receipt-printer-bytes";
import { connectUsbPrinter, getUsbPrinterName, isUsbPrinterConnected } from "@/modules/printing/usb-client";
import type { ReceiptData } from "@/modules/printing/types";
import type { Printer } from "@/modules/stores/types";
import { Button } from "@/shared/components/ui";

type NetworkPrinterActionState = { error: string | null; saved?: boolean };
type SaveNetworkPrinterAction = (
  prev: NetworkPrinterActionState,
  formData: FormData,
) => Promise<NetworkPrinterActionState>;

interface PrinterConnectionPanelProps {
  variant?: "panel" | "compact";
  className?: string;
  printers?: Printer[];
  printerLoadError?: string | null;
  storeName?: string;
  paperWidth?: "58mm" | "80mm";
  saveNetworkPrinterAction?: SaveNetworkPrinterAction;
  onNetworkPrinterSelect?: (printerId: string) => void;
}

type PrinterDevice = { kind: string; name: string };

export interface PrinterConnectionSnapshot {
  bluetoothName: string | null;
  usbName: string | null;
  bluetoothConnected: boolean;
  usbConnected: boolean;
}

export function resolvePrinterConnectionState({
  bluetoothName,
  usbName,
  bluetoothConnected,
  usbConnected,
}: PrinterConnectionSnapshot): { connectedDevice: PrinterDevice | null; rememberedDevice: PrinterDevice | null } {
  const connectedDevice = bluetoothConnected && bluetoothName
    ? { kind: "Bluetooth", name: bluetoothName }
    : usbConnected && usbName
      ? { kind: "USB", name: usbName }
      : null;
  const rememberedDevice = bluetoothName
    ? { kind: "Bluetooth (จำไว้)", name: bluetoothName }
    : usbName
      ? { kind: "USB (จำไว้)", name: usbName }
      : null;

  return { connectedDevice, rememberedDevice: connectedDevice ? null : rememberedDevice };
}

function buildNetworkTestReceipt(storeName: string, paperWidth: "58mm" | "80mm"): ReceiptData {
  return {
    storeName,
    showTaxId: false,
    orderNumber: "NETWORK-TEST",
    items: [{ name: "ทดสอบ IP / WiFi", quantity: 1, unitPrice: 1, totalPrice: 1, modifierNames: [] }],
    subtotal: 1,
    discount: 0,
    total: 1,
    payments: [{ method: "test", amount: 1 }],
    paymentStatus: "paid",
    footerText: "ทดสอบการเชื่อมต่อเครื่องพิมพ์ผ่าน IP / WiFi",
    showQrPayment: false,
    paperWidth,
    printedAt: new Date().toISOString(),
  };
}

export async function buildNetworkPrinterTestPayload(
  printer: Printer,
  storeName: string,
  paperWidth: "58mm" | "80mm",
): Promise<{ printerId: string; receiptData: ReceiptData; printJobBase64: string }> {
  const receiptData = buildNetworkTestReceipt(storeName, printer.paperWidth ?? paperWidth);
  const printJobBase64 = bytesToBase64(await buildReceiptPrinterBytes(receiptData, receiptData));
  return { printerId: printer.id, receiptData, printJobBase64 };
}

/** Lets cashiers reconnect a remembered receipt printer from the current screen. */
export function PrinterConnectionPanel({
  variant = "panel",
  className = "",
  printers = [],
  printerLoadError = null,
  storeName = "StoreOS",
  paperWidth = "80mm",
  saveNetworkPrinterAction,
  onNetworkPrinterSelect,
}: PrinterConnectionPanelProps) {
  const [rememberedDevice, setRememberedDevice] = useState<PrinterDevice | null>(null);
  const [connectedDevice, setConnectedDevice] = useState<PrinterDevice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [networkMessage, setNetworkMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveState, saveFormAction, savingNetworkPrinter] = useActionState(
    saveNetworkPrinterAction ?? (async () => ({ error: "ยังไม่พร้อมบันทึกเครื่องพิมพ์ IP/WiFi จากหน้านี้" })),
    { error: null },
  );
  const networkPrinters = printers.filter((printer) =>
    (printer.type === "ip" || printer.type === "escpos") && printer.ipAddress,
  );

  useEffect(() => {
    const bt = getBluetoothPrinterName();
    const usb = getUsbPrinterName();
    const initial = resolvePrinterConnectionState({
      bluetoothName: bt,
      usbName: usb,
      bluetoothConnected: isBluetoothPrinterConnected(),
      usbConnected: isUsbPrinterConnected(),
    });
    if (initial.connectedDevice) {
      void Promise.resolve().then(() => setConnectedDevice(initial.connectedDevice));
      return;
    }
    if (initial.rememberedDevice) void Promise.resolve().then(() => setRememberedDevice(initial.rememberedDevice));
  }, []);

  async function connectUsb() {
    setError(null);
    setBusy(true);
    try {
      const name = await connectUsbPrinter();
      setConnectedDevice({ kind: "USB", name });
      setRememberedDevice(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "เชื่อมต่อ USB ไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  }

  async function connectBluetooth() {
    setError(null);
    setBusy(true);
    try {
      const name = await connectBluetoothPrinter();
      setConnectedDevice({ kind: "Bluetooth", name });
      setRememberedDevice(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "เชื่อมต่อ Bluetooth ไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  }

  async function testNetworkPrinter(printer: Printer) {
    setError(null);
    setNetworkMessage(null);
    setBusy(true);
    try {
      await sendNetworkPrintJob(printer, await buildNetworkPrinterTestPayload(printer, storeName, paperWidth));
      setConnectedDevice({ kind: "IP / WiFi", name: printer.name });
      setRememberedDevice(null);
      setNetworkMessage(`ส่งใบทดสอบไปที่ ${printer.name} แล้ว`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "เชื่อมต่อ IP / WiFi ไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  }

  function markNetworkPrinterReady(printer: Printer) {
    setError(null);
    setNetworkMessage(null);
    setConnectedDevice({ kind: "IP / WiFi", name: printer.name });
    setRememberedDevice(null);
    onNetworkPrinterSelect?.(printer.id);
  }

  const outerClass =
    variant === "compact"
      ? `shrink-0 border-b border-[var(--border)] bg-[var(--surface)] px-3 py-2 ${className}`
      : `panel max-w-3xl p-5 ${className}`;

  return (
    <section className={outerClass.trim()} aria-label="เชื่อมต่อเครื่องพิมพ์">
      <div className={variant === "compact" ? "flex flex-wrap items-center gap-2" : "space-y-3"}>
        <div className={variant === "compact" ? "min-w-48 flex-1" : ""}>
          <h2 className={variant === "compact" ? "text-xs font-semibold text-[var(--ink)]" : "panel-title mb-1"}>
            เชื่อมต่อเครื่องพิมพ์
          </h2>
          <p className={variant === "compact" ? "text-[11px] text-[var(--muted)]" : "label-muted"}>
            รีเฟรชแล้วหลุด กดเชื่อมต่อใหม่จากหน้านี้ได้ทันที
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={connectUsb} disabled={busy} className="btn-secondary min-h-11 px-3 text-xs disabled:opacity-40">
            USB
          </button>
          <button type="button" onClick={connectBluetooth} disabled={busy} className="btn-secondary min-h-11 px-3 text-xs disabled:opacity-40">
            Bluetooth
          </button>
          {networkPrinters.map((printer) => (
            <button
              key={printer.id}
              type="button"
              onClick={() => variant === "compact" ? markNetworkPrinterReady(printer) : void testNetworkPrinter(printer)}
              disabled={busy}
              className={`btn-secondary min-h-11 px-3 text-xs disabled:opacity-40 ${variant === "compact" ? "max-w-52 truncate whitespace-nowrap" : ""}`}
              title={`${printer.name} · ${printer.ipAddress}${printer.port ? `:${printer.port}` : ""}${variant === "compact" ? " · กดเพื่อเลือกเครื่องนี้" : " · กดเพื่อพิมพ์ทดสอบ"}`}
            >
              IP / WiFi · {printer.name}
            </button>
          ))}
          {networkPrinters.length === 0 && (
            <button
              type="button"
              disabled
              className="btn-secondary min-h-11 px-3 text-xs opacity-60"
              title="ยังไม่มีเครื่องพิมพ์ IP/WiFi ที่บันทึกไว้"
            >
              IP / WiFi
            </button>
          )}
        </div>
      </div>

      {printerLoadError && (
        <p className={variant === "compact" ? "mt-2 text-[11px] font-medium text-amber-700" : "mt-3 rounded-[var(--radius-md)] border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"}>
          โหลดรายการเครื่องพิมพ์ IP/WiFi ไม่สำเร็จ: {printerLoadError}
        </p>
      )}

      {networkPrinters.length > 0 && variant !== "compact" && (
        <div className="mt-3 space-y-2 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-muted)] p-3">
          <p className="text-xs font-semibold text-[var(--ink)]">เครื่องพิมพ์ IP / WiFi ที่บันทึกไว้</p>
          {networkPrinters.map((printer) => (
            <p key={printer.id} className="text-xs text-[var(--muted)]">
              {printer.name} · {printer.ipAddress}{printer.port ? `:${printer.port}` : ""}
            </p>
          ))}
        </div>
      )}

      {variant !== "compact" && (
        <form action={saveFormAction} className="mt-3 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-muted)] p-3">
          <div className="grid gap-3 sm:grid-cols-[1.2fr_1fr_0.6fr_0.7fr]">
            <label className="text-xs font-medium text-[var(--muted)]">
              ชื่อเครื่อง
              <input
                name="name"
                type="text"
                required
                defaultValue={networkPrinters[0]?.name ?? "เครื่องพิมพ์ WiFi"}
                className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--ink)]"
              />
            </label>
            <label className="text-xs font-medium text-[var(--muted)]">
              IP Address
              <input
                name="ipAddress"
                type="text"
                inputMode="decimal"
                required
                placeholder="192.168.1.50"
                defaultValue={networkPrinters[0]?.ipAddress ?? ""}
                className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--ink)]"
              />
            </label>
            <label className="text-xs font-medium text-[var(--muted)]">
              Port
              <input
                name="port"
                type="number"
                min={1}
                max={65535}
                required
                defaultValue={networkPrinters[0]?.port ?? 9100}
                className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--ink)]"
              />
            </label>
            <label className="text-xs font-medium text-[var(--muted)]">
              กระดาษ
              <select
                name="paperWidth"
                defaultValue={networkPrinters[0]?.paperWidth ?? paperWidth}
                className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--ink)]"
              >
                <option value="58mm">58mm</option>
                <option value="80mm">80mm</option>
              </select>
            </label>
          </div>
          {networkPrinters[0] && <input type="hidden" name="printerId" value={networkPrinters[0].id} />}
          <label className="mt-3 flex items-center gap-2 text-xs text-[var(--muted)]">
            <input type="checkbox" name="isDefault" defaultChecked={networkPrinters.length === 0 || Boolean(networkPrinters[0]?.isDefault)} />
            ตั้งเป็นเครื่องพิมพ์หลัก
          </label>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button type="submit" variant="secondary" loading={savingNetworkPrinter} loadingText="กำลังบันทึก..." className="min-h-11 px-3 text-xs disabled:opacity-40">
              บันทึก IP / WiFi
            </Button>
            <p className="text-xs text-[var(--muted)]">
              รองรับ Private LAN เช่น 192.168.x.x, 10.x.x.x, 172.16-31.x.x; production ต้องเปิด StoreOS Print Bridge บนเครื่องแคชเชียร์
            </p>
          </div>
          {saveState.error && (
            <p className="mt-2 rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700">{saveState.error}</p>
          )}
          {saveState.saved && !saveState.error && (
            <p className="mt-2 rounded border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs text-emerald-700">
              บันทึกเครื่องพิมพ์ IP/WiFi แล้ว
            </p>
          )}
        </form>
      )}

      {connectedDevice && (
        <p className={variant === "compact" ? "mt-2 text-[11px] font-medium text-emerald-700" : "mt-3 rounded-[var(--radius-md)] border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700"}>
          พร้อมใช้: {connectedDevice.kind} · {connectedDevice.name}
        </p>
      )}

      {networkMessage && (
        <p className={variant === "compact" ? "mt-2 text-[11px] font-medium text-emerald-700" : "mt-3 rounded-[var(--radius-md)] border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700"}>
          {networkMessage}
        </p>
      )}
      {!connectedDevice && rememberedDevice && (
        <p className={variant === "compact" ? "mt-2 text-[11px] font-medium text-amber-700" : "mt-3 rounded-[var(--radius-md)] border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700"}>
          เคยเชื่อมต่อ: {rememberedDevice.kind} · {rememberedDevice.name} · กดเชื่อมต่อใหม่หลังรีเฟรช
        </p>
      )}
      {error && (
        <p className={variant === "compact" ? "mt-2 text-[11px] font-medium text-red-600" : "mt-3 rounded-[var(--radius-md)] border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"}>
          {error}
        </p>
      )}
    </section>
  );
}
