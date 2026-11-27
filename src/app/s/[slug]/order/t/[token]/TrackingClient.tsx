"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { QrCode } from "@/shared/components/ui/QrCode";
import { useConfirm } from "@/shared/components/ui/useConfirm";
import { cancelUnpaidOnlineOrderAction, getTrackingAction, type TrackingView } from "../../actions";

const baht = (n: number) => `฿${n.toLocaleString("th-TH", { maximumFractionDigits: 2 })}`;

const STEPS_PICKUP = ["paid", "accepted", "preparing", "ready", "completed"] as const;
const STEPS_DELIVERY = ["paid", "accepted", "preparing", "out_for_delivery", "completed"] as const;
const STEPS_COD = ["cod_pending", "accepted", "preparing", "out_for_delivery", "completed"] as const;
const STEP_LABEL: Record<string, string> = {
  paid: "จ่ายแล้ว",
  cod_pending: "สั่งแล้ว (เก็บเงินปลายทาง)",
  accepted: "ร้านรับออเดอร์",
  preparing: "กำลังทำ",
  ready: "พร้อมรับที่ร้าน",
  out_for_delivery: "กำลังไปส่ง",
  completed: "สำเร็จ",
};
const DONE = new Set(["completed", "expired", "refund_pending", "refunded", "delivery_failed"]);

export function TrackingClient({ slug, token, backHref = null }: { slug: string; token: string; backHref?: string | null }) {
  const [view, setView] = useState<TrackingView | null>(null);
  const [qr, setQr] = useState<{ payload: string | null; image: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // เวลาที่เริ่มคำขอค้างอยู่ (0 = ว่าง) — iOS ล็อกจอระหว่างรอ คำขออาจค้างตลอด ห้ามให้ล็อกการรีเฟรชถาวร
  const busySince = useRef(0);
  const { confirm, confirmDialog } = useConfirm();
  const hasQr = useRef(false);

  const load = useCallback(async () => {
    if (busySince.current && Date.now() - busySince.current < 20_000) return;
    const startedAt = Date.now();
    busySince.current = startedAt;
    try {
      // ขอ QR ครั้งเดียวต่อการเปิดหน้า (สร้าง QR = เรียก Beam) — รอบต่อไปถามแค่สถานะ
      const res = await getTrackingAction(token, !hasQr.current);
      if (res.error || !res.view) {
        setError(res.error ?? "ไม่พบคำสั่งซื้อ");
        return;
      }
      setError(null);
      setView(res.view);
      if (res.view.qr) {
        hasQr.current = true;
        setQr(res.view.qr);
      }
    } catch {
      // เน็ตหลุด — รอบถัดไปลองใหม่
    } finally {
      if (busySince.current === startedAt) busySince.current = 0;
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const status = view?.status;
  useEffect(() => {
    if (!status || DONE.has(status)) return;
    const ms = status === "awaiting_payment" ? 4000 : 15000;
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, ms);
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    // กลับมาที่หน้า (ปลดล็อกจอ/สลับแอป/ย้อนกลับ) → ถามสถานะทันที ไม่ต้องรอรอบถัดไป
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      window.clearInterval(id);
      window.clearInterval(tick);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [status, load]);

  if (error && !view) {
    return <main className="mx-auto max-w-md p-6 text-center">{error}</main>;
  }
  if (!view) return <main className="mx-auto max-w-md p-6 text-center text-stone-500">กำลังโหลด...</main>;

  const steps: readonly string[] =
    view.fulfillment === "pickup" ? STEPS_PICKUP : view.paymentMethod === "cod" ? STEPS_COD : STEPS_DELIVERY;
  const reached = steps.indexOf(view.status);
  const secondsLeft = Math.max(0, Math.floor((Date.parse(view.expiresAt) - now) / 1000));

  return (
    <main className="mx-auto min-h-screen max-w-md space-y-4 bg-stone-50 p-4 text-stone-900">
      <header className="text-center">
        <p className="text-xs text-stone-500">คำสั่งซื้อ</p>
        <h1 className="text-2xl font-bold">{view.orderCode}</h1>
        <p className="mt-1 inline-block rounded-full bg-orange-100 px-3 py-1 text-sm text-orange-800">{view.statusLabel}</p>
      </header>

      {view.status === "awaiting_payment" && (
        <section className="rounded-2xl border bg-white p-4 text-center">
          <p className="font-semibold">สแกนจ่ายด้วยแอปธนาคาร</p>
          <p className="text-2xl font-bold text-orange-700">{baht(view.total)}</p>
          <div className="my-3 flex justify-center">
            {qr?.payload ? (
              <QrCode value={qr.payload} size={220} />
            ) : qr?.image ? (
              // eslint-disable-next-line @next/next/no-img-element -- QR จาก Beam เป็น base64
              <img src={`data:image/png;base64,${qr.image}`} alt="QR ชำระเงิน" className="h-[220px] w-[220px]" />
            ) : (
              <p className="py-16 text-sm text-stone-500">กำลังสร้าง QR...</p>
            )}
          </div>
          <p className="text-sm text-stone-500">
            {secondsLeft > 0 ? `QR หมดอายุใน ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, "0")}` : "QR หมดอายุแล้ว — ถ้าจ่ายไปแล้วรอสักครู่"}
          </p>
          <p className="mt-1 text-xs text-stone-500">จ่ายแล้วหน้านี้จะเปลี่ยนเอง ไม่ต้องส่งสลิป</p>
          <button
            type="button"
            className="mt-3 text-sm text-stone-500 underline"
            onClick={async () => {
              if (!(await confirm({ title: "ยกเลิกคำสั่งซื้อนี้?", message: "ถ้าจ่ายไปแล้วอย่ายกเลิก — รอให้หน้านี้เปลี่ยนเป็นจ่ายแล้ว", confirmLabel: "ยกเลิกคำสั่งซื้อ", cancelLabel: "กลับ", danger: true }))) return;
              const res = await cancelUnpaidOnlineOrderAction(token);
              if (res.error) setError(res.error);
              await load();
            }}
          >
            ยกเลิกคำสั่งซื้อ
          </button>
        </section>
      )}

      {reached >= 0 && (
        <section className="rounded-2xl border bg-white p-4">
          <ol className="space-y-2">
            {steps.map((s, i) => (
              <li key={s} className={`flex items-center gap-2 ${i <= reached ? "font-semibold text-green-700" : "text-stone-400"}`}>
                <span>{i < reached ? "✓" : i === reached ? "●" : "○"}</span>
                {STEP_LABEL[s]}
              </li>
            ))}
          </ol>
          {view.fulfillment === "pickup" && view.pickupAt && view.status !== "completed" && (
            <p className="mt-3 text-sm text-stone-600">
              นัดรับประมาณ {new Date(view.pickupAt).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" })} น.
            </p>
          )}
        </section>
      )}

      {view.paymentMethod === "cod" && !DONE.has(view.status) && (
        <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
          💵 เก็บเงินปลายทาง {baht(view.total)} — จ่ายกับพนักงานตอนรับของ (เงินสด/โอน)
        </p>
      )}
      {view.status === "delivery_failed" && (
        <p className="rounded-xl bg-stone-100 p-3 text-sm">ร้านยกเลิกหรือส่งไม่สำเร็จ — ติดต่อร้านหากมีคำถาม</p>
      )}
      {(view.status === "refund_pending" || view.status === "refunded" || view.status === "expired") && (
        <p className="rounded-xl bg-stone-100 p-3 text-sm">
          {view.status === "expired" ? "คำสั่งซื้อนี้หมดเวลาชำระหรือถูกยกเลิกแล้ว" : view.status === "refund_pending" ? "ร้านยกเลิกคำสั่งซื้อ และจะคืนเงินให้ — ติดต่อร้านหากมีคำถาม" : "ร้านคืนเงินแล้ว"}
        </p>
      )}
      {(view.notice || error) && <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-800">{view.notice ?? error}</p>}

      <section className="rounded-2xl border bg-white p-4 text-sm">
        <p className="mb-2 font-semibold">{view.fulfillment === "pickup" ? "รับที่ร้าน" : "ส่งถึงบ้าน"} · {view.customerName} ({view.phoneMasked})</p>
        {view.address && <p className="mb-2 text-stone-600">{view.address}</p>}
        {view.items.map((item, i) => (
          <div key={i} className="flex justify-between gap-2 py-1">
            <span>
              {item.quantity}× {item.name}
              {item.detail && <span className="block text-xs text-stone-500">{item.detail}</span>}
            </span>
            <span>{baht(item.totalPrice)}</span>
          </div>
        ))}
        {view.deliveryFee > 0 && (
          <div className="flex justify-between py-1"><span>ค่าส่ง</span><span>{baht(view.deliveryFee)}</span></div>
        )}
        <div className="mt-1 flex justify-between border-t pt-2 font-bold"><span>รวม</span><span>{baht(view.total)}</span></div>
      </section>
      <p className="text-center text-xs text-stone-500">เก็บลิงก์หน้านี้ไว้เพื่อติดตามสถานะ</p>
      <p className="text-center"><Link href={backHref ?? `/s/${slug}`} className="text-sm text-orange-700">{backHref ? "กลับไปประวัติการสั่ง" : "กลับหน้าร้าน"}</Link></p>
      {confirmDialog}
    </main>
  );
}
