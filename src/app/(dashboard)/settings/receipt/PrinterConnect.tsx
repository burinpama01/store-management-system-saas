"use client";

import { useEffect, useState } from "react";
import { connectBluetoothPrinter, getBluetoothPrinterName } from "@/modules/printing/bluetooth-client";

type DeviceLike = { productName?: string; manufacturerName?: string; name?: string };
type NavWithDevices = {
  usb?: { requestDevice: (o: { filters: unknown[] }) => Promise<unknown> };
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

  // Show a previously-connected Bluetooth printer name (per browser).
  useEffect(() => {
    const name = getBluetoothPrinterName();
    if (name) void Promise.resolve().then(() => setDevice({ kind: "Bluetooth (จำไว้)", name }));
  }, []);

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
