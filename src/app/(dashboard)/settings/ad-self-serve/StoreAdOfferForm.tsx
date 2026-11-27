"use client";

import { useState, useTransition } from "react";
import { CUSTOMER_DISPLAY_IMAGE_MAX_BYTES, CUSTOMER_DISPLAY_VIDEO_MAX_BYTES } from "@/modules/settings/customer-display";
import {
  STORE_AD_PACKAGE_LIMIT,
  STORE_AD_TERMS_MAX,
  type StoreAdOffer,
  type StoreAdPackage,
  type StoreAdSlot,
} from "@/modules/ad-self-serve/rules";
import { saveStoreAdOfferAction } from "./actions";

const field = "form-input";
// ใช้ลิมิตเดียวกับการอัปโหลดสื่อจอลูกค้า (แหล่งความจริงเดียว)
const videoMaxMb = Math.round(CUSTOMER_DISPLAY_VIDEO_MAX_BYTES / (1024 * 1024));
const imageMaxMb = Math.round(CUSTOMER_DISPLAY_IMAGE_MAX_BYTES / (1024 * 1024));
// iOS ซูมเมื่อ input เล็กกว่า 16px (ดูบันทึก POS แผง iPad) — บังคับ 16px
const inputStyle = { fontSize: 16 } as const;

interface PackageDraft {
  id: string;
  name: string;
  days: string;
  price: string;
}

function toDraft(pkg: StoreAdPackage): PackageDraft {
  return { id: pkg.id, name: pkg.name, days: String(pkg.days), price: String(pkg.price) };
}

export function StoreAdOfferForm({ offer }: { offer: StoreAdOffer }) {
  const [enabled, setEnabled] = useState(offer.enabled);
  const [autoPublish, setAutoPublish] = useState(offer.autoPublish);
  const [slot, setSlot] = useState<StoreAdSlot>(offer.slot);
  const [maxConcurrent, setMaxConcurrent] = useState(String(offer.maxConcurrent));
  const [maxVideoSeconds, setMaxVideoSeconds] = useState(String(offer.maxVideoSeconds));
  const [allowVideo, setAllowVideo] = useState(offer.allowVideo);
  const [allowImage, setAllowImage] = useState(offer.allowImage);
  const [terms, setTerms] = useState(offer.terms);
  const [packages, setPackages] = useState<PackageDraft[]>(offer.packages.map(toDraft));
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function updatePackage(index: number, patch: Partial<PackageDraft>) {
    setPackages((current) => current.map((pkg, i) => (i === index ? { ...pkg, ...patch } : pkg)));
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setMessage(null);
    startTransition(async () => {
      const result = await saveStoreAdOfferAction({
        enabled,
        autoPublish,
        slot,
        maxConcurrent: Number(maxConcurrent),
        maxVideoSeconds: Number(maxVideoSeconds),
        allowVideo,
        allowImage,
        terms,
        packages: packages.map((pkg) => ({ id: pkg.id, name: pkg.name, days: Number(pkg.days), price: Number(pkg.price) })),
      });
      setMessage(result.error ? { kind: "error", text: result.error } : { kind: "ok", text: "บันทึกแล้ว" });
    });
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <section className="section-card space-y-4">
        <label className="flex items-center justify-between gap-3">
          <span>
            <span className="block font-semibold text-[var(--text)]">รับลงโฆษณา</span>
            <span className="block text-xs text-[var(--muted)]">เปิดแล้วลูกค้าสแกน QR ลงโฆษณาได้ทันที ปิดเมื่อไรหน้าลงโฆษณาจะไม่รับคำสั่งใหม่</span>
          </span>
          <input type="checkbox" className="h-6 w-6" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        </label>
        <label className="flex items-center justify-between gap-3">
          <span>
            <span className="block font-semibold text-[var(--text)]">จ่ายแล้วขึ้นจอทันที</span>
            <span className="block text-xs text-[var(--muted)]">ปิดไว้ = ร้านต้องกดอนุมัติก่อนขึ้นจอ (ถ้าไม่อนุมัติ ร้านคืนเงินลูกค้าเอง)</span>
          </span>
          <input type="checkbox" className="h-6 w-6" checked={autoPublish} onChange={(e) => setAutoPublish(e.target.checked)} />
        </label>
      </section>

      <section className="section-card space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-semibold text-[var(--text)]">แพ็กราคา</h2>
          <button
            type="button"
            className="btn-secondary min-h-9 text-sm"
            disabled={packages.length >= STORE_AD_PACKAGE_LIMIT}
            onClick={() => setPackages((current) => [...current, { id: "", name: "", days: "1", price: "" }])}
          >
            + เพิ่มแพ็ก
          </button>
        </div>
        <p className="text-xs text-[var(--muted)]">เงินค่าโฆษณาเข้าบัญชีร้านโดยตรง (Beam ของร้าน หรือโอนพร้อมเพย์ + สลิป)</p>
        {packages.map((pkg, index) => (
          <div key={`${pkg.id}-${index}`} className="grid grid-cols-[1fr_88px_104px_auto] items-end gap-2">
            <label className="text-xs font-semibold text-[var(--text)]">
              ชื่อแพ็ก
              <input className={field} style={inputStyle} value={pkg.name} maxLength={40} onChange={(e) => updatePackage(index, { name: e.target.value })} />
            </label>
            <label className="text-xs font-semibold text-[var(--text)]">
              จำนวนวัน
              <input className={field} style={inputStyle} type="number" min={1} max={365} value={pkg.days} onChange={(e) => updatePackage(index, { days: e.target.value })} />
            </label>
            <label className="text-xs font-semibold text-[var(--text)]">
              ราคา (บาท)
              <input className={field} style={inputStyle} type="number" min={1} step="0.01" value={pkg.price} onChange={(e) => updatePackage(index, { price: e.target.value })} />
            </label>
            <button
              type="button"
              className="btn-secondary min-h-10 text-sm"
              disabled={packages.length <= 1}
              onClick={() => setPackages((current) => current.filter((_, i) => i !== index))}
              aria-label={`ลบแพ็ก ${pkg.name}`}
            >
              ลบ
            </button>
          </div>
        ))}
      </section>

      <section className="section-card grid gap-3 sm:grid-cols-2">
        <label className="text-sm font-semibold text-[var(--text)]">
          ช่องที่ขาย
          <select className={field} style={inputStyle} value={slot} onChange={(e) => setSlot(e.target.value as StoreAdSlot)}>
            <option value="any">ทุกช่องที่เปิด (หมุนร่วมกับโฆษณาร้าน)</option>
            <option value="top">เฉพาะช่องบน (โหมดแบ่งครึ่ง)</option>
            <option value="bottom">เฉพาะช่องล่าง (โหมดแบ่งครึ่ง)</option>
          </select>
        </label>
        <label className="text-sm font-semibold text-[var(--text)]">
          โฆษณาลูกค้าพร้อมกันสูงสุด
          <input className={field} style={inputStyle} type="number" min={1} max={12} value={maxConcurrent} onChange={(e) => setMaxConcurrent(e.target.value)} />
          <span className="block text-[11px] font-medium text-[var(--muted)]">เต็มแล้วหน้าลงโฆษณาจะแจ้งวันที่ว่างถัดไป</span>
        </label>
        <label className="text-sm font-semibold text-[var(--text)]">
          ความยาววิดีโอสูงสุด (วินาที)
          <input className={field} style={inputStyle} type="number" min={5} max={600} value={maxVideoSeconds} onChange={(e) => setMaxVideoSeconds(e.target.value)} />
        </label>
        <div className="space-y-2 text-sm font-semibold text-[var(--text)]">
          รับสื่อแบบ
          <label className="flex items-center gap-2 font-normal">
            <input type="checkbox" checked={allowVideo} onChange={(e) => setAllowVideo(e.target.checked)} /> วิดีโอ (ไม่เกิน {videoMaxMb} MB)
          </label>
          <label className="flex items-center gap-2 font-normal">
            <input type="checkbox" checked={allowImage} onChange={(e) => setAllowImage(e.target.checked)} /> รูปภาพ (ไม่เกิน {imageMaxMb} MB)
          </label>
        </div>
        <label className="text-sm font-semibold text-[var(--text)] sm:col-span-2">
          เงื่อนไขที่ลูกค้าต้องยอมรับ
          <textarea className={field} style={inputStyle} rows={3} maxLength={STORE_AD_TERMS_MAX} value={terms} onChange={(e) => setTerms(e.target.value)} />
        </label>
      </section>

      {message ? (
        <p className={message.kind === "ok" ? "alert-success text-sm" : "alert-danger text-sm"} role="status">
          {message.text}
        </p>
      ) : null}
      <button type="submit" className="btn-primary min-h-11 w-full sm:w-auto" disabled={pending}>
        {pending ? "กำลังบันทึก..." : "บันทึก"}
      </button>
    </form>
  );
}
