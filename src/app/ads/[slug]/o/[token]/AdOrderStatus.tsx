"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { QrCode } from "@/shared/components/ui/QrCode";
import { useConfirm } from "@/shared/components/ui/useConfirm";
import { compressImage } from "@/shared/services/image";
import { cancelAdOrderAction, getAdOrderStatusAction, submitAdSlipAction, type AdOrderView } from "../../actions";

const baht = (n: number) => `${n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ฿`;
const thDate = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString("th-TH", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" })
    : "-";
const DONE = new Set(["active", "rejected", "removed", "expired", "cancelled"]);

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(new Error("อ่านไฟล์สลิปไม่สำเร็จ"));
    reader.readAsDataURL(blob);
  });
}

export function AdOrderStatus({ slug, token }: { slug: string; token: string }) {
  const [view, setView] = useState<AdOrderView | null>(null);
  const [qr, setQr] = useState<AdOrderView["qr"]>(null);
  const [error, setError] = useState<string | null>(null);
  const [slipBusy, setSlipBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const busySince = useRef(0);
  const hasQr = useRef(false);
  const { confirm, confirmDialog } = useConfirm();

  const load = useCallback(async () => {
    if (busySince.current && Date.now() - busySince.current < 20_000) return;
    const startedAt = Date.now();
    busySince.current = startedAt;
    try {
      // ขอ QR ครั้งเดียวต่อการเปิดหน้า (Beam = เรียก provider) — รอบต่อไปถามแค่สถานะ
      const res = await getAdOrderStatusAction(slug, token, !hasQr.current);
      if (res.error || !res.view) {
        setError(res.error ?? "ไม่พบคำสั่ง");
        return;
      }
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
  }, [slug, token]);

  useEffect(() => {
    void load();
  }, [load]);

  const status = view?.status;
  const payMode = view?.payMode;
  useEffect(() => {
    if (!status || DONE.has(status)) return;
    // Beam รอจ่าย = ถามถี่ (webhook เป็นทางหลัก) · สลิป/รออนุมัติ = ถามห่าง
    const ms = status === "pending_payment" && payMode === "beam" ? 4000 : 30000;
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, ms);
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", onVisible);
    return () => {
      window.clearInterval(id);
      window.clearInterval(tick);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", onVisible);
    };
  }, [status, payMode, load]);

  async function uploadSlip(file: File | null) {
    if (!file) return;
    setError(null);
    setSlipBusy(true);
    try {
      // ย่อเป็น JPEG ก่อนส่ง (สลิปจากมือถือใหญ่ได้หลาย MB) — อ่านไม่ได้ค่อยส่งไฟล์เดิม
      const blob = await compressImage(file, { maxDim: 1600, quality: 0.85 }).catch(() => file);
      const base64 = await blobToBase64(blob);
      const res = await submitAdSlipAction(slug, token, base64, blob.type || "image/jpeg");
      if (!res.ok) setError(res.error ?? "ตรวจสลิปไม่สำเร็จ");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "แนบสลิปไม่สำเร็จ");
    } finally {
      setSlipBusy(false);
    }
  }

  if (error && !view) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-3 bg-white p-6 text-center text-stone-800">
        <p className="text-lg font-semibold">{error}</p>
        <Link href={`/ads/${encodeURIComponent(slug)}`} className="text-sm text-blue-700 underline">
          กลับหน้าลงโฆษณา
        </Link>
      </main>
    );
  }
  if (!view) {
    return <main className="flex min-h-screen items-center justify-center bg-white text-sm text-stone-500">กำลังโหลด...</main>;
  }

  const secondsLeft = view.expiresAt ? Math.max(0, Math.floor((Date.parse(view.expiresAt) - now) / 1000)) : 0;
  const tone =
    view.status === "active"
      ? "bg-emerald-50 text-emerald-800 border-emerald-200"
      : view.status === "pending_review"
        ? "bg-amber-50 text-amber-900 border-amber-200"
        : view.status === "pending_payment"
          ? "bg-blue-50 text-blue-800 border-blue-200"
          : "bg-stone-100 text-stone-700 border-stone-200";

  return (
    <main className="min-h-screen bg-stone-50 text-stone-800">
      <div className="mx-auto max-w-md space-y-4 px-4 py-6">
        <header className="rounded-2xl border border-stone-200 bg-white p-4">
          <p className="text-xs text-stone-500">ลงโฆษณาบนจอ · {view.storeName}</p>
          <h1 className="mt-1 text-lg font-bold">
            {view.packageName} · {baht(view.amount)}
          </h1>
          <p className="text-sm text-stone-600">ผู้ลงโฆษณา: {view.advertiserName}</p>
          <p className={`mt-3 rounded-lg border px-3 py-2 text-sm font-semibold ${tone}`}>{view.statusLabel}</p>
          {view.statusReason && view.status !== "active" ? <p className="mt-2 text-sm text-stone-600">เหตุผล: {view.statusReason}</p> : null}
        </header>

        {view.notice ? <p className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">{view.notice}</p> : null}
        {error ? (
          <p className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">
            {error}
          </p>
        ) : null}

        {view.status === "pending_payment" && view.payMode ? (
          <section className="space-y-3 rounded-2xl border border-stone-200 bg-white p-4 text-center">
            <h2 className="font-semibold">③ จ่ายเงิน {baht(view.amount)}</h2>
            <div className="flex justify-center">
              {qr?.payload ? (
                <QrCode value={qr.payload} size={220} />
              ) : qr?.image ? (
                // eslint-disable-next-line @next/next/no-img-element -- QR จาก Beam เป็น base64
                <img src={`data:image/png;base64,${qr.image}`} alt="QR ชำระเงิน" className="h-[220px] w-[220px]" />
              ) : (
                <p className="py-16 text-sm text-stone-500">กำลังสร้าง QR...</p>
              )}
            </div>
            <p className="text-sm text-stone-600">
              {view.payMode === "beam"
                ? "สแกนด้วยแอปธนาคาร ระบบยืนยันอัตโนมัติ — หน้านี้จะเปลี่ยนเองเมื่อจ่ายแล้ว"
                : "สแกนโอนเข้าพร้อมเพย์ของร้าน แล้วแนบสลิปด้านล่าง"}
            </p>
            {view.payMode === "slip" ? (
              <label className={`flex min-h-12 cursor-pointer items-center justify-center rounded-xl bg-blue-600 px-4 font-semibold text-white ${slipBusy ? "opacity-60" : ""}`}>
                {slipBusy ? "กำลังตรวจสลิป..." : "แนบสลิปการโอน"}
                <input type="file" accept="image/*" className="sr-only" disabled={slipBusy} onChange={(e) => void uploadSlip(e.target.files?.[0] ?? null)} />
              </label>
            ) : null}
            <p className="text-xs text-stone-500">
              {secondsLeft > 0 ? `ชำระภายใน ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, "0")} นาที` : "หมดเวลาชำระ — ถ้าจ่ายไปแล้วรอสักครู่"}
            </p>
          </section>
        ) : null}

        {view.status === "active" ? (
          <section className="rounded-2xl border border-emerald-200 bg-white p-4 text-sm">
            <p className="font-semibold text-emerald-800">✅ โฆษณาขึ้นจอแล้ว (จอร้านอัปเดตภายในไม่กี่นาที)</p>
            <p className="mt-1">แสดงถึง {thDate(view.endsAt)}</p>
            <p className="mt-1 text-xs text-stone-500">เก็บลิงก์นี้ไว้ดูสถานะ · หลักฐานการจ่าย {view.paymentRef ?? "-"} เมื่อ {thDate(view.paidAt)}</p>
          </section>
        ) : null}

        {view.status === "pending_review" ? (
          <section className="rounded-2xl border border-amber-200 bg-white p-4 text-sm">
            <p>ได้รับเงินแล้ว ร้านจะตรวจโฆษณาก่อนขึ้นจอ — นับวันแสดงตั้งแต่ร้านอนุมัติ</p>
            <p className="mt-1 text-xs text-stone-500">หลักฐานการจ่าย {view.paymentRef ?? "-"} เมื่อ {thDate(view.paidAt)}</p>
          </section>
        ) : null}

        {view.status === "rejected" || view.status === "removed" ? (
          <p className="rounded-xl border border-stone-200 bg-white p-4 text-sm">เงินค่าโฆษณาอยู่ที่ร้าน — ติดต่อร้านเรื่องการคืนเงิน</p>
        ) : null}

        {view.mediaUrl ? (
          <section className="rounded-2xl border border-stone-200 bg-white p-3">
            <p className="mb-2 text-xs text-stone-500">ไฟล์โฆษณา</p>
            {view.mediaType === "video" ? (
              <video src={view.mediaUrl} className="max-h-64 w-full rounded-lg bg-black object-contain" muted playsInline controls />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element -- ไฟล์โฆษณาของผู้ลง
              <img src={view.mediaUrl} alt="ไฟล์โฆษณา" className="max-h-64 w-full rounded-lg object-contain" />
            )}
          </section>
        ) : null}

        {view.status === "pending_payment" ? (
          <button
            type="button"
            className="w-full text-sm text-stone-500 underline"
            onClick={async () => {
              if (!(await confirm({ title: "ยกเลิกคำสั่งนี้?", message: "ถ้าจ่ายไปแล้วอย่ายกเลิก — รอให้หน้านี้เปลี่ยนเป็นจ่ายแล้ว", confirmLabel: "ยกเลิกคำสั่ง", cancelLabel: "กลับ", danger: true }))) return;
              const res = await cancelAdOrderAction(token);
              if (res.error) setError(res.error);
              await load();
            }}
          >
            ยกเลิกคำสั่ง
          </button>
        ) : null}
        {view.status === "cancelled" || view.status === "expired" ? (
          <Link href={`/ads/${encodeURIComponent(slug)}`} className="block text-center text-sm text-blue-700 underline">
            ลงโฆษณาใหม่
          </Link>
        ) : null}
      </div>
      {confirmDialog}
    </main>
  );
}
