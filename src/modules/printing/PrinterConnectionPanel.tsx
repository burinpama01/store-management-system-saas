"use client";

import { useActionState, useEffect, useState } from "react";
import { connectBluetoothPrinter, getBluetoothPrinterName, isBluetoothPrinterConnected } from "@/modules/printing/bluetooth-client";
import {
  connectNativeBluetoothPrinter,
  getNativeBluetoothPrinterName,
  isNativeBluetoothConnected,
  isNativePlatform,
} from "@/modules/printing/native-print-client";
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
  saveHubBluetoothPrinterAction?: SaveNetworkPrinterAction;
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
  saveHubBluetoothPrinterAction,
  onNetworkPrinterSelect,
}: PrinterConnectionPanelProps) {
  const [rememberedDevice, setRememberedDevice] = useState<PrinterDevice | null>(null);
  const [connectedDevice, setConnectedDevice] = useState<PrinterDevice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [networkMessage, setNetworkMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [nativeReady, setNativeReady] = useState(false);
  const [saveState, saveFormAction, savingNetworkPrinter] = useActionState(
    saveNetworkPrinterAction ?? (async () => ({ error: "ยังไม่พร้อมบันทึกเครื่องพิมพ์ IP/WiFi จากหน้านี้" })),
    { error: null },
  );
  const [btSaveState, saveBtFormAction, savingBtPrinter] = useActionState(
    saveHubBluetoothPrinterAction ?? (async () => ({ error: "ยังไม่พร้อมบันทึกเครื่องพิมพ์ Bluetooth จากหน้านี้" })),
    { error: null },
  );
  const networkPrinters = printers.filter((printer) =>
    (printer.type === "ip" || printer.type === "escpos") && printer.ipAddress,
  );
  const hubBluetoothPrinters = printers.filter(
    (printer) => printer.type === "bluetooth" && printer.hubBluetoothPort,
  );

  useEffect(() => {
    if (isNativePlatform()) {
      setNativeReady(true);
      // เครื่องพิมพ์ BLE ที่จำไว้ในแอป (native) แสดงเป็นอุปกรณ์ที่เคยเชื่อม
      const nativeName = getNativeBluetoothPrinterName();
      if (nativeName) {
        void Promise.resolve().then(() =>
          isNativeBluetoothConnected()
            ? setConnectedDevice({ kind: "Bluetooth (แอป)", name: nativeName })
            : setRememberedDevice({ kind: "Bluetooth (แอป, จำไว้)", name: nativeName }),
        );
        return;
      }
    }
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

  async function connectNativeBluetooth() {
    setError(null);
    setBusy(true);
    try {
      const name = await connectNativeBluetoothPrinter();
      setConnectedDevice({ kind: "Bluetooth (แอป)", name });
      setRememberedDevice(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "เชื่อมต่อเครื่องพิมพ์ในแอปไม่สำเร็จ");
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

  async function testHubBluetoothPrinter(printer: Printer) {
    setError(null);
    setNetworkMessage(null);
    setBusy(true);
    try {
      const receiptData = buildNetworkTestReceipt(storeName, printer.paperWidth ?? paperWidth);
      const printJobBase64 = bytesToBase64(await buildReceiptPrinterBytes(receiptData, receiptData));
      const res = await fetch("/api/print/enqueue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ printerId: printer.id, printJobBase64 }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `ส่งงานพิมพ์ไม่สำเร็จ (${res.status})`);
      }
      setConnectedDevice({ kind: "Bluetooth (ผ่าน Hub)", name: printer.name });
      setRememberedDevice(null);
      setNetworkMessage(`ส่งใบทดสอบไปที่ ${printer.name} (${printer.hubBluetoothPort}) ผ่าน Hub แล้ว`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "ส่งงานพิมพ์ผ่าน Hub ไม่สำเร็จ");
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
          {nativeReady && (
            <button type="button" onClick={connectNativeBluetooth} disabled={busy} className="btn-primary min-h-11 px-3 text-xs disabled:opacity-40">
              เชื่อมเครื่องพิมพ์ Bluetooth (แอป)
            </button>
          )}
          {!nativeReady && (
            <>
              <button type="button" onClick={connectUsb} disabled={busy} className="btn-secondary min-h-11 px-3 text-xs disabled:opacity-40">
                USB
              </button>
              <button type="button" onClick={connectBluetooth} disabled={busy} className="btn-secondary min-h-11 px-3 text-xs disabled:opacity-40">
                Bluetooth
              </button>
            </>
          )}
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
          {hubBluetoothPrinters.map((printer) => (
            <button
              key={printer.id}
              type="button"
              onClick={() => variant === "compact" ? markNetworkPrinterReady(printer) : void testHubBluetoothPrinter(printer)}
              disabled={busy}
              className={`btn-secondary min-h-11 px-3 text-xs disabled:opacity-40 ${variant === "compact" ? "max-w-52 truncate whitespace-nowrap" : ""}`}
              title={`${printer.name} · ${printer.hubBluetoothPort} ผ่าน Hub${variant === "compact" ? " · กดเพื่อเลือกเครื่องนี้" : " · กดเพื่อพิมพ์ทดสอบผ่าน Hub"}`}
            >
              BT (Hub) · {printer.name}
            </button>
          ))}
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

      {variant !== "compact" && saveHubBluetoothPrinterAction && (
        <form action={saveBtFormAction} className="mt-3 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-muted)] p-3">
          <p className="mb-1 text-xs font-semibold text-[var(--ink)]">เครื่องพิมพ์ Bluetooth ผ่าน Hub (สำหรับ iPad/iOS)</p>
          <p className="mb-3 text-[11px] text-[var(--muted)]">
            จับคู่เครื่องพิมพ์ Bluetooth กับเครื่องแคชเชียร์ Windows ก่อน (จะได้พอร์ต COM เช่น COM5) แล้ว iPad/iOS จะสั่งพิมพ์ผ่าน Hub ได้
          </p>
          <div className="grid gap-3 sm:grid-cols-[1.4fr_0.8fr_0.7fr]">
            <label className="text-xs font-medium text-[var(--muted)]">
              ชื่อเครื่อง
              <input
                name="name"
                type="text"
                required
                defaultValue={hubBluetoothPrinters[0]?.name ?? "เครื่องพิมพ์ Bluetooth"}
                className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--ink)]"
              />
            </label>
            <label className="text-xs font-medium text-[var(--muted)]">
              พอร์ต COM
              <input
                name="comPort"
                type="text"
                required
                placeholder="COM5"
                defaultValue={hubBluetoothPrinters[0]?.hubBluetoothPort ?? ""}
                className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--ink)]"
              />
            </label>
            <label className="text-xs font-medium text-[var(--muted)]">
              กระดาษ
              <select
                name="paperWidth"
                defaultValue={hubBluetoothPrinters[0]?.paperWidth ?? paperWidth}
                className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--ink)]"
              >
                <option value="58mm">58mm</option>
                <option value="80mm">80mm</option>
              </select>
            </label>
          </div>
          {hubBluetoothPrinters[0] && <input type="hidden" name="printerId" value={hubBluetoothPrinters[0].id} />}
          <label className="mt-3 flex items-center gap-2 text-xs text-[var(--muted)]">
            <input type="checkbox" name="isDefault" defaultChecked={Boolean(hubBluetoothPrinters[0]?.isDefault)} />
            ตั้งเป็นเครื่องพิมพ์หลัก
          </label>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button type="submit" variant="secondary" loading={savingBtPrinter} loadingText="กำลังบันทึก..." className="min-h-11 px-3 text-xs disabled:opacity-40">
              บันทึก Bluetooth (Hub)
            </Button>
            <p className="text-xs text-[var(--muted)]">
              ต้องเปิด StoreOS Print Hub บนเครื่องแคชเชียร์ที่จับคู่เครื่องพิมพ์ Bluetooth ไว้
            </p>
          </div>
          {btSaveState.error && (
            <p className="mt-2 rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700">{btSaveState.error}</p>
          )}
          {btSaveState.saved && !btSaveState.error && (
            <p className="mt-2 rounded border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs text-emerald-700">
              บันทึกเครื่องพิมพ์ Bluetooth (Hub) แล้ว
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
