"use client";

import { useState } from "react";

type DeviceLike = { productName?: string; manufacturerName?: string; name?: string };
type NavWithDevices = {
  usb?: { requestDevice: (o: { filters: unknown[] }) => Promise<unknown> };
  bluetooth?: { requestDevice: (o: { acceptAllDevices: boolean }) => Promise<unknown> };
};

/**
 * Connect a receipt printer before testing. USB/Bluetooth use the browser
 * pairing dialog; the connected device name is shown so the test prints to a
 * real target. Actual ESC/POS output requires a physical printer.
 */
export function PrinterConnect() {
  const [device, setDevice] = useState<{ kind: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function connectUsb() {
    setError(null);
    const nav = navigator as unknown as NavWithDevices;
    if (!nav.usb) {
      setError("เบราว์เซอร์นี้ไม่รองรับ WebUSB (ลองใช้ Chrome/Edge บนเดสก์ท็อป)");
      return;
    }
    setBusy(true);
    try {
      const d = (await nav.usb.requestDevice({ filters: [] })) as DeviceLike;
      setDevice({ kind: "USB", name: d.productName || d.manufacturerName || "USB Printer" });
    } catch {
      setError("ไม่ได้เลือกอุปกรณ์ USB หรือยกเลิกการเชื่อมต่อ");
    } finally {
      setBusy(false);
    }
  }

  async function connectBluetooth() {
    setError(null);
    const nav = navigator as unknown as NavWithDevices;
    if (!nav.bluetooth) {
      setError("เบราว์เซอร์นี้ไม่รองรับ Web Bluetooth");
      return;
    }
    setBusy(true);
    try {
      const d = (await nav.bluetooth.requestDevice({ acceptAllDevices: true })) as DeviceLike;
      setDevice({ kind: "Bluetooth", name: d.name || "Bluetooth Printer" });
    } catch {
      setError("ไม่ได้เลือกอุปกรณ์ Bluetooth หรือยกเลิกการเชื่อมต่อ");
    } finally {
      setBusy(false);
    }
  }

  function testBrowserPrint() {
    if (typeof window !== "undefined") window.print();
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
        <button type="button" onClick={testBrowserPrint} className="btn-primary text-sm">
          ทดสอบพิมพ์ (Browser)
        </button>
      </div>

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
