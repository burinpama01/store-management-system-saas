"use client";

import { useEffect, useState } from "react";
import { connectBluetoothPrinter, getBluetoothPrinterName } from "@/modules/printing/bluetooth-client";
import { connectUsbPrinter, getUsbPrinterName } from "@/modules/printing/usb-client";

/**
 * Connect a receipt printer before testing. Print fallback order is
 * Bluetooth → USB → PDF (browser). The connected device is kept for the session.
 */
export function PrinterConnect() {
  const [device, setDevice] = useState<{ kind: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Show a previously-connected printer name (per browser).
  useEffect(() => {
    const bt = getBluetoothPrinterName();
    const usb = getUsbPrinterName();
    const remembered = bt ? { kind: "Bluetooth (จำไว้)", name: bt } : usb ? { kind: "USB (จำไว้)", name: usb } : null;
    if (remembered) void Promise.resolve().then(() => setDevice(remembered));
  }, []);

  async function connectUsb() {
    setError(null);
    setBusy(true);
    try {
      const name = await connectUsbPrinter();
      setDevice({ kind: "USB", name });
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
      setDevice({ kind: "Bluetooth", name });
    } catch (e) {
      setError(e instanceof Error ? e.message : "เชื่อมต่อ Bluetooth ไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel max-w-3xl p-5">
      <h2 className="panel-title mb-1">เชื่อมต่อเครื่องพิมพ์</h2>
      <p className="label-muted mb-3">จับคู่เครื่องพิมพ์ก่อน แล้วจึงทดสอบพิมพ์</p>

      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={connectUsb} disabled={busy} className="btn-secondary text-sm disabled:opacity-40">
          เชื่อมต่อ USB
        </button>
        <button type="button" onClick={connectBluetooth} disabled={busy} className="btn-secondary text-sm disabled:opacity-40">
          เชื่อมต่อ Bluetooth
        </button>
      </div>
      <p className="mt-2 text-xs text-[var(--muted)]">
        เชื่อมต่อแล้วใช้ปุ่ม &quot;ทดสอบพิมพ์ใบเสร็จ&quot; ด้านล่างเพื่อส่งใบเสร็จไปยังเครื่องพิมพ์
      </p>

      {device && (
        <p className="mt-3 rounded-[var(--radius-md)] border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          เชื่อมต่อแล้ว: {device.kind} · {device.name}
        </p>
      )}
      {error && <p className="alert-danger mt-3">{error}</p>}
      <p className="mt-3 text-xs text-[var(--muted)]">
        USB/Bluetooth รองรับบน Chrome/Edge เดสก์ท็อป · เครื่องพิมพ์ IP/network ตั้งค่าได้ในส่วนเครื่องพิมพ์ของร้าน · การพิมพ์ ESC/POS จริงต้องมีเครื่องพิมพ์
      </p>
    </section>
  );
}
