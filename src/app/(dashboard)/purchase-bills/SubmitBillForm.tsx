"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { needsApproval } from "@/modules/purchasing/access-policy";
import {
  BILL_STATUS_LABELS,
  EVIDENCE_KINDS,
  EVIDENCE_LABELS,
  type EvidenceKind,
  type ExpenseCategory,
  type PayMethod,
  type PurchaseBill,
} from "@/modules/purchasing/types";
import { billTotals } from "@/modules/purchasing/validate";
import { postPurchaseBillAction } from "../costing/purchase-actions";
import { BillPhotoPicker, type PickedPhoto } from "../costing/purchases/BillPhotoPicker";

const inputClass = "min-h-11 w-full rounded-lg border border-[var(--border)] bg-white px-3 text-[16px] text-[var(--ink)]";
const money = (v: number) => v.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const n = (v: string) => (v.trim() === "" ? NaN : Number(v));

interface LineDraft {
  key: string;
  target: string; // "i:<id>" | "c:<id>" | ""
  rawName: string;
  qty: string;
  lineTotal: string;
}
const emptyLine = (): LineDraft => ({ key: `l-${Math.random().toString(36).slice(2)}`, target: "", rawName: "", qty: "1", lineTotal: "" });
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(new Date());
const PAY_OPTIONS = [
  ["cash", "จ่ายเงินสดจากลิ้นชัก"],
  ["transfer", "โอนแล้ว"],
  ["unpaid", "ยังไม่จ่าย"],
] as const;

export function SubmitBillForm({
  ingredients,
  categories,
  myBills,
  role,
}: {
  ingredients: Array<{ id: string; name: string; purchaseUnit: string }>;
  categories: ExpenseCategory[];
  myBills: PurchaseBill[];
  role: string;
}) {
  const router = useRouter();
  const [kind, setKind] = useState<EvidenceKind>("handwritten");
  const [supplierName, setSupplierName] = useState("");
  const [billNo, setBillNo] = useState("");
  const [billDate, setBillDate] = useState(today());
  const [lines, setLines] = useState<LineDraft[]>([emptyLine()]);
  const [pay, setPay] = useState<"cash" | "transfer" | "unpaid">("cash");
  const [note, setNote] = useState("");
  const [photos, setPhotos] = useState<PickedPhoto[]>([]);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();
  const totals = billTotals(lines.map((l) => ({ lineTotal: Number(l.lineTotal) || 0 })), 0, 0);
  const ingById = new Map(ingredients.map((i) => [i.id, i]));
  const pendingApproval = needsApproval(role, kind);

  function setLine(i: number, patch: Partial<LineDraft>) {
    setLines((ls) =>
      ls.map((l, j) => {
        if (j !== i) return l;
        const next = { ...l, ...patch };
        if ("target" in patch && next.target.startsWith("i:") && !next.rawName) next.rawName = ingById.get(next.target.slice(2))?.name ?? "";
        return next;
      }),
    );
  }

  function submit() {
    if (kind === "handwritten" && photos.length === 0) return setMessage({ tone: "error", text: "ถ่ายรูปบิลเขียนมือแนบอย่างน้อย 1 รูป" });
    const filled = lines.filter((l) => l.target || l.rawName.trim() || l.lineTotal.trim());
    for (const [i, l] of filled.entries()) {
      if (!l.target) return setMessage({ tone: "error", text: `บรรทัด ${i + 1}: เลือกวัตถุดิบ หรือหมวดค่าใช้จ่าย` });
      if (!(n(l.qty) > 0)) return setMessage({ tone: "error", text: `บรรทัด ${i + 1}: ใส่จำนวน` });
      if (!(n(l.lineTotal) >= 0)) return setMessage({ tone: "error", text: `บรรทัด ${i + 1}: ใส่ยอดเงิน` });
    }
    setMessage(null);
    startTransition(async () => {
      const result = await postPurchaseBillAction({
        supplierId: null,
        supplierName: supplierName || null,
        billNo: billNo || null,
        billDate,
        evidenceKind: kind,
        discount: 0,
        vatAmount: 0,
        total: totals.total,
        paymentStatus: pay === "unpaid" ? "unpaid" : "paid",
        paymentMethod: pay === "unpaid" ? null : (pay as PayMethod),
        dueDate: null,
        note: note || null,
        source: "manual",
        imageIds: photos.map((p) => p.id),
        lines: filled.map((l) => {
          const ingId = l.target.startsWith("i:") ? l.target.slice(2) : null;
          return {
            ingredientId: ingId,
            expenseCategoryId: l.target.startsWith("c:") ? l.target.slice(2) : null,
            rawName: l.rawName,
            qty: n(l.qty),
            unitLabel: ingId ? ingById.get(ingId)?.purchaseUnit || null : null,
            unitPrice: Math.round((n(l.lineTotal) / n(l.qty)) * 10000) / 10000,
            lineTotal: n(l.lineTotal),
          };
        }),
      });
      if (result.error) return setMessage({ tone: "error", text: result.error });
      setMessage({
        tone: "ok",
        text: result.status === "pending" ? `ส่งบิล ${money(totals.total)} บาทแล้ว — รออนุมัติ` : `บันทึกบิล ${money(totals.total)} บาท และรับเข้าคลังแล้ว`,
      });
      setSupplierName("");
      setBillNo("");
      setLines([emptyLine()]);
      setNote("");
      setPhotos([]);
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      {message && (
        <p role="status" className={`rounded-lg px-3 py-2 text-sm ${message.tone === "ok" ? "bg-green-50 text-green-800" : "bg-red-50 text-red-700"}`}>
          {message.text}
        </p>
      )}
      <div className="space-y-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <div className="flex flex-wrap gap-2">
          {EVIDENCE_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className={`min-h-10 rounded-full border px-3 text-sm ${kind === k ? "border-[var(--tenant-primary)] bg-[var(--tenant-primary)] text-white" : "border-[var(--border)]"}`}
            >
              {EVIDENCE_LABELS[k]}
            </button>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block text-sm">
            <span className="text-[var(--muted)]">ซื้อจาก (ร้าน/แผงตลาด)</span>
            <input className={inputClass} maxLength={120} value={supplierName} onChange={(e) => setSupplierName(e.target.value)} placeholder="เช่น ตลาดสดเช้า แผงป้าแดง" />
          </label>
          <label className="block text-sm">
            <span className="text-[var(--muted)]">เลขที่บิล (ถ้ามี)</span>
            <input className={inputClass} maxLength={60} value={billNo} onChange={(e) => setBillNo(e.target.value)} />
          </label>
          <label className="block text-sm">
            <span className="text-[var(--muted)]">วันที่ซื้อ</span>
            <input type="date" className={inputClass} value={billDate} onChange={(e) => setBillDate(e.target.value)} />
          </label>
        </div>
        <div className="space-y-2">
          {lines.map((l, i) => {
            const ing = l.target.startsWith("i:") ? ingById.get(l.target.slice(2)) : undefined;
            return (
              <div key={l.key} className="grid gap-2 rounded-lg border border-[var(--border)] p-2 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1.2fr)_80px_110px_auto]">
                <select aria-label="วัตถุดิบหรือหมวด" className={inputClass} value={l.target} onChange={(e) => setLine(i, { target: e.target.value })}>
                  <option value="">เลือกวัตถุดิบ / หมวดค่าใช้จ่าย</option>
                  <optgroup label="วัตถุดิบ (เข้าคลังเมื่ออนุมัติ)">
                    {ingredients.map((it) => (
                      <option key={it.id} value={`i:${it.id}`}>
                        {it.name}
                        {it.purchaseUnit ? ` (${it.purchaseUnit})` : ""}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="ค่าใช้จ่ายอื่น">
                    {categories.map((c) => (
                      <option key={c.id} value={`c:${c.id}`}>{c.name}</option>
                    ))}
                  </optgroup>
                </select>
                <input aria-label="ชื่อของ" className={inputClass} placeholder="ชื่อของในบิล" maxLength={200} value={l.rawName} onChange={(e) => setLine(i, { rawName: e.target.value })} />
                <input aria-label="จำนวน" className={inputClass} inputMode="decimal" placeholder={ing?.purchaseUnit || "จำนวน"} value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} />
                <input aria-label="ยอดเงิน" className={inputClass} inputMode="decimal" placeholder="บาท" value={l.lineTotal} onChange={(e) => setLine(i, { lineTotal: e.target.value })} />
                <button type="button" className="btn-secondary min-h-11 text-sm" disabled={lines.length === 1} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
                  ลบ
                </button>
              </div>
            );
          })}
          <button type="button" className="btn-secondary min-h-10 text-sm" onClick={() => setLines((ls) => [...ls, emptyLine()])}>
            + เพิ่มรายการ
          </button>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-2 text-sm">
            {PAY_OPTIONS.map(([k, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => setPay(k)}
                className={`min-h-10 rounded-full border px-3 ${pay === k ? "border-[var(--tenant-primary)] bg-[var(--tenant-primary)] text-white" : "border-[var(--border)]"}`}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="text-lg font-bold text-[var(--ink)]">รวม {money(totals.total)} บาท</p>
        </div>
        <label className="block text-sm">
          <span className="text-[var(--muted)]">หมายเหตุ</span>
          <input className={inputClass} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <BillPhotoPicker photos={photos} onChange={setPhotos} required={kind === "handwritten"} />
        {pendingApproval && (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            ต้องรออนุมัติ — ของเข้าคลังเมื่ออนุมัติแล้ว{pay === "cash" ? " · เงินสดตัดจากลิ้นชักทันทีที่ส่ง" : ""}
          </p>
        )}
        <button type="button" className="btn-primary min-h-11 w-full sm:w-auto" disabled={isPending} onClick={submit}>
          {pendingApproval ? "ส่งให้อนุมัติ" : "บันทึกบิล"}
        </button>
      </div>

      <div className="space-y-2">
        <h2 className="text-base font-semibold text-[var(--ink)]">บิลที่ฉันส่ง</h2>
        {myBills.length === 0 ? (
          <p className="rounded-xl border border-dashed border-[var(--border)] p-4 text-center text-sm text-[var(--muted)]">ยังไม่มี</p>
        ) : (
          <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
            {myBills.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                <div className="min-w-0">
                  <p className="font-semibold text-[var(--ink)]">
                    {b.supplierName ?? "ไม่ระบุผู้ขาย"} · {money(b.total)} บาท
                  </p>
                  <p className="text-xs text-[var(--muted)]">
                    {b.billDate} · {EVIDENCE_LABELS[b.evidenceKind]} · รูป {b.images.length}
                    {b.rejectReason ? ` · เหตุผล: ${b.rejectReason}` : ""}
                  </p>
                </div>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs ${b.status === "pending" ? "bg-amber-200 text-amber-900" : b.status === "posted" ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}`}
                >
                  {BILL_STATUS_LABELS[b.status]}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
