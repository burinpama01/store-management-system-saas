"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";

// QR ขอเพลงของร้าน (ไม่ผูกโต๊ะ) — ร้านที่ไม่ได้เปิด QR Order ใช้ QR นี้ติดโต๊ะ/เคาน์เตอร์ได้ทันที
// สร้างรูปในเครื่อง (ไลบรารี qrcode เดิมของโปรเจกต์) ไม่ส่งลิงก์ไปบริการภายนอก

export function StoreMusicQrCard({ url, storeName }: { url: string; storeName: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(url, { width: 480, margin: 2, errorCorrectionLevel: "M" })
      .then((dataUrl) => {
        if (!cancelled) setSrc(dataUrl);
      })
      .catch(() => {
        if (!cancelled) setSrc(null);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  function printQr() {
    if (!src) return;
    const win = window.open("", "_blank", "width=480,height=640");
    if (!win) return;
    const doc = win.document;
    doc.title = `QR ขอเพลง - ${storeName}`;
    const wrap = doc.createElement("div");
    wrap.style.cssText = "font-family:sans-serif;text-align:center;padding:24px";
    const title = doc.createElement("h2");
    title.textContent = storeName;
    const hint = doc.createElement("p");
    hint.textContent = "สแกนเพื่อขอเพลง 🎵";
    const img = doc.createElement("img");
    img.src = src;
    img.style.width = "320px";
    img.onload = () => win.print();
    wrap.append(title, hint, img);
    doc.body.append(wrap);
  }

  return (
    <section className="mb-6 flex flex-col items-center gap-3 rounded-xl border border-gray-100 bg-white p-4 sm:flex-row sm:items-start">
      <div className="shrink-0">
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt="QR ขอเพลงของร้าน" width={160} height={160} className="rounded-md border border-gray-100" />
        ) : (
          <div className="h-40 w-40 animate-pulse rounded-md bg-gray-100" aria-label="กำลังสร้าง QR" />
        )}
      </div>
      <div className="min-w-0 flex-1 text-center sm:text-left">
        <h2 className="text-sm font-semibold text-gray-900">QR ขอเพลงของร้าน</h2>
        <p className="mt-1 text-xs text-gray-500">
          ลูกค้าสแกนแล้วขอเพลงได้เลย ไม่ต้องเปิด QR Order และไม่ผูกโต๊ะ — พิมพ์ติดโต๊ะหรือเคาน์เตอร์ได้
        </p>
        <p className="mt-2 break-all rounded-md bg-gray-50 px-2 py-1 font-mono text-xs text-gray-600">{url}</p>
        <div className="mt-3 flex flex-wrap justify-center gap-2 sm:justify-start">
          <button type="button" onClick={copy} className="btn-secondary min-h-9 text-sm">
            {copied ? "คัดลอกแล้ว" : "คัดลอกลิงก์"}
          </button>
          {src ? (
            <a href={src} download={`qr-music-${storeName}.png`} className="btn-secondary min-h-9 text-sm">
              ดาวน์โหลด QR
            </a>
          ) : null}
          <button type="button" onClick={printQr} disabled={!src} className="btn-secondary min-h-9 text-sm">
            พิมพ์ QR
          </button>
        </div>
      </div>
    </section>
  );
}
