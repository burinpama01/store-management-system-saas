"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toPurchaseUnits } from "@/modules/inventory/math";
import type { InventoryItem, Supplier } from "@/modules/inventory/types";
import { canApproveBill, needsApproval } from "@/modules/purchasing/access-policy";
import {
  BILL_STATUS_LABELS,
  EVIDENCE_KINDS,
  EVIDENCE_LABELS,
  type EvidenceKind,
  type ExpenseCategory,
  type PayMethod,
  type PurchaseBill,
} from "@/modules/purchasing/types";
import { billTotals, onHandAfterReceive } from "@/modules/purchasing/validate";
import { useConfirm } from "@/shared/components/ui/useConfirm";
import { money } from "../CostingChrome";
import {
  approvePurchaseBillAction,
  payPurchaseBillAction,
  postPurchaseBillAction,
  recoverPurchaseBillAction,
  rejectPurchaseBillAction,
  voidPurchaseBillAction,
} from "../purchase-actions";
import { BillPhotoPicker, type PickedPhoto } from "./BillPhotoPicker";
import { ScanBillButton, scanSummary } from "./ScanBillButton";
import type { ScannedBillDraft } from "@/modules/purchasing/bill-scan";

const inputClass = "min-h-11 w-full rounded-lg border border-[var(--border)] bg-white px-3 text-[16px] text-[var(--ink)]";

interface LineDraft {
  key: string;
  target: string; // "i:<ingredientId>" | "c:<categoryId>" | ""
  rawName: string;
  qty: string;
  unitPrice: string;
  lineTotal: string;
  issue?: boolean; // AI อ่านแล้วตัวเลขไม่ตรง/ไม่ครบ
}

function bangkokToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(new Date());
}

const emptyLine = (): LineDraft => ({ key: `l-${Math.random().toString(36).slice(2)}`, target: "", rawName: "", qty: "", unitPrice: "", lineTotal: "" });
const n = (v: string) => (v.trim() === "" ? NaN : Number(v));

export function PurchaseBillsManager({
  bills,
  items,
  suppliers,
  categories,
  enabled,
  canEdit,
  role,
  userId,
}: {
  bills: PurchaseBill[];
  items: InventoryItem[];
  suppliers: Supplier[];
  categories: ExpenseCategory[];
  enabled: boolean;
  canEdit: boolean;
  role: string;
  userId: string;
}) {
  const router = useRouter();
  const { confirm, confirmDialog } = useConfirm();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<"all" | "pending" | "unpaid" | "recover">("all");
  const [supplierId, setSupplierId] = useState("");
  const [supplierName, setSupplierName] = useState("");
  const [billNo, setBillNo] = useState("");
  const [billDate, setBillDate] = useState(bangkokToday());
  const [kind, setKind] = useState<EvidenceKind>("receipt");
  const [photos, setPhotos] = useState<PickedPhoto[]>([]);
  const [source, setSource] = useState<"manual" | "ai">("manual");
  const [scanNote, setScanNote] = useState<{ tone: "ok" | "warn" | "error"; text: string } | null>(null);
  const [discount, setDiscount] = useState("0");
  const [vat, setVat] = useState("0");
  const [payStatus, setPayStatus] = useState<"paid" | "unpaid">("paid");
  const [payMethod, setPayMethod] = useState<PayMethod>("cash");
  const [dueDate, setDueDate] = useState("");
  const [note, setNote] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([emptyLine()]);
  const [voiding, setVoiding] = useState<{ bill: PurchaseBill; reason: string } | null>(null);
  const [rejecting, setRejecting] = useState<{ bill: PurchaseBill; reason: string } | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  const itemById = useMemo(() => new Map(items.map((i) => [i.ingredientId, i])), [items]);
  const supplierById = useMemo(() => new Map(suppliers.map((s) => [s.id, s.name])), [suppliers]);
  const categoryById = useMemo(() => new Map(categories.map((c) => [c.id, c.name])), [categories]);
  const totals = billTotals(lines.map((l) => ({ lineTotal: Number(l.lineTotal) || 0 })), Number(discount) || 0, Number(vat) || 0);
  const outstanding = (b: PurchaseBill) => Math.max(0, Math.round((b.paidAmount - b.recoveredAmount) * 100) / 100);
  const pendingBills = bills.filter((b) => b.status === "pending");
  const recoverBills = bills.filter((b) => b.status === "rejected" && outstanding(b) > 0);
  const shown = bills.filter((b) =>
    filter === "unpaid"
      ? b.status === "posted" && b.paymentStatus === "unpaid"
      : filter === "pending"
        ? b.status === "pending"
        : filter === "recover"
          ? b.status === "rejected" && outstanding(b) > 0
          : true,
  );
  const unpaidTotal = bills.filter((b) => b.status === "posted" && b.paymentStatus === "unpaid").reduce((s, b) => s + b.total, 0);
  const recoverTotal = recoverBills.reduce((s, b) => s + outstanding(b), 0);
  const willNeedApproval = needsApproval(role, kind);

  function setLine(i: number, patch: Partial<LineDraft>) {
    setLines((ls) =>
      ls.map((l, j) => {
        if (j !== i) return l;
        const next = { ...l, ...patch, issue: false };
        // จำนวน × ราคา → ยอดบรรทัด (แก้ยอดเองได้ เช่นบิลที่มีแค่ยอดรวม)
        if (("qty" in patch || "unitPrice" in patch) && Number.isFinite(n(next.qty)) && Number.isFinite(n(next.unitPrice))) {
          next.lineTotal = String(Math.round(n(next.qty) * n(next.unitPrice) * 100) / 100);
        }
        if ("target" in patch && next.target.startsWith("i:") && !next.rawName) {
          next.rawName = itemById.get(next.target.slice(2))?.name ?? "";
        }
        return next;
      }),
    );
  }

  function reset() {
    setSupplierId("");
    setSupplierName("");
    setBillNo("");
    setBillDate(bangkokToday());
    setKind("receipt");
    setPhotos([]);
    setSource("manual");
    setScanNote(null);
    setDiscount("0");
    setVat("0");
    setPayStatus("paid");
    setPayMethod("cash");
    setDueDate("");
    setNote("");
    setLines([emptyLine()]);
  }

  function save() {
    if (kind === "handwritten" && photos.length === 0) {
      return setMessage({ tone: "error", text: "บิลเขียนมือต้องแนบรูปบิลอย่างน้อย 1 รูป" });
    }
    const filled = lines.filter((l) => l.target || l.rawName.trim() || l.lineTotal.trim());
    for (const [i, l] of filled.entries()) {
      if (!l.target) return setMessage({ tone: "error", text: `บรรทัด ${i + 1}: เลือกวัตถุดิบ หรือหมวดค่าใช้จ่าย` });
      if (!(n(l.qty) > 0)) return setMessage({ tone: "error", text: `บรรทัด ${i + 1}: ใส่จำนวน` });
      if (!Number.isFinite(n(l.lineTotal))) return setMessage({ tone: "error", text: `บรรทัด ${i + 1}: ใส่ยอดรวม` });
    }
    setMessage(null);
    startTransition(async () => {
      const result = await postPurchaseBillAction({
        supplierId: supplierId || null,
        supplierName: supplierId ? null : supplierName || null,
        billNo: billNo || null,
        billDate,
        evidenceKind: kind,
        imageIds: photos.map((p) => p.id),
        discount: Number(discount) || 0,
        vatAmount: Number(vat) || 0,
        total: totals.total,
        paymentStatus: payStatus,
        paymentMethod: payStatus === "paid" ? payMethod : null,
        dueDate: payStatus === "unpaid" ? dueDate || null : null,
        note: note || null,
        source,
        lines: filled.map((l) => ({
          ingredientId: l.target.startsWith("i:") ? l.target.slice(2) : null,
          expenseCategoryId: l.target.startsWith("c:") ? l.target.slice(2) : null,
          rawName: l.rawName,
          qty: n(l.qty),
          unitLabel: l.target.startsWith("i:") ? itemById.get(l.target.slice(2))?.purchaseUnit ?? null : null,
          unitPrice: Number.isFinite(n(l.unitPrice)) ? n(l.unitPrice) : Math.round((n(l.lineTotal) / n(l.qty)) * 10000) / 10000,
          lineTotal: n(l.lineTotal),
        })),
      });
      if (result.error) {
        setMessage({ tone: "error", text: result.error });
        return;
      }
      setMessage({
        tone: "ok",
        text:
          result.status === "pending"
            ? `ส่งบิล ${money(totals.total)} บาท รออนุมัติแล้ว — สต็อกจะเข้าเมื่อผู้จัดการคนอื่นหรือเจ้าของอนุมัติ`
            : `บันทึกบิลซื้อ ${money(totals.total)} บาทแล้ว${(result.negativeResets ?? 0) > 0 ? ` · ล้างยอดติดลบ ${result.negativeResets} วัตถุดิบ (บันทึกเป็นใช้เกินก่อนรับของ)` : ""}`,
      });
      reset();
      setOpen(false);
      router.refresh();
    });
  }

  function applyScan({ photo, draft, error }: { photo: PickedPhoto; draft: ScannedBillDraft | null; error: string | null }) {
    if (photo.id) setPhotos((ps) => (ps.some((p) => p.id === photo.id) ? ps : [...ps, photo]));
    if (error || !draft) {
      setScanNote({ tone: "error", text: `${error ?? "AI อ่านบิลไม่สำเร็จ"}${photo.id ? " · รูปแนบไว้แล้ว กรอกรายการเองต่อได้" : ""}` });
      return;
    }
    if (!draft.isBill) {
      setScanNote({ tone: "error", text: `AI: รูปนี้ไม่ใช่บิลซื้อ (${draft.notBillReason ?? "ไม่พบยอดเงิน"}) — รูปแนบไว้แล้ว กรอกเองได้` });
      return;
    }
    setSource("ai");
    setSupplierId(draft.supplierId ?? "");
    setSupplierName(draft.supplierId ? "" : (draft.supplierName ?? ""));
    setBillNo(draft.billNo ?? "");
    if (draft.billDate) setBillDate(draft.billDate);
    setKind(draft.evidenceKind);
    setDiscount(String(draft.discount));
    setVat(String(draft.vatAmount));
    if (draft.paymentHint === "credit") {
      setPayStatus("unpaid");
      setDueDate(draft.dueDate ?? "");
    }
    setLines(
      draft.lines.map((l) => ({
        ...emptyLine(),
        target: l.match.kind === "ingredient" ? `i:${l.match.id}` : l.match.kind === "category" ? `c:${l.match.id}` : "",
        rawName: l.rawName,
        qty: l.qty === null ? "" : String(l.qty),
        unitPrice: l.unitPrice === null ? "" : String(l.unitPrice),
        lineTotal: l.lineTotal === null ? "" : String(l.lineTotal),
        issue: l.issue,
      })),
    );
    setScanNote(scanSummary(draft));
  }

  async function pay(bill: PurchaseBill, method: PayMethod) {
    const ok = await confirm({
      title: "จ่ายบิลซื้อ?",
      message: `${bill.supplierName ?? supplierById.get(bill.supplierId ?? "") ?? "ไม่ระบุผู้ขาย"} ${money(bill.total)} บาท ด้วย${method === "cash" ? "เงินสด (ตัดลิ้นชัก)" : "การโอน"}`,
      confirmLabel: "จ่ายแล้ว",
    });
    if (!ok) return;
    startTransition(async () => {
      const result = await payPurchaseBillAction(bill.id, method, bill.total);
      setMessage(result.error ? { tone: "error", text: result.error } : { tone: "ok", text: "บันทึกการจ่ายแล้ว" });
      router.refresh();
    });
  }

  async function approve(bill: PurchaseBill) {
    const ok = await confirm({
      title: "อนุมัติบิลซื้อ?",
      message: `${bill.supplierName ?? supplierById.get(bill.supplierId ?? "") ?? "ไม่ระบุผู้ขาย"} ${money(bill.total)} บาท — รับเข้าคลังและอัปเดตราคาซื้อ`,
      confirmLabel: "อนุมัติ",
    });
    if (!ok) return;
    startTransition(async () => {
      const result = await approvePurchaseBillAction(bill.id);
      setMessage(
        result.error
          ? { tone: "error", text: result.error }
          : { tone: "ok", text: `อนุมัติแล้ว — รับเข้าคลัง${(result.negativeResets ?? 0) > 0 ? ` · ล้างยอดติดลบ ${result.negativeResets} วัตถุดิบ` : ""}` },
      );
      router.refresh();
    });
  }

  function doReject() {
    if (!rejecting) return;
    startTransition(async () => {
      const result = await rejectPurchaseBillAction(rejecting.bill.id, rejecting.reason);
      if (result.error) {
        setMessage({ tone: "error", text: result.error });
        return;
      }
      setMessage({
        tone: "ok",
        text: (result.outstanding ?? 0) > 0 ? `ไม่อนุมัติแล้ว — ต้องตามเงินคืน ${money(result.outstanding ?? 0)} บาท (ดูแท็บ ต้องตามเงินคืน)` : "ไม่อนุมัติแล้ว",
      });
      setRejecting(null);
      router.refresh();
    });
  }

  async function recover(bill: PurchaseBill, method: PayMethod) {
    const ok = await confirm({
      title: "รับเงินคืนแล้ว?",
      message: `${money(outstanding(bill))} บาท ด้วย${method === "cash" ? "เงินสด (เข้าลิ้นชัก)" : "การโอน"}`,
      confirmLabel: "รับคืนแล้ว",
    });
    if (!ok) return;
    startTransition(async () => {
      const result = await recoverPurchaseBillAction(bill.id, method);
      setMessage(result.error ? { tone: "error", text: result.error } : { tone: "ok", text: "บันทึกรับเงินคืนแล้ว" });
      router.refresh();
    });
  }

  function doVoid() {
    if (!voiding) return;
    startTransition(async () => {
      const result = await voidPurchaseBillAction(voiding.bill.id, voiding.reason);
      if (result.error) {
        setMessage({ tone: "error", text: result.error });
        return;
      }
      setMessage({ tone: "ok", text: "ยกเลิกบิลแล้ว — คืนจำนวนออกจากคลังและบันทึกรายรับคืนเงิน (ถ้าเคยจ่าย)" });
      setVoiding(null);
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      {!enabled && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">สาขานี้ยังไม่ได้เปิดคลังวัตถุดิบ — เปิดที่แท็บ คลังวัตถุดิบ ก่อนบันทึกบิลซื้อ</p>
      )}
      {message && (
        <p role="status" className={`rounded-lg px-3 py-2 text-sm ${message.tone === "ok" ? "bg-green-50 text-green-800" : "bg-red-50 text-red-700"}`}>
          {message.text}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {canEdit && !open && (
          <button type="button" className="btn-primary min-h-11" onClick={() => { setMessage(null); setOpen(true); }}>
            + บันทึกบิลซื้อ
          </button>
        )}
        <div className="flex flex-wrap gap-1">
          {(["all", "pending", "unpaid", "recover"] as const).map((f) => (
            <button key={f} type="button" onClick={() => setFilter(f)} className={`min-h-10 rounded-full border px-3 text-sm ${filter === f ? "border-[var(--tenant-primary)] bg-[var(--tenant-primary)] text-white" : "border-[var(--border)]"}`}>
              {f === "all"
                ? "ทั้งหมด"
                : f === "pending"
                  ? `รออนุมัติ (${pendingBills.length})`
                  : f === "unpaid"
                    ? `ค้างจ่าย (${money(unpaidTotal)})`
                    : `ต้องตามเงินคืน (${money(recoverTotal)})`}
            </button>
          ))}
        </div>
        <Link href="/costing/purchases/evidence" className="btn-secondary min-h-10 text-sm">ส่งออกหลักฐาน</Link>
      </div>

      {open && (
        <div className="space-y-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-base font-semibold text-[var(--ink)]">บิลซื้อใหม่</h2>
            <ScanBillButton onScanned={applyScan} />
          </div>
          {scanNote && (
            <p className={`rounded-lg px-3 py-2 text-sm ${scanNote.tone === "ok" ? "bg-green-50 text-green-800" : scanNote.tone === "warn" ? "border border-amber-200 bg-amber-50 text-amber-900" : "bg-red-50 text-red-700"}`}>
              {scanNote.text}
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block text-sm">
              <span className="text-[var(--muted)]">ผู้ขาย</span>
              <select className={inputClass} value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                <option value="">ไม่อยู่ในทะเบียน (พิมพ์ชื่อ)</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </label>
            {!supplierId && (
              <label className="block text-sm">
                <span className="text-[var(--muted)]">ชื่อร้าน (ถ้ามี)</span>
                <input className={inputClass} maxLength={120} value={supplierName} onChange={(e) => setSupplierName(e.target.value)} />
              </label>
            )}
            <label className="block text-sm">
              <span className="text-[var(--muted)]">เลขที่บิล</span>
              <input className={inputClass} maxLength={60} value={billNo} onChange={(e) => setBillNo(e.target.value)} />
            </label>
            <label className="block text-sm">
              <span className="text-[var(--muted)]">วันที่ในบิล</span>
              <input type="date" className={inputClass} value={billDate} onChange={(e) => setBillDate(e.target.value)} />
            </label>
          </div>

          <div className="space-y-2">
            {lines.map((l, i) => {
              const ingId = l.target.startsWith("i:") ? l.target.slice(2) : null;
              const item = ingId ? itemById.get(ingId) : undefined;
              const usageIn = item && n(l.qty) > 0 ? n(l.qty) * item.usagePerPurchase : 0;
              const preview = item ? onHandAfterReceive(item.onHand, usageIn) : null;
              return (
                <div key={l.key} className={`space-y-1 rounded-lg border p-2 ${l.issue ? "border-amber-400 bg-amber-50" : !l.target && source === "ai" ? "border-red-300" : "border-[var(--border)]"}`}>
                  <div className="grid gap-2 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1.2fr)_80px_100px_110px_auto]">
                    <select aria-label="วัตถุดิบหรือหมวด" className={inputClass} value={l.target} onChange={(e) => setLine(i, { target: e.target.value })}>
                      <option value="">เลือกวัตถุดิบ / หมวดค่าใช้จ่าย</option>
                      <optgroup label="วัตถุดิบ (เข้าคลัง)">
                        {items.map((it) => (
                          <option key={it.ingredientId} value={`i:${it.ingredientId}`}>{it.name} ({it.purchaseUnit})</option>
                        ))}
                      </optgroup>
                      <optgroup label="ค่าใช้จ่ายอื่น (ไม่เข้าคลัง)">
                        {categories.map((c) => (
                          <option key={c.id} value={`c:${c.id}`}>{c.name}</option>
                        ))}
                      </optgroup>
                    </select>
                    <input aria-label="ชื่อในบิล" className={inputClass} placeholder="ชื่อในบิล" maxLength={200} value={l.rawName} onChange={(e) => setLine(i, { rawName: e.target.value })} />
                    <input aria-label="จำนวน" className={inputClass} inputMode="decimal" placeholder={item?.purchaseUnit ?? "จำนวน"} value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} />
                    <input aria-label="ราคาต่อหน่วย" className={inputClass} inputMode="decimal" placeholder="ราคา/หน่วย" value={l.unitPrice} onChange={(e) => setLine(i, { unitPrice: e.target.value })} />
                    <input aria-label="ยอดรวมบรรทัด" className={inputClass} inputMode="decimal" placeholder="รวม" value={l.lineTotal} onChange={(e) => setLine(i, { lineTotal: e.target.value })} />
                    <button type="button" className="btn-secondary min-h-11 text-sm" disabled={lines.length === 1} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>ลบ</button>
                  </div>
                  {item && preview && (
                    <p className="text-xs text-[var(--muted)]">
                      คงเหลือ {item.onHand === null ? "ยังไม่ตั้งยอด" : `${toPurchaseUnits(item.onHand, item.usagePerPurchase)} ${item.purchaseUnit}`}
                      {usageIn > 0 && ` → หลังรับ ${toPurchaseUnits(preview.after, item.usagePerPurchase)} ${item.purchaseUnit}`}
                      {preview.resetQty > 0 && usageIn > 0 && (
                        <span className="font-semibold text-red-700"> · ติดลบ {toPurchaseUnits(preview.resetQty, item.usagePerPurchase)} {item.purchaseUnit} จะบันทึกเป็นใช้เกินก่อนรับของ (ไม่ถมยอด)</span>
                      )}
                    </p>
                  )}
                </div>
              );
            })}
            <button type="button" className="btn-secondary min-h-10 text-sm" onClick={() => setLines((ls) => [...ls, emptyLine()])}>+ เพิ่มบรรทัด</button>
          </div>

          <div className="grid gap-3 sm:grid-cols-4">
            <label className="block text-sm">
              <span className="text-[var(--muted)]">ส่วนลดท้ายบิล</span>
              <input className={inputClass} inputMode="decimal" value={discount} onChange={(e) => setDiscount(e.target.value)} />
            </label>
            <label className="block text-sm">
              <span className="text-[var(--muted)]">VAT</span>
              <input className={inputClass} inputMode="decimal" value={vat} onChange={(e) => setVat(e.target.value)} />
            </label>
            <label className="block text-sm">
              <span className="text-[var(--muted)]">ชนิดหลักฐาน</span>
              <select className={inputClass} value={kind} onChange={(e) => setKind(e.target.value as EvidenceKind)}>
                {EVIDENCE_KINDS.map((k) => (
                  <option key={k} value={k}>{EVIDENCE_LABELS[k]}</option>
                ))}
              </select>
            </label>
            <div className="rounded-lg bg-[var(--surface-muted)] p-2 text-right text-sm">
              <p className="text-[var(--muted)]">รวม {money(totals.subtotal)}</p>
              <p className="text-lg font-bold text-[var(--ink)]">สุทธิ {money(totals.total)}</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-[var(--muted)]">การจ่าย:</span>
            {([["paid-cash", "จ่ายเงินสด (ตัดลิ้นชัก)"], ["paid-transfer", "โอนแล้ว"], ["unpaid", "ค้างจ่าย"]] as const).map(([k, label]) => {
              const active = k === "unpaid" ? payStatus === "unpaid" : payStatus === "paid" && payMethod === k.slice(5);
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => {
                    if (k === "unpaid") setPayStatus("unpaid");
                    else {
                      setPayStatus("paid");
                      setPayMethod(k.slice(5) as PayMethod);
                    }
                  }}
                  className={`min-h-10 rounded-full border px-3 ${active ? "border-[var(--tenant-primary)] bg-[var(--tenant-primary)] text-white" : "border-[var(--border)]"}`}
                >
                  {label}
                </button>
              );
            })}
            {payStatus === "unpaid" && (
              <label className="flex items-center gap-2">
                ครบกำหนด
                <input type="date" className={`${inputClass} w-auto`} value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
              </label>
            )}
          </div>
          <label className="block text-sm">
            <span className="text-[var(--muted)]">หมายเหตุ</span>
            <input className={inputClass} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <BillPhotoPicker photos={photos} onChange={setPhotos} required={kind === "handwritten"} />
          {willNeedApproval && (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              บิลนี้ต้องรออนุมัติจากผู้จัดการคนอื่นหรือเจ้าของ — สต็อก/ราคาซื้อจะเข้าเมื่ออนุมัติ · ถ้าจ่ายเงินสด ตัดลิ้นชักทันที
            </p>
          )}
          <div className="flex gap-2">
            <button type="button" className="btn-primary min-h-11" disabled={isPending} onClick={save}>{willNeedApproval ? "ส่งให้อนุมัติ" : "บันทึกและรับเข้าคลัง"}</button>
            <button type="button" className="btn-secondary min-h-11" disabled={isPending} onClick={() => setOpen(false)}>ยกเลิก</button>
          </div>
        </div>
      )}

      {voiding && (
        <div className="space-y-3 rounded-xl border border-red-200 bg-red-50 p-4">
          <p className="font-semibold text-red-900">ยกเลิกบิล {voiding.bill.billNo ?? ""} {money(voiding.bill.total)} บาท</p>
          <p className="text-sm text-red-800">คืนจำนวนที่ซื้อออกจากคลัง (ยอดอาจติดลบ) · ถ้าเคยจ่าย บันทึกรายรับคืนเงิน · ส่วนที่เคยล้างติดลบไม่ย้อน</p>
          <input className={inputClass} placeholder="เหตุผล *" maxLength={300} value={voiding.reason} onChange={(e) => setVoiding({ ...voiding, reason: e.target.value })} />
          <div className="flex gap-2">
            <button type="button" className="btn-primary min-h-11" disabled={isPending || !voiding.reason.trim()} onClick={doVoid}>ยืนยันยกเลิกบิล</button>
            <button type="button" className="btn-secondary min-h-11" disabled={isPending} onClick={() => setVoiding(null)}>ไม่ยกเลิก</button>
          </div>
        </div>
      )}

      {rejecting && (
        <div className="space-y-3 rounded-xl border border-red-200 bg-red-50 p-4">
          <p className="font-semibold text-red-900">ไม่อนุมัติบิล {money(rejecting.bill.total)} บาท</p>
          <p className="text-sm text-red-800">สต็อกไม่เปลี่ยน · ถ้าจ่ายไปแล้ว รายจ่ายย้ายไปหมวด &quot;รายจ่ายไม่อนุมัติ&quot; และขึ้นยอดต้องตามเงินคืน</p>
          <input className={inputClass} placeholder="เหตุผล *" maxLength={300} value={rejecting.reason} onChange={(e) => setRejecting({ ...rejecting, reason: e.target.value })} />
          <div className="flex gap-2">
            <button type="button" className="btn-primary min-h-11" disabled={isPending || !rejecting.reason.trim()} onClick={doReject}>ยืนยันไม่อนุมัติ</button>
            <button type="button" className="btn-secondary min-h-11" disabled={isPending} onClick={() => setRejecting(null)}>กลับ</button>
          </div>
        </div>
      )}

      {shown.length === 0 ? (
        <p className="rounded-xl border border-dashed border-[var(--border)] p-6 text-center text-sm text-[var(--muted)]">ยังไม่มีบิลซื้อ</p>
      ) : (
        <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
          {shown.map((b) => (
            <li key={b.id} className={`space-y-1 p-3 ${b.status === "voided" || b.status === "rejected" ? "opacity-70" : ""} ${b.status === "pending" ? "bg-amber-50" : ""}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold text-[var(--ink)]">
                    {b.supplierName ?? supplierById.get(b.supplierId ?? "") ?? "ไม่ระบุผู้ขาย"}
                    {b.billNo ? ` · #${b.billNo}` : ""}
                    {b.status !== "posted" && (
                      <span className={`ml-2 rounded-full px-2 py-0.5 text-xs ${b.status === "pending" ? "bg-amber-200 text-amber-900" : "bg-[var(--surface-muted)] text-[var(--muted)]"}`}>
                        {BILL_STATUS_LABELS[b.status]}
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-[var(--muted)]">
                    {b.billDate} · {b.lines.length} บรรทัด · {EVIDENCE_LABELS[b.evidenceKind]}
                    {b.postedByName && b.status !== "posted" ? ` · ส่งโดย ${b.postedByName}` : ""}
                    {b.paymentStatus === "paid" ? ` · จ่ายแล้ว (${b.paymentMethod === "cash" ? "เงินสด" : "โอน"})` : b.status === "posted" || b.status === "pending" ? ` · ค้างจ่าย${b.dueDate ? ` ครบ ${b.dueDate}` : ""}` : ""}
                    {b.status === "rejected" && outstanding(b) > 0 ? ` · ต้องตามเงินคืน ${money(outstanding(b))}` : ""}
                    {b.rejectReason ? ` · ${b.rejectReason}` : ""}
                    {b.voidReason ? ` · ${b.voidReason}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-base font-bold">{money(b.total)}</span>
                  {canEdit && b.status === "posted" && b.paymentStatus === "unpaid" && (
                    <>
                      <button type="button" className="btn-primary min-h-9 text-xs" disabled={isPending} onClick={() => pay(b, "cash")}>จ่ายสด</button>
                      <button type="button" className="btn-secondary min-h-9 text-xs" disabled={isPending} onClick={() => pay(b, "transfer")}>โอน</button>
                    </>
                  )}
                  {canEdit && b.status === "posted" && (
                    <button type="button" className="btn-secondary min-h-9 text-xs" disabled={isPending} onClick={() => setVoiding({ bill: b, reason: "" })}>ยกเลิก</button>
                  )}
                  {canEdit && b.status === "pending" && (
                    <>
                      {canApproveBill({ role, userId, postedBy: b.postedBy }) ? (
                        <button type="button" className="btn-primary min-h-9 text-xs" disabled={isPending} onClick={() => approve(b)}>อนุมัติ</button>
                      ) : (
                        <span className="text-xs text-[var(--muted)]">บิลของคุณ — ให้คนอื่นอนุมัติ</span>
                      )}
                      <button type="button" className="btn-secondary min-h-9 text-xs" disabled={isPending} onClick={() => setRejecting({ bill: b, reason: "" })}>ไม่อนุมัติ</button>
                    </>
                  )}
                  {canEdit && b.status === "rejected" && outstanding(b) > 0 && (
                    <>
                      <button type="button" className="btn-primary min-h-9 text-xs" disabled={isPending} onClick={() => recover(b, "cash")}>รับคืนเงินสด</button>
                      <button type="button" className="btn-secondary min-h-9 text-xs" disabled={isPending} onClick={() => recover(b, "transfer")}>รับคืนโอน</button>
                    </>
                  )}
                </div>
              </div>
              <p className="text-xs text-[var(--muted)]">
                {b.lines
                  .slice(0, 5)
                  .map((l) => `${l.ingredientId ? itemById.get(l.ingredientId)?.name ?? l.rawName : `${categoryById.get(l.expenseCategoryId ?? "") ?? "อื่น ๆ"}: ${l.rawName}`} ${l.qty}${l.unitLabel ? ` ${l.unitLabel}` : ""} = ${money(l.lineTotal)}`)
                  .join(" · ")}
                {b.lines.length > 5 ? ` · และอีก ${b.lines.length - 5} บรรทัด` : ""}
              </p>
              {b.images.length > 0 && (
                <div className="flex flex-wrap gap-2 pt-1">
                  {b.images.map((img, k) =>
                    img.url ? (
                      <a key={img.id} href={img.url} target="_blank" rel="noreferrer" aria-label={`รูปบิล ${k + 1}`}>
                        {/* eslint-disable-next-line @next/next/no-img-element -- signed URL ชั่วคราว */}
                        <img src={img.url} alt={`รูปบิล ${k + 1}`} className="h-16 w-16 rounded-md border border-[var(--border)] object-cover" loading="lazy" />
                      </a>
                    ) : null,
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {confirmDialog}
    </div>
  );
}
