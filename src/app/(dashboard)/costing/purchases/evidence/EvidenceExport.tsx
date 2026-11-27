"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { buildEvidenceCsv, evidenceFileName, orphanFileName } from "@/modules/purchasing/evidence-export";
import { BILL_STATUS_LABELS, EVIDENCE_LABELS, type EvidenceImageRow, type PurchaseBill } from "@/modules/purchasing/types";

const inputClass = "min-h-11 rounded-lg border border-[var(--border)] bg-white px-3 text-[16px] text-[var(--ink)]";
const money = (v: number) => v.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function EvidenceExport({
  from,
  to,
  bills,
  orphanImages,
  supplierNames,
}: {
  from: string;
  to: string;
  bills: PurchaseBill[];
  orphanImages: EvidenceImageRow[];
  supplierNames: Record<string, string>;
}) {
  const router = useRouter();
  const [range, setRange] = useState({ from, to });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const imageCount = bills.reduce((s, b) => s + b.images.length, 0) + orphanImages.length;
  const byKind = (k: PurchaseBill["evidenceKind"]) => bills.filter((b) => b.evidenceKind === k).length;
  const noPhoto = bills.filter((b) => b.images.length === 0 && b.status !== "voided" && b.status !== "rejected").length;
  const supplierOf = (b: PurchaseBill) => b.supplierName ?? (b.supplierId ? supplierNames[b.supplierId] : null) ?? "ไม่ระบุผู้ขาย";

  function csvBlob() {
    return new Blob(["﻿" + buildEvidenceCsv(bills, supplierOf)], { type: "text/csv;charset=utf-8" });
  }

  async function downloadZip() {
    setError(null);
    setBusy("กำลังเตรียมไฟล์…");
    try {
      const { zipSync, strToU8 } = await import("fflate");
      const files: Record<string, Uint8Array> = { "index.csv": strToU8("﻿" + buildEvidenceCsv(bills, supplierOf)) };
      const jobs: Array<{ name: string; url: string | null }> = [
        ...bills.flatMap((b) => b.images.map((img, i) => ({ name: evidenceFileName(b, supplierOf(b), i), url: img.url }))),
        ...orphanImages.map((img) => ({ name: orphanFileName(img), url: img.url })),
      ];
      let done = 0;
      let failed = 0;
      const missing: string[] = [];
      for (const job of jobs) {
        if (!job.url) {
          failed++;
          missing.push(job.name);
          continue;
        }
        try {
          const res = await fetch(job.url);
          if (!res.ok) throw new Error(String(res.status));
          files[job.name] = new Uint8Array(await res.arrayBuffer());
        } catch {
          failed++;
          missing.push(job.name);
        }
        done++;
        setBusy(`กำลังดาวน์โหลดรูป ${done}/${jobs.length}…`);
      }
      if (missing.length > 0) {
        files["ไฟล์ที่ดาวน์โหลดไม่สำเร็จ.txt"] = strToU8(`รูปที่ไม่ได้อยู่ใน ZIP นี้ (${missing.length}) — โหลดหน้าใหม่แล้วดาวน์โหลดอีกครั้ง\r\n${missing.join("\r\n")}`);
      }
      // รูปเป็น JPEG อยู่แล้ว — ไม่บีบซ้ำ (level 0) ให้เร็ว
      const zipped = zipSync(files, { level: 0 });
      download(new Blob([zipped as BlobPart], { type: "application/zip" }), `หลักฐานบิลซื้อ_${from}_${to}.zip`);
      if (failed > 0) setError(`ดาวน์โหลดรูปไม่สำเร็จ ${failed} รูป — ลองโหลดหน้าใหม่แล้วกดอีกครั้ง (ลิงก์รูปหมดอายุใน 1 ชั่วโมง)`);
    } catch {
      setError("สร้างไฟล์ ZIP ไม่สำเร็จ ลองใหม่อีกครั้ง");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <label className="block text-sm">
          <span className="text-[var(--muted)]">ตั้งแต่</span>
          <input type="date" className={`${inputClass} block`} value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
        </label>
        <label className="block text-sm">
          <span className="text-[var(--muted)]">ถึง</span>
          <input type="date" className={`${inputClass} block`} value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
        </label>
        <button type="button" className="btn-secondary min-h-11" onClick={() => router.push(`/costing/purchases/evidence?from=${range.from}&to=${range.to}`)}>
          แสดง
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
          <p className="text-xs text-[var(--muted)]">บิล</p>
          <p className="text-xl font-bold">{bills.length}</p>
        </div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
          <p className="text-xs text-[var(--muted)]">รูปทั้งหมด</p>
          <p className="text-xl font-bold">{imageCount}</p>
        </div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 text-sm">
          <p>ใบกำกับภาษี {byKind("tax_invoice")}</p>
          <p>ใบเสร็จ {byKind("receipt")}</p>
          <p>เขียนมือ {byKind("handwritten")}</p>
        </div>
        <div className={`rounded-xl border p-3 text-sm ${noPhoto > 0 ? "border-amber-200 bg-amber-50 text-amber-900" : "border-[var(--border)] bg-[var(--surface)]"}`}>
          <p className="text-xs">บิลที่ยังไม่มีรูป</p>
          <p className="text-xl font-bold">{noPhoto}</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-primary min-h-11" disabled={!!busy || (bills.length === 0 && orphanImages.length === 0)} onClick={downloadZip}>
          ดาวน์โหลด ZIP (รูป + CSV)
        </button>
        <button type="button" className="btn-secondary min-h-11" disabled={!!busy || bills.length === 0} onClick={() => download(csvBlob(), `บิลซื้อ_${from}_${to}.csv`)}>
          ดาวน์โหลด CSV
        </button>
        {busy && <span className="self-center text-sm text-[var(--muted)]">{busy}</span>}
      </div>
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {bills.length === 0 && orphanImages.length === 0 ? (
        <p className="rounded-xl border border-dashed border-[var(--border)] p-6 text-center text-sm text-[var(--muted)]">ไม่มีบิลในช่วงนี้</p>
      ) : (
        <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
          {bills.map((b) => (
            <li key={b.id} className="space-y-1 p-3 text-sm">
              <div className="flex flex-wrap justify-between gap-2">
                <p className="font-semibold text-[var(--ink)]">
                  {b.billDate} · {supplierOf(b)}
                  {b.billNo ? ` · #${b.billNo}` : ""}
                </p>
                <p className="font-bold">{money(b.total)}</p>
              </div>
              <p className="text-xs text-[var(--muted)]">
                {EVIDENCE_LABELS[b.evidenceKind]} · {BILL_STATUS_LABELS[b.status]}
                {b.vatAmount > 0 ? ` · VAT ${money(b.vatAmount)}` : ""}
                {b.postedByName ? ` · ส่งโดย ${b.postedByName}` : ""}
              </p>
              {b.images.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {b.images.map((img, k) =>
                    img.url ? (
                      <a key={img.id} href={img.url} target="_blank" rel="noreferrer">
                        {/* eslint-disable-next-line @next/next/no-img-element -- signed URL ชั่วคราว */}
                        <img src={img.url} alt={`รูปบิล ${k + 1}`} loading="lazy" className="h-16 w-16 rounded-md border border-[var(--border)] object-cover" />
                      </a>
                    ) : null,
                  )}
                </div>
              )}
            </li>
          ))}
          {orphanImages.length > 0 && (
            <li className="space-y-1 p-3 text-sm">
              <p className="font-semibold text-[var(--ink)]">รูปที่อัปโหลดแต่ไม่ได้ผูกบิล ({orphanImages.length})</p>
              <div className="flex flex-wrap gap-2">
                {orphanImages.map((img) =>
                  img.url ? (
                    <a key={img.id} href={img.url} target="_blank" rel="noreferrer">
                      {/* eslint-disable-next-line @next/next/no-img-element -- signed URL ชั่วคราว */}
                      <img src={img.url} alt="รูปไม่ผูกบิล" loading="lazy" className="h-16 w-16 rounded-md border border-[var(--border)] object-cover" />
                    </a>
                  ) : null,
                )}
              </div>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
