"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { cheapestStoreAdPackage, type StoreAdPackage } from "@/modules/ad-self-serve/rules";

// QR ลงโฆษณาของร้าน — สร้างรูปในเครื่อง (ไลบรารี qrcode เดิม) ไม่ส่งลิงก์ไปบริการภายนอก
// พิมพ์เป็นโปสเตอร์ติดร้าน: ชื่อร้าน + "ลงโฆษณาบนจอร้านเรา" + ราคาเริ่มต้น

function money(value: number) {
  return new Intl.NumberFormat("th-TH", { maximumFractionDigits: 2 }).format(value);
}

export function StoreAdQrCard({
  url,
  storeName,
  packages,
}: {
  url: string;
  storeName: string;
  packages: StoreAdPackage[];
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const cheapest = cheapestStoreAdPackage(packages);
  const priceLine = cheapest ? `เริ่ม ${money(cheapest.price)} บาท / ${cheapest.name}` : "";

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(url, { width: 600, margin: 2, errorCorrectionLevel: "M" })
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

  function printPoster() {
    if (!src) return;
    const win = window.open("", "_blank", "width=520,height=760");
    if (!win) return;
    const doc = win.document;
    doc.title = `QR ลงโฆษณา - ${storeName}`;
    const wrap = doc.createElement("div");
    wrap.style.cssText =
      "font-family:sans-serif;text-align:center;padding:32px;border:3px solid #2563eb;border-radius:20px;margin:16px";
    const title = doc.createElement("h1");
    title.textContent = "ลงโฆษณาบนจอร้านเรา";
    title.style.cssText = "margin:0 0 4px;font-size:30px;color:#1d4ed8";
    const store = doc.createElement("p");
    store.textContent = storeName;
    store.style.cssText = "margin:0 0 12px;font-size:18px;color:#334155";
    const img = doc.createElement("img");
    img.src = src;
    img.style.width = "340px";
    img.onload = () => win.print();
    const hint = doc.createElement("p");
    hint.textContent = "สแกนเพื่อเลือกแพ็ก อัปโหลดวิดีโอ และจ่ายเงินได้เลย";
    hint.style.cssText = "margin:12px 0 4px;font-size:16px";
    const price = doc.createElement("p");
    price.textContent = priceLine;
    price.style.cssText = "margin:0;font-size:20px;font-weight:700";
    wrap.append(title, store, img, hint, price);
    doc.body.append(wrap);
  }

  return (
    <section className="section-card flex flex-col items-center gap-4 sm:flex-row sm:items-start">
      <div className="shrink-0">
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt="QR ลงโฆษณาของร้าน" width={160} height={160} className="rounded-md border border-[var(--border)]" />
        ) : (
          <div className="h-40 w-40 animate-pulse rounded-md bg-[var(--surface-muted)]" aria-label="กำลังสร้าง QR" />
        )}
      </div>
      <div className="min-w-0 flex-1 text-center sm:text-left">
        <h2 className="text-sm font-semibold text-[var(--text)]">QR ลงโฆษณาของร้าน</h2>
        <p className="mt-1 text-xs text-[var(--muted)]">
          พิมพ์ติดหน้าร้าน/เคาน์เตอร์ ลูกค้าสแกนแล้วลงโฆษณาเองได้ ร้านไม่ต้องตั้งค่าทีละโฆษณา {priceLine ? `· ${priceLine}` : ""}
        </p>
        <p className="mt-2 break-all rounded-md bg-[var(--surface-muted)] px-2 py-1 font-mono text-xs text-[var(--muted)]">{url}</p>
        <div className="mt-3 flex flex-wrap justify-center gap-2 sm:justify-start">
          <button type="button" onClick={copy} className="btn-secondary min-h-9 text-sm">
            {copied ? "คัดลอกแล้ว" : "คัดลอกลิงก์"}
          </button>
          {src ? (
            <a href={src} download={`qr-ads-${storeName}.png`} className="btn-secondary min-h-9 text-sm">
              ดาวน์โหลด QR
            </a>
          ) : null}
          <button type="button" onClick={printPoster} disabled={!src} className="btn-primary min-h-9 text-sm">
            พิมพ์โปสเตอร์
          </button>
        </div>
      </div>
    </section>
  );
}
