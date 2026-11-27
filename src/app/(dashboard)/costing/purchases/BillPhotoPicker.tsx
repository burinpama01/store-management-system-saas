"use client";

import { useRef, useState } from "react";
import { MAX_BILL_IMAGES } from "@/modules/purchasing/types";
import { compressImage } from "@/shared/services/image";
import { uploadPurchaseImageAction } from "../purchase-actions";

export interface PickedPhoto {
  id: string;
  preview: string;
}

/**
 * แนบรูปบิล: ย่อในเครื่อง (ด้านยาว 2000px) → อัปโหลดทีละรูป → ได้ imageId
 * รูปที่อัปโหลดแล้วถูกเก็บถาวรเป็นหลักฐาน แม้เอาออกจากบิลนี้ (ไม่มีการลบ)
 */
export function BillPhotoPicker({
  photos,
  onChange,
  required,
}: {
  photos: PickedPhoto[];
  onChange: (next: PickedPhoto[]) => void;
  required?: boolean;
}) {
  const cameraRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handle(files: FileList | null) {
    if (!files || files.length === 0) return;
    setError(null);
    setBusy(true);
    let next = [...photos];
    try {
      for (const file of Array.from(files)) {
        if (next.length >= MAX_BILL_IMAGES) {
          setError(`แนบได้ไม่เกิน ${MAX_BILL_IMAGES} รูป`);
          break;
        }
        let blob: Blob;
        try {
          blob = await compressImage(file, { maxDim: 2000, quality: 0.9 });
        } catch (e) {
          setError(e instanceof Error ? e.message : "อ่านไฟล์รูปไม่ได้");
          continue;
        }
        const form = new FormData();
        form.append("file", new File([blob], "bill.jpg", { type: "image/jpeg" }));
        const result = await uploadPurchaseImageAction(form);
        if (result.error || !result.imageId) {
          setError(result.error ?? "อัปโหลดรูปไม่สำเร็จ");
          continue;
        }
        next = [...next, { id: result.imageId, preview: URL.createObjectURL(blob) }];
        onChange(next);
      }
    } finally {
      setBusy(false);
      if (cameraRef.current) cameraRef.current.value = "";
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-sm text-[var(--muted)]">
        รูปบิล{required ? <span className="font-semibold text-red-700"> * จำเป็นสำหรับบิลเขียนมือ</span> : " (แนะนำ — เก็บเป็นหลักฐานยื่นภาษี)"}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {photos.map((p) => (
          <div key={p.id} className="relative">
            {/* eslint-disable-next-line @next/next/no-img-element -- พรีวิวจาก blob ในเครื่อง */}
            <img src={p.preview} alt="รูปบิล" className="h-20 w-20 rounded-lg border border-[var(--border)] object-cover" />
            <button
              type="button"
              aria-label="เอารูปออกจากบิลนี้"
              className="absolute -right-2 -top-2 grid h-7 w-7 place-items-center rounded-full bg-white text-sm shadow"
              onClick={() => onChange(photos.filter((x) => x.id !== p.id))}
            >
              ×
            </button>
          </div>
        ))}
        <button type="button" className="btn-secondary min-h-11 text-sm" disabled={busy || photos.length >= MAX_BILL_IMAGES} onClick={() => cameraRef.current?.click()}>
          📷 ถ่ายรูป
        </button>
        <button type="button" className="btn-secondary min-h-11 text-sm" disabled={busy || photos.length >= MAX_BILL_IMAGES} onClick={() => fileRef.current?.click()}>
          เลือกรูป
        </button>
        {busy && <span className="text-sm text-[var(--muted)]">กำลังอัปโหลด…</span>}
      </div>
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => handle(e.target.files)} />
      <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => handle(e.target.files)} />
      {error && <p className="text-sm text-red-700">{error}</p>}
    </div>
  );
}
