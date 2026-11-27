"use client";

// R3: ปุ่มเก็บเงินปลายทาง — เลือกวิธีรับเงินตอนส่งสำเร็จ / ส่งไม่สำเร็จ / รับเงินสดคืนจากคนส่ง
// ใช้ทั้งตั๋วใน POS และหน้า สั่งออนไลน์

import { useEffect, useRef, useState } from "react";
import type { CodCollectMethod } from "@/modules/online-orders/core";
import type { BeamQrForPos } from "@/modules/payments/types";
import { QrCode } from "@/shared/components/ui/QrCode";

const baht = (n: number) => `฿${n.toLocaleString("th-TH", { maximumFractionDigits: 2 })}`;

/** เลือกวิธีรับเงินตอนกด "สำเร็จ" ของออเดอร์เก็บปลายทาง */
export function CodCollectPicker({
  orderCode,
  total,
  busy,
  onPick,
  onClose,
}: {
  orderCode: string;
  total: number;
  busy: boolean;
  onPick: (method: CodCollectMethod) => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/40 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label={`รับเงินปลายทาง ${orderCode}`}>
      <div className="w-full max-w-sm rounded-t-2xl bg-white p-4 shadow-xl sm:rounded-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-base font-bold text-gray-900">รับเงินปลายทาง {baht(total)}</p>
            <p className="text-xs text-gray-500">{orderCode} · ลูกค้าจ่ายด้วยอะไร?</p>
          </div>
          <button type="button" onClick={onClose} className="min-h-11 min-w-11 rounded-lg text-xl text-gray-500" aria-label="ปิด">
            ×
          </button>
        </div>
        <div className="mt-3 grid gap-2">
          <button type="button" disabled={busy} onClick={() => onPick("cash")} className="min-h-12 rounded-lg border border-gray-200 px-3 text-left text-sm hover:border-[var(--tenant-primary)] disabled:opacity-50">
            💵 <b>เงินสด</b>
            <span className="block text-xs text-gray-500">คนส่งถือเงินไว้ — กลับร้านแล้วกด “รับเงินคืน” บิลจึงปิดเข้าลิ้นชัก</span>
          </button>
          <button type="button" disabled={busy} onClick={() => onPick("beam")} className="min-h-12 rounded-lg border border-gray-200 px-3 text-left text-sm hover:border-[var(--tenant-primary)] disabled:opacity-50">
            📱 <b>Beam QR</b>
            <span className="block text-xs text-gray-500">โชว์ QR บนจอนี้ให้ลูกค้าสแกน — ยืนยันเงินเข้าอัตโนมัติ ปิดบิลให้เลย</span>
          </button>
          <button type="button" disabled={busy} onClick={() => onPick("bank_transfer")} className="min-h-12 rounded-lg border border-gray-200 px-3 text-left text-sm hover:border-[var(--tenant-primary)] disabled:opacity-50">
            🏦 <b>เงินโอน</b>
            <span className="block text-xs text-gray-500">ปิดบิลวิธีโอนทันที (ตรวจยอดเข้าบัญชีร้านก่อนกด)</span>
          </button>
        </div>
      </div>
    </div>
  );
}

/** ยืนยัน "ส่งไม่สำเร็จ" พร้อมเหตุผล — ยกเลิกบิลเปิดค้าง ไม่มีเงินเข้า */
export function CodFailButton({ busy, onConfirm, label = "ส่งไม่สำเร็จ" }: { busy: boolean; onConfirm: (reason: string) => void; label?: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("ลูกค้าไม่รับของ/ติดต่อไม่ได้");
  if (!open) {
    return (
      <button type="button" disabled={busy} onClick={() => setOpen(true)} className="btn-secondary min-h-11 px-4 text-sm text-red-700">
        {label}
      </button>
    );
  }
  return (
    <div className="w-full space-y-2 rounded-lg border border-red-200 bg-red-50 p-2 text-sm">
      <label className="block text-xs text-red-800">
        เหตุผล (ยกเลิกบิล ไม่มีเงินเข้า · ส่งไม่สำเร็จ 2 ครั้ง เบอร์นี้จะใช้เก็บปลายทางไม่ได้)
        <input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} className="mt-1 w-full rounded border px-2 py-2 text-sm" style={{ fontSize: 16 }} />
      </label>
      <div className="flex gap-2">
        <button type="button" disabled={busy} onClick={() => onConfirm(reason)} className="btn-primary min-h-11 flex-1 bg-red-600 px-3 text-sm">
          ยืนยัน{label}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="btn-secondary min-h-11 px-3 text-sm">
          กลับ
        </button>
      </div>
    </div>
  );
}

/**
 * R3b: QR Beam ให้ลูกค้าสแกนตอนรับของ — ถามสถานะทุก 4 วิ (webhook คือทางหลัก ถาม Beam ไม่ถี่กว่า 5 วิ ฝั่ง server)
 * จ่ายแล้ว server ปิดบิล + เปลี่ยนเป็นสำเร็จให้เอง → onDone
 */
export function CodBeamQrPanel({
  orderCode,
  total,
  start,
  check,
  onDone,
  onClose,
}: {
  orderCode: string;
  total: number;
  start: () => Promise<{ qr: BeamQrForPos | null; error: string | null }>;
  check: (gatewayPaymentId: string) => Promise<{ status: string; done: boolean; error: string | null }>;
  onDone: () => void;
  onClose: () => void;
}) {
  const [qr, setQr] = useState<BeamQrForPos | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("กำลังสร้าง QR…");
  const [attempt, setAttempt] = useState(0);
  const doneRef = useRef(false);
  const startRef = useRef(start);
  const checkRef = useRef(check);
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    startRef.current = start;
    checkRef.current = check;
    onDoneRef.current = onDone;
  });

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const poll = async (gw: string) => {
      if (cancelled || doneRef.current) return;
      const res = await checkRef.current(gw).catch(() => ({ status: "UNKNOWN", done: false, error: null as string | null }));
      if (cancelled) return;
      if (res.done) {
        doneRef.current = true;
        setStatus("ได้รับเงินแล้ว ✓");
        onDoneRef.current();
        return;
      }
      if (res.error) setError(res.error);
      if (res.status === "REVIEW_REQUIRED" || res.status === "LATE_PAID") {
        // ลูกค้าจ่ายแล้ว — ห้ามให้สร้าง QR ใหม่ (กันจ่ายซ้ำ)
        setStatus("ลูกค้าจ่ายแล้ว รอร้านตรวจ");
        return;
      }
      if (res.status === "PAID" || ["CREATED", "PENDING", "REQUIRES_ACTION", "PROCESSING", "UNKNOWN"].includes(res.status)) {
        setStatus(res.status === "PAID" ? "ได้รับเงินแล้ว กำลังปิดบิล…" : "รอลูกค้าสแกนจ่าย…");
        timer = window.setTimeout(() => void poll(gw), 4_000);
      } else {
        setStatus("QR หมดอายุ/ยกเลิก");
      }
    };
    const run = async () => {
      const res = await startRef.current().catch(() => ({ qr: null, error: "สร้าง QR ไม่สำเร็จ" }));
      if (cancelled) return;
      if (!res.qr) {
        setError(res.error ?? "สร้าง QR ไม่สำเร็จ");
        setStatus("สร้าง QR ไม่สำเร็จ");
        return;
      }
      setQr(res.qr);
      setError(null);
      setStatus("รอลูกค้าสแกนจ่าย…");
      void poll(res.qr.gatewayPaymentId);
    };
    // setTimeout(0): setState หลัง effect (react-hooks/set-state-in-effect)
    timer = window.setTimeout(() => void run(), 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [attempt]);

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/50 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label={`QR Beam ${orderCode}`}>
      <div className="w-full max-w-sm rounded-t-2xl bg-white p-4 text-center shadow-xl sm:rounded-2xl">
        <div className="flex items-start justify-between gap-3 text-left">
          <div>
            <p className="text-base font-bold text-gray-900">สแกนจ่าย ฿{total.toLocaleString("th-TH", { maximumFractionDigits: 2 })}</p>
            <p className="text-xs text-gray-500">{orderCode} · ให้ลูกค้าสแกนด้วยแอปธนาคาร</p>
          </div>
          <button type="button" onClick={onClose} className="min-h-11 min-w-11 rounded-lg text-xl text-gray-500" aria-label="ปิด">
            ×
          </button>
        </div>
        <div className="mt-3 flex min-h-[240px] items-center justify-center">
          {qr?.qrPayload ? (
            <QrCode value={qr.qrPayload} size={230} />
          ) : qr?.qrImageBase64 ? (
            // eslint-disable-next-line @next/next/no-img-element -- QR จาก Beam เป็น base64
            <img src={`data:image/png;base64,${qr.qrImageBase64}`} alt="QR ชำระเงิน" className="h-[230px] w-[230px]" />
          ) : (
            <p className="text-sm text-gray-500">{status}</p>
          )}
        </div>
        <p role="status" className="mt-2 text-sm font-semibold text-gray-800">{status}</p>
        {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
        {(status.startsWith("QR หมดอายุ") || status.startsWith("สร้าง QR ไม่สำเร็จ")) && (
          <button type="button" onClick={() => setAttempt((n) => n + 1)} className="btn-primary mt-3 min-h-11 px-4 text-sm">
            สร้าง QR ใหม่
          </button>
        )}
        <p className="mt-3 text-[11px] text-gray-400">ปิดหน้านี้ได้ — ลูกค้าจ่ายแล้วกลับมาเปิด QR ของออเดอร์นี้อีกครั้ง ระบบจะปิดบิลให้</p>
      </div>
    </div>
  );
}
