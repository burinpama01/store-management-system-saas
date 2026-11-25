"use client";

import { useRef, useState } from "react";
import type { ScannedBillDraft } from "@/modules/purchasing/bill-scan";
import { compressImage } from "@/shared/services/image";
import { scanPurchaseBillAction, uploadPurchaseImageAction } from "../purchase-actions";
import type { PickedPhoto } from "./BillPhotoPicker";

/**
 * A2: ถ่ายบิล → อัปโหลดเข้าคลังหลักฐาน (เก็บถาวร) → AI อ่าน → ส่งร่างให้ฟอร์มเติม
 * คนตรวจและกดบันทึกเองเสมอ · AI ล้ม → แจ้งแล้วกรอกเองต่อได้ (รูปยังแนบอยู่)
 */
export function ScanBillButton({ onScanned }: { onScanned: (result: { photo: PickedPhoto; draft: ScannedBillDraft | null; error: string | null }) => void }) {
  const cameraRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function handle(files: FileList | null) {
    const file = files?.[0];
    if (cameraRef.current) cameraRef.current.value = "";
    if (fileRef.current) fileRef.current.value = "";
    if (!file) return;
    setBusy("กำลังย่อและอัปโหลดรูป…");
    try {
      let blob: Blob;
      try {
        blob = await compressImage(file, { maxDim: 2000, quality: 0.9 });
      } catch (e) {
        onScanned({ photo: { id: "", preview: "" }, draft: null, error: e instanceof Error ? e.message : "อ่านไฟล์รูปไม่ได้" });
        return;
      }
      const form = new FormData();
      form.append("file", new File([blob], "bill.jpg", { type: "image/jpeg" }));
      const uploaded = await uploadPurchaseImageAction(form);
      if (uploaded.error || !uploaded.imageId) {
        onScanned({ photo: { id: "", preview: "" }, draft: null, error: uploaded.error ?? "อัปโหลดรูปไม่สำเร็จ" });
        return;
      }
      const photo = { id: uploaded.imageId, preview: URL.createObjectURL(blob) };
      setBusy("AI กำลังอ่านบิล…");
      const scanned = await scanPurchaseBillAction(uploaded.imageId);
      onScanned({ photo, draft: scanned.draft ?? null, error: scanned.error });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className="btn-primary min-h-11" disabled={!!busy} onClick={() => cameraRef.current?.click()}>
        📷 ถ่ายบิลให้ AI อ่าน
      </button>
      <button type="button" className="btn-secondary min-h-11 text-sm" disabled={!!busy} onClick={() => fileRef.current?.click()}>
        เลือกรูปบิล
      </button>
      {busy && <span className="text-sm text-[var(--muted)]">{busy}</span>}
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => handle(e.target.files)} />
      <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => handle(e.target.files)} />
    </div>
  );
}

/** สรุปผล AI เป็นข้อความเตือนบนฟอร์ม */
export function scanSummary(draft: ScannedBillDraft): { tone: "ok" | "warn"; text: string } {
  const unmatched = draft.lines.filter((l) => l.match.kind === "none").length;
  const parts = [`AI อ่านได้ ${draft.lines.length} บรรทัด`];
  if (unmatched > 0) parts.push(`เลือกวัตถุดิบ/หมวดเอง ${unmatched} บรรทัด`);
  if (draft.paymentHint === "credit") parts.push("ดูเป็นบิลเงินเชื่อ — ตั้งเป็นค้างจ่ายให้แล้ว");
  if (!draft.billDate) parts.push("อ่านวันที่ไม่ได้ — ตรวจวันที่");
  parts.push(...draft.check.warnings);
  const tone = draft.check.totalMatches && unmatched === 0 && draft.check.lineIssues.length === 0 ? "ok" : "warn";
  return { tone, text: `${parts.join(" · ")} — ตรวจทุกบรรทัดก่อนบันทึก` };
}
