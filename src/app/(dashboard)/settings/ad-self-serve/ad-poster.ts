// รูปโปสเตอร์ QR ลงโฆษณา (PNG) — วาดบน canvas ในเครื่อง ไม่ส่งข้อมูลออกนอกเบราว์เซอร์
// ขนาด 1080×1350 (แนวตั้ง 4:5) ใช้ได้ทั้งโพสต์ Facebook/LINE/IG และพิมพ์ A4/A5

export const AD_POSTER_WIDTH = 1080;
export const AD_POSTER_HEIGHT = 1350;

/** ตัดบรรทัดตามความกว้าง (ภาษาไทยไม่มีเว้นวรรค → ตัดทีละตัวอักษรเมื่อคำยาวเกิน) สูงสุด maxLines บรรทัด ท้ายสุดใส่ … */
export function wrapLines(text: string, maxWidth: number, measure: (s: string) => number, maxLines: number): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const lines: string[] = [];
  let current = "";
  const tokens = clean.split(/(\s)/);
  const pushChars = (word: string) => {
    for (const ch of Array.from(word)) {
      if (measure(current + ch) > maxWidth && current) {
        lines.push(current.trimEnd());
        current = ch.trimStart();
      } else current += ch;
    }
  };
  for (const token of tokens) {
    if (measure(current + token) <= maxWidth) current += token;
    else if (measure(token.trim()) <= maxWidth) {
      if (current.trim()) lines.push(current.trimEnd());
      current = token.trimStart();
    } else pushChars(token);
  }
  if (current.trim()) lines.push(current.trimEnd());
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  let last = kept[maxLines - 1];
  while (last && measure(`${last}…`) > maxWidth) last = Array.from(last).slice(0, -1).join("");
  kept[maxLines - 1] = `${last}…`;
  return kept;
}

/** ชื่อไฟล์ปลอดภัยทุกระบบ */
export function adPosterFileName(storeName: string, kind: "poster" | "qr"): string {
  const safe = storeName.replace(/[/\\:*?"<>|]/g, "_").trim().slice(0, 60) || "store";
  // prefix เป็น ASCII — WebView บางตัว (LINE Android เก่า) ทำชื่อไฟล์ไทยเพี้ยน
  return kind === "poster" ? `ad-poster-${safe}.png` : `qr-ads-${safe}.png`;
}

/** data URL → Blob โดยไม่ใช้ fetch (CSP connect-src อาจไม่อนุญาต data:) */
export function dataUrlToBlob(dataUrl: string): Blob {
  if (!/^data:[^,]*;base64,./.test(dataUrl)) throw new Error("รูป QR ไม่ถูกต้อง");
  const [head, body = ""] = dataUrl.split(",", 2);
  const mime = /data:([^;]+)/.exec(head)?.[1] ?? "image/png";
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("โหลดรูป QR ไม่สำเร็จ"));
    img.src = src;
  });
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** วาดโปสเตอร์แล้วคืน PNG Blob */
export async function renderAdPosterPng(input: { qrDataUrl: string; storeName: string; priceLine: string; url: string }): Promise<Blob> {
  // รอฟอนต์ไทยของหน้าเว็บโหลดครบก่อนวาด ไม่งั้น canvas ใช้ฟอนต์สำรองที่ไม่มีภาษาไทย
  if (typeof document !== "undefined" && document.fonts?.ready) await document.fonts.ready.catch(() => undefined);
  const family = (typeof document !== "undefined" && getComputedStyle(document.body).fontFamily) || "sans-serif";
  const canvas = document.createElement("canvas");
  canvas.width = AD_POSTER_WIDTH;
  canvas.height = AD_POSTER_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("เบราว์เซอร์นี้สร้างรูปไม่ได้");
  const W = AD_POSTER_WIDTH;
  const cx = W / 2;

  ctx.fillStyle = "#eff6ff";
  ctx.fillRect(0, 0, W, AD_POSTER_HEIGHT);
  ctx.fillStyle = "#ffffff";
  roundRect(ctx, 40, 40, W - 80, AD_POSTER_HEIGHT - 80, 48);
  ctx.fill();
  ctx.lineWidth = 10;
  ctx.strokeStyle = "#2563eb";
  ctx.stroke();

  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  const maxText = W - 200;

  ctx.fillStyle = "#1d4ed8";
  ctx.font = `bold 84px ${family}`;
  ctx.fillText("ลงโฆษณาบนจอร้านเรา", cx, 190, maxText);

  ctx.fillStyle = "#334155";
  ctx.font = `600 46px ${family}`;
  const nameLines = wrapLines(input.storeName, maxText, (s) => ctx.measureText(s).width, 2);
  nameLines.forEach((line, i) => ctx.fillText(line, cx, 270 + i * 56));

  const qrSize = 640;
  const qrTop = 270 + Math.max(1, nameLines.length) * 56 + 10;
  const qr = await loadImage(input.qrDataUrl);
  ctx.imageSmoothingEnabled = false; // QR คมทุกจุด
  ctx.drawImage(qr, cx - qrSize / 2, qrTop, qrSize, qrSize);
  ctx.imageSmoothingEnabled = true;

  let y = qrTop + qrSize + 70;
  ctx.fillStyle = "#0f172a";
  ctx.font = `500 40px ${family}`;
  ctx.fillText("สแกนเลือกแพ็ก อัปโหลดวิดีโอ/รูป แล้วจ่ายได้เลย", cx, y, maxText);
  if (input.priceLine) {
    y += 70;
    ctx.fillStyle = "#b45309";
    ctx.font = `bold 52px ${family}`;
    ctx.fillText(input.priceLine, cx, y, maxText);
  }
  ctx.fillStyle = "#64748b";
  ctx.font = `28px ${family}`;
  ctx.fillText(input.url, cx, AD_POSTER_HEIGHT - 80, maxText);

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("สร้างรูปไม่สำเร็จ"))), "image/png");
  });
}

/**
 * บันทึกรูป: มือถือที่แชร์ไฟล์ได้ → เปิดเมนูแชร์ (บันทึกลงรูปภาพ/ส่ง LINE ได้)
 * คอมพิวเตอร์ → ดาวน์โหลดไฟล์ PNG
 */
export async function saveOrShareImage(blob: Blob, fileName: string): Promise<"shared" | "downloaded"> {
  const file = new File([blob], fileName, { type: "image/png" });
  const coarse = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;
  if (coarse && typeof navigator !== "undefined" && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: fileName });
      return "shared";
    } catch (error) {
      // ผู้ใช้กดยกเลิกเมนูแชร์ = จบ ไม่ดาวน์โหลดซ้ำ
      if (error instanceof DOMException && error.name === "AbortError") return "shared";
    }
  }
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
  return "downloaded";
}
