"use client";

import { useEffect, useState, useTransition } from "react";
import { QrCode } from "@/shared/components/ui/QrCode";
import { issueMemberRedeemCodeAction } from "./actions";

/**
 * การ์ด "แสดงรหัสใช้สิทธิ์" — รหัส 6 หลัก + QR อายุ 5 นาที ใช้ได้ครั้งเดียว
 * แคชเชียร์สแกน QR หรือพิมพ์ตัวเลขที่ POS เพื่อยืนยันว่าเป็นเจ้าของเบอร์จริง
 * นับถอยหลังในเบราว์เซอร์อย่างเดียว ไม่ถามเซิร์ฟเวอร์ซ้ำ (ไม่มี polling)
 */
export function MemberRedeemCodeCard({ storeSlug, portalCode }: { storeSlug: string; portalCode: string }) {
  const [issued, setIssued] = useState<{ code: string; expiresAt: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (!issued) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [issued]);

  const secondsLeft = issued ? Math.max(0, Math.ceil((issued.expiresAt - now) / 1000)) : 0;
  const expired = issued !== null && secondsLeft === 0;

  function requestCode() {
    const formData = new FormData();
    formData.set("storeSlug", storeSlug);
    formData.set("portalCode", portalCode);
    setError(null);
    startTransition(async () => {
      const result = await issueMemberRedeemCodeAction(formData);
      if (result.error || !result.code || !result.expiresAt) {
        setError(result.error ?? "ขอรหัสไม่สำเร็จ กรุณาลองใหม่");
        return;
      }
      const expiresAt = new Date(result.expiresAt).getTime();
      setNow(Date.now());
      setIssued({ code: result.code, expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 300_000 });
    });
  }

  const mm = String(Math.floor(secondsLeft / 60));
  const ss = String(secondsLeft % 60).padStart(2, "0");

  return (
    <section className="rounded-lg border border-[var(--border)] bg-white p-5 shadow-sm" aria-label="รหัสใช้สิทธิ์สมาชิก">
      <h2 className="text-lg font-bold text-[var(--foreground)]">รหัสใช้สิทธิ์ที่ร้าน</h2>
      <p className="mt-1 text-sm text-[var(--muted)]">
        แสดงรหัสนี้ให้แคชเชียร์เมื่อใช้สิทธิ์สมาชิก รหัสใช้ได้ 5 นาทีและครั้งเดียวเท่านั้น ห้ามส่งให้คนอื่น
      </p>

      {issued && !expired ? (
        <div className="mt-4 flex flex-col items-center gap-3">
          <QrCode value={issued.code} size={200} />
          <p className="font-mono text-4xl font-black tracking-[0.3em] text-[var(--foreground)]" aria-live="polite">
            {issued.code.slice(0, 3)} {issued.code.slice(3)}
          </p>
          <p className={`text-sm font-semibold ${secondsLeft <= 60 ? "text-red-600" : "text-[var(--muted)]"}`}>
            หมดอายุใน {mm}:{ss}
          </p>
          <button type="button" className="btn-secondary text-sm" disabled={isPending} onClick={requestCode}>
            ขอรหัสใหม่
          </button>
        </div>
      ) : (
        <div className="mt-4">
          {expired && <p className="mb-2 text-sm font-semibold text-red-600">รหัสหมดอายุแล้ว กดขอรหัสใหม่</p>}
          <button type="button" className="btn-primary w-full" disabled={isPending} onClick={requestCode}>
            {isPending ? "กำลังสร้างรหัส…" : "แสดงรหัสใช้สิทธิ์"}
          </button>
        </div>
      )}
      {error && (
        <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
