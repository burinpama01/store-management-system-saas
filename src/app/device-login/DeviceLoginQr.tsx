"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import Link from "next/link";

interface Started {
  requestId: string;
  code: string;
  secret: string;
  expiresAt: string;
  approveUrl: string;
}

const POLL_MS = 2000;

function deviceLabel(): string {
  // ชื่อที่โชว์บนมือถือตอนอนุมัติ — ไม่มีชื่อเครื่อง Windows ในเบราว์เซอร์ ใช้ชนิดอุปกรณ์แทน
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (/StoreOSPos/i.test(ua)) return "StoreOS POS (Windows)";
  if (/Windows/i.test(ua)) return "คอมพิวเตอร์ Windows";
  if (/iPad|Macintosh/i.test(ua)) return "iPad / Mac";
  if (/Android/i.test(ua)) return "อุปกรณ์ Android";
  return "อุปกรณ์ไม่ระบุชื่อ";
}

export function DeviceLoginQr({ initialError }: { initialError: string | null }) {
  const [started, setStarted] = useState<Started | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(initialError);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [approved, setApproved] = useState<{ ticket: string } | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  // ไม่ setState ก่อน await (เรียกจาก effect ได้โดยไม่ render ซ้อน) — ค่าเก่าถูกแทนเมื่อได้คำขอใหม่
  const start = useCallback(async () => {
    try {
      const res = await fetch("/api/device-login/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceLabel: deviceLabel() }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "สร้าง QR ไม่สำเร็จ");
      const image = await QRCode.toDataURL(body.approveUrl, { width: 320, margin: 2, errorCorrectionLevel: "M" });
      setApproved(null);
      setStarted(body as Started);
      setQr(image);
    } catch (e) {
      setError(e instanceof Error ? e.message : "สร้าง QR ไม่สำเร็จ");
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void start(), 0);
    return () => clearTimeout(timer);
  }, [start]);

  // นับถอยหลัง + หมดอายุแล้วสร้างใหม่เอง (เครื่องร้านเปิดหน้านี้ค้างไว้ได้)
  useEffect(() => {
    if (!started) return;
    const tick = () => {
      const left = Math.max(0, Math.round((Date.parse(started.expiresAt) - Date.now()) / 1000));
      setSecondsLeft(left);
      if (left === 0) void start();
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [started, start]);

  // ถามผลทุก 2 วิ — อนุมัติแล้วได้ตั๋วครั้งเดียว ส่งแบบ form POST (ตั๋วไม่ค้างใน URL)
  useEffect(() => {
    if (!started || approved) return;
    let stop = false;
    const timer = setInterval(async () => {
      if (stop) return;
      try {
        const res = await fetch("/api/device-login/poll", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requestId: started.requestId, secret: started.secret }),
        });
        const body = (await res.json()) as { status: string; ticket?: string };
        if (body.status === "approved" && body.ticket) {
          stop = true;
          setApproved({ ticket: body.ticket });
        } else if (body.status === "cancelled") {
          setError("คำขอถูกยกเลิก (กดไม่อนุมัติ หรือรหัสพนักงานผิดเกิน 5 ครั้ง) — สร้าง QR ใหม่ให้แล้ว");
          void start();
        }
      } catch {
        // เน็ตสะดุด — รอบหน้าค่อยถามใหม่
      }
    }, POLL_MS);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [started, approved, start]);

  useEffect(() => {
    if (approved) formRef.current?.submit();
  }, [approved]);

  const mm = Math.floor(secondsLeft / 60);
  const ss = String(secondsLeft % 60).padStart(2, "0");

  return (
    <section className="w-full max-w-md rounded-2xl border border-[var(--border,#e6dfd8)] bg-white p-6 text-center shadow-sm">
      <h1 className="text-xl font-bold text-gray-900">เข้าใช้ด้วยมือถือของคุณ</h1>
      <p className="mt-1 text-sm text-gray-600">ไม่ต้องพิมพ์อีเมลหรือรหัสผ่านบนเครื่องนี้</p>

      <div className="mx-auto mt-5 flex h-64 w-64 items-center justify-center rounded-xl border border-gray-200 bg-white">
        {/* eslint-disable-next-line @next/next/no-img-element -- QR เป็น data URL ที่สร้างในหน้า */}
        {qr ? <img src={qr} alt="QR สำหรับเข้าใช้เครื่องนี้" className="h-60 w-60" /> : <span className="text-sm text-gray-400">กำลังสร้าง QR…</span>}
      </div>

      {started && (
        <>
          <p className="mt-4 text-3xl font-extrabold tracking-[0.3em] text-gray-900">{started.code}</p>
          <p className="mt-1 text-xs text-gray-500">หมดอายุใน {mm}:{ss} · หมดแล้วสร้างใหม่ให้เอง</p>
        </>
      )}

      <ol className="mt-5 space-y-1 text-left text-sm text-gray-700">
        <li>1. เปิดกล้องมือถือที่ล็อกอิน StoreOS อยู่ แล้วสแกน QR</li>
        <li>2. ตรวจว่ารหัสบนมือถือตรงกับรหัสบนจอนี้</li>
        <li>3. กรอก <b>รหัสพนักงานของคุณ</b> แล้วกด &quot;อนุญาต&quot;</li>
      </ol>

      {approved && <p className="mt-4 text-sm font-semibold text-emerald-700">อนุมัติแล้ว — กำลังเข้าสู่ระบบ…</p>}
      {error && !approved && <p role="alert" className="mt-4 text-sm text-red-600">{error}</p>}

      {started && (
        <form ref={formRef} method="post" action="/api/device-login/complete" className="hidden">
          <input type="hidden" name="requestId" value={started.requestId} />
          <input type="hidden" name="ticket" value={approved?.ticket ?? ""} />
        </form>
      )}

      <div className="mt-6 flex justify-center gap-4 text-sm">
        <button type="button" onClick={() => { setError(null); void start(); }} className="min-h-11 rounded-lg border border-gray-300 px-4 font-semibold text-gray-700 hover:bg-gray-50">
          สร้าง QR ใหม่
        </button>
        <Link href="/login?method=password" className="flex min-h-11 items-center rounded-lg px-4 font-semibold text-gray-600 hover:text-gray-900">
          ใช้อีเมล/รหัสผ่านแทน
        </Link>
      </div>
    </section>
  );
}
