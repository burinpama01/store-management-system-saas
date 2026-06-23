"use client";

import { useEffect, useState } from "react";
import { connectBluetoothPrinter, getBluetoothPrinterName, isBluetoothPrinterConnected } from "@/modules/printing/bluetooth-client";
import { connectUsbPrinter, getUsbPrinterName, isUsbPrinterConnected } from "@/modules/printing/usb-client";

interface PrinterConnectionPanelProps {
  variant?: "panel" | "compact";
  className?: string;
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

/** Lets cashiers reconnect a remembered receipt printer from the current screen. */
export function PrinterConnectionPanel({ variant = "panel", className = "" }: PrinterConnectionPanelProps) {
  const [rememberedDevice, setRememberedDevice] = useState<PrinterDevice | null>(null);
  const [connectedDevice, setConnectedDevice] = useState<PrinterDevice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
        </div>
      </div>

      {connectedDevice && (
        <p className={variant === "compact" ? "mt-2 text-[11px] font-medium text-emerald-700" : "mt-3 rounded-[var(--radius-md)] border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700"}>
          พร้อมใช้: {connectedDevice.kind} · {connectedDevice.name}
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
