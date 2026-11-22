"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { PayoutMethod, ResaleLot, ResaleProduct, SettlementPreview } from "@/modules/consignment/types";
import type { Supplier } from "@/modules/inventory/types";
import { adjustLotAction, getSettlementPreviewAction, receiveLotsAction, settleAction } from "../operations-actions";
import { baht, inputClass, itemLabel } from "../ConsignmentChrome";

type Step = "count" | "settle" | "receive" | "done";

interface Row {
  key: string;
  productId: string;
  optionId: string | null;
  label: string;
  qty: string;
  unitCost: string;
}

function rowsFor(products: ResaleProduct[], supplierId: string, mode: "resale" | "consignment"): Row[] {
  const rows: Row[] = [];
  for (const p of products.filter((x) => x.supplierId === supplierId && x.sourcingMode === mode)) {
    const percent = p.sourcingMode === "consignment" && p.consignPricing === "percent";
    const group = p.groups.find((g) => g.id === p.resaleOptionGroupId);
    if (group) {
      for (const o of group.options) {
        const cost = percent ? 0 : o.resaleUnitCost ?? p.resaleUnitCost;
        rows.push({ key: `${p.id}:${o.id}`, productId: p.id, optionId: o.id, label: `${p.name} · ${o.name}`, qty: "", unitCost: cost === null ? "" : String(cost) });
      }
    } else {
      const cost = percent ? 0 : p.resaleUnitCost;
      rows.push({ key: `${p.id}:-`, productId: p.id, optionId: null, label: p.name, qty: "", unitCost: cost === null ? "" : String(cost) });
    }
  }
  return rows;
}

export function ReceiveWizard({ products, suppliers, lots }: { products: ResaleProduct[]; suppliers: Supplier[]; lots: ResaleLot[] }) {
  const router = useRouter();
  const owners = suppliers.filter((s) => products.some((p) => p.supplierId === s.id));
  const [supplierId, setSupplierId] = useState("");
  const [mode, setMode] = useState<"resale" | "consignment">("consignment");
  const [step, setStep] = useState<Step>("receive");
  const [counts, setCounts] = useState<Record<string, { counted: string; returnLeft: boolean }>>({});
  const [preview, setPreview] = useState<SettlementPreview | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [expiresOn, setExpiresOn] = useState("");
  const [note, setNote] = useState("");
  const [payMethod, setPayMethod] = useState<PayoutMethod>("cash");
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  const supplier = owners.find((s) => s.id === supplierId);
  const modes = useMemo(() => {
    const set = new Set(products.filter((p) => p.supplierId === supplierId).map((p) => p.sourcingMode));
    return (["consignment", "resale"] as const).filter((m) => set.has(m));
  }, [products, supplierId]);
  const ownerLots = lots.filter((l) => l.supplierId === supplierId && l.mode === "consignment");
  const isPercent = (productId: string) => products.find((p) => p.id === productId)?.consignPricing === "percent";

  function start(nextSupplier: string, nextMode?: "resale" | "consignment") {
    setMessage(null);
    setSupplierId(nextSupplier);
    setPreview(null);
    const s = owners.find((x) => x.id === nextSupplier);
    const available = new Set(products.filter((p) => p.supplierId === nextSupplier).map((p) => p.sourcingMode));
    const m = nextMode ?? (available.has("consignment") ? "consignment" : "resale");
    setMode(m);
    setRows(rowsFor(products, nextSupplier, m));
    const restock = m === "consignment" && s?.settleCycle === "restock";
    const hasLots = lots.some((l) => l.supplierId === nextSupplier && l.mode === "consignment");
    setCounts(Object.fromEntries(lots.filter((l) => l.supplierId === nextSupplier && l.mode === "consignment").map((l) => [l.id, { counted: String(l.qtyRemaining), returnLeft: false }])));
    if (restock && hasLots) setStep("count");
    else if (restock) {
      setStep("settle");
      loadPreview(nextSupplier);
    } else setStep("receive");
  }

  function loadPreview(id: string) {
    startTransition(async () => {
      const res = await getSettlementPreviewAction(id);
      if (res.error || !res.data) {
        setMessage({ tone: "error", text: res.error ?? "อ่านยอดไม่สำเร็จ" });
        return;
      }
      setPreview(res.data);
    });
  }

  function confirmCount() {
    for (const l of ownerLots) {
      const c = counts[l.id];
      const counted = Number(c?.counted);
      if (!c || c.counted.trim() === "" || !Number.isInteger(counted) || counted < 0) {
        setMessage({ tone: "error", text: `ใส่จำนวนที่นับได้ของ ${itemLabel(products, l.productId, l.optionId)}` });
        return;
      }
    }
    setMessage(null);
    startTransition(async () => {
      for (const l of ownerLots) {
        const c = counts[l.id];
        const counted = Number(c.counted);
        const diff = counted - l.qtyRemaining;
        if (diff !== 0) {
          const r = await adjustLotAction({ lotId: l.id, kind: "count_adjust", qty: diff, note: "นับตอนเติมของ" });
          if (r.error) {
            setMessage({ tone: "error", text: `${itemLabel(products, l.productId, l.optionId)}: ${r.error}` });
            router.refresh();
            return;
          }
        }
        if (c.returnLeft && counted > 0) {
          const r = await adjustLotAction({ lotId: l.id, kind: "return_owner", qty: counted, note: "คืนตอนเติมของ" });
          if (r.error) {
            setMessage({ tone: "error", text: `${itemLabel(products, l.productId, l.optionId)}: ${r.error}` });
            router.refresh();
            return;
          }
        }
      }
      setStep("settle");
      const res = await getSettlementPreviewAction(supplierId);
      if (res.error || !res.data) setMessage({ tone: "error", text: res.error ?? "อ่านยอดไม่สำเร็จ" });
      else setPreview(res.data);
      router.refresh();
    });
  }

  function doSettle(method: PayoutMethod | "skip") {
    if (!preview) return;
    if (method === "skip") {
      setStep("receive");
      return;
    }
    startTransition(async () => {
      const r = await settleAction({ supplierId, method, trigger: "restock", expectedTotal: preview.total, note: null });
      if (r.error) {
        setMessage({ tone: "error", text: r.error });
        const res = await getSettlementPreviewAction(supplierId);
        if (res.data) setPreview(res.data);
        return;
      }
      setMessage({ tone: "ok", text: (r.paid ?? 0) > 0 ? `จ่ายเจ้าของ ${baht(r.paid ?? 0)} บาทแล้ว` : "ปิดยอดแล้ว" });
      setStep("receive");
      router.refresh();
    });
  }

  function receive() {
    const lines = rows
      .filter((r) => r.qty.trim() !== "")
      .map((r) => ({ productId: r.productId, optionId: r.optionId, qty: Number(r.qty), unitCost: r.unitCost.trim() === "" ? NaN : Number(r.unitCost) }));
    if (lines.length === 0) {
      setMessage({ tone: "error", text: "ใส่จำนวนอย่างน้อย 1 รายการ" });
      return;
    }
    if (lines.some((l) => !Number.isFinite(l.unitCost))) {
      setMessage({ tone: "error", text: "ใส่ราคาต่อชิ้นให้ครบทุกบรรทัดที่รับ" });
      return;
    }
    startTransition(async () => {
      const r = await receiveLotsAction({
        supplierId,
        mode,
        lines,
        expiresOn: expiresOn || null,
        note: note || null,
        paymentMethod: mode === "resale" ? payMethod : null,
      });
      if (r.error) {
        setMessage({ tone: "error", text: r.error });
        return;
      }
      setMessage({
        tone: "ok",
        text: `รับของ ${lines.reduce((s, l) => s + l.qty, 0)} ชิ้นแล้ว${mode === "resale" ? ` · ลงรายจ่าย ${baht(r.total ?? 0)} บาท (${payMethod === "cash" ? "เงินสด" : "โอน"})` : " · ฝากขาย ยังไม่ลงรายจ่าย"}`,
      });
      setStep("done");
      router.refresh();
    });
  }

  const receiveTotal = rows.reduce((s, r) => s + (Number(r.qty) || 0) * (Number(r.unitCost) || 0), 0);

  if (owners.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-[var(--border)] p-6 text-center text-sm text-[var(--muted)]">
        ยังไม่มีเมนูซื้อมาขาย/ฝากขาย — ตั้งที่แท็บ <Link href="/consignment/products" className="underline">ตั้งเมนู</Link> ก่อน
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="text-[var(--muted)]">เจ้าของสินค้า</span>
          <select className={inputClass} value={supplierId} onChange={(e) => start(e.target.value)}>
            <option value="">เลือก</option>
            {owners.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </label>
        {modes.length > 1 && (
          <div className="text-sm">
            <span className="text-[var(--muted)]">แบบ</span>
            <div className="mt-1 flex gap-2">
              {modes.map((m) => (
                <button key={m} type="button" onClick={() => start(supplierId, m)} className={`min-h-11 flex-1 rounded-lg border text-sm font-semibold ${mode === m ? "border-[var(--tenant-primary)] bg-[var(--tenant-primary)] text-white" : "border-[var(--border)]"}`}>
                  {m === "resale" ? "ซื้อขาด" : "ฝากขาย"}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {message && (
        <p role="status" className={`rounded-lg px-3 py-2 text-sm ${message.tone === "ok" ? "bg-green-50 text-green-800" : "bg-red-50 text-red-700"}`}>
          {message.text}
        </p>
      )}

      {supplier && step === "count" && (
        <div className="space-y-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <h2 className="font-semibold text-[var(--ink)]">ขั้นที่ 1/3 · นับของเหลือ</h2>
          <p className="text-sm text-[var(--muted)]">ใส่จำนวนที่นับได้จริง ถ้าขาด = ของหาย (ฝากขาย เจ้าของรับผิดชอบ) · เลือกคืนเจ้าของได้ ไม่งั้นเก็บขายต่อ (ขายก่อนล็อตใหม่)</p>
          <div className="divide-y divide-[var(--border)] rounded-lg border border-[var(--border)]">
            {ownerLots.map((l) => {
              const c = counts[l.id] ?? { counted: String(l.qtyRemaining), returnLeft: false };
              return (
                <div key={l.id} className="grid grid-cols-[minmax(0,1fr)_90px_auto] items-center gap-2 p-2 text-sm">
                  <span>
                    {itemLabel(products, l.productId, l.optionId)}
                    <span className="block text-xs text-[var(--muted)]">ในระบบ {l.qtyRemaining} · รับ {new Date(l.receivedAt).toLocaleDateString("th-TH")}{l.expiresOn ? ` · หมดอายุ ${l.expiresOn}` : ""}</span>
                  </span>
                  <input aria-label="นับได้" className={`${inputClass} min-h-10`} inputMode="numeric" value={c.counted} onChange={(e) => setCounts({ ...counts, [l.id]: { ...c, counted: e.target.value } })} />
                  <label className="flex items-center gap-1 text-xs">
                    <input type="checkbox" checked={c.returnLeft} onChange={(e) => setCounts({ ...counts, [l.id]: { ...c, returnLeft: e.target.checked } })} />
                    คืนเจ้าของ
                  </label>
                </div>
              );
            })}
          </div>
          <button type="button" className="btn-primary min-h-11" disabled={isPending} onClick={confirmCount}>ยืนยันนับ → เคลียร์เงิน</button>
        </div>
      )}

      {supplier && step === "settle" && (
        <div className="space-y-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <h2 className="font-semibold text-[var(--ink)]">ขั้นที่ 2/3 · เคลียร์เงิน {supplier.name}</h2>
          {!preview ? (
            <p className="text-sm text-[var(--muted)]">กำลังคำนวณยอด…</p>
          ) : (
            <>
              <div className="space-y-1 text-sm">
                {preview.lines.length === 0 && <p className="text-[var(--muted)]">ยังไม่มียอดขายที่ต้องจ่ายตั้งแต่เคลียร์ครั้งก่อน</p>}
                {preview.lines.map((l) => (
                  <div key={`${l.productId}:${l.optionId ?? "-"}`} className="flex justify-between gap-2">
                    <span>{itemLabel(products, l.productId, l.optionId)} × {l.qty}</span>
                    <span>{baht(l.due)}</span>
                  </div>
                ))}
                {preview.clawback > 0 && <div className="flex justify-between text-red-700"><span>หักยอดที่ถูกยกเลิก/คืนเงินหลังจ่าย</span><span>−{baht(preview.clawback)}</span></div>}
                {preview.carryIn > 0 && <div className="flex justify-between text-red-700"><span>ยกยอดติดลบจากรอบก่อน</span><span>−{baht(preview.carryIn)}</span></div>}
                <div className="flex justify-between border-t border-[var(--border)] pt-2 text-base font-bold"><span>จ่ายเจ้าของ</span><span>{baht(Math.max(preview.total, 0))}</span></div>
                {preview.total < 0 && <p className="text-xs text-red-700">ยอดติดลบ {baht(-preview.total)} บาท — ไม่ต้องจ่าย ยกไปหักรอบหน้า</p>}
                {preview.pendingRows > 0 && <p className="text-xs text-[var(--muted)]">มี {preview.pendingRows} รายการที่บิลยังไม่จ่าย/รอเลือกรส — จะนับในรอบถัดไป</p>}
                {preview.payoutAccount && <p className="text-xs text-[var(--muted)]">บัญชีรับเงิน: {preview.payoutAccount}</p>}
              </div>
              <div className="flex flex-wrap gap-2">
                {preview.ownerDue !== 0 || preview.clawback !== 0 ? (
                  <>
                    <button type="button" className="btn-primary min-h-11" disabled={isPending} onClick={() => doSettle(preview.payoutMethod)}>
                      {preview.total > 0 ? `จ่าย${preview.payoutMethod === "cash" ? "เงินสด (ตัดลิ้นชัก)" : "โอน"}แล้ว` : "ปิดยอด"}
                    </button>
                    {preview.total > 0 && (
                      <button type="button" className="btn-secondary min-h-11" disabled={isPending} onClick={() => doSettle(preview.payoutMethod === "cash" ? "transfer" : "cash")}>
                        จ่ายด้วย{preview.payoutMethod === "cash" ? "การโอน" : "เงินสด"}แทน
                      </button>
                    )}
                    <button type="button" className="btn-secondary min-h-11" disabled={isPending} onClick={() => doSettle("skip")}>ค้างไว้ก่อน</button>
                  </>
                ) : (
                  <button type="button" className="btn-primary min-h-11" onClick={() => doSettle("skip")}>ไปรับของ</button>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {supplier && step === "receive" && (
        <div className="space-y-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <h2 className="font-semibold text-[var(--ink)]">
            {mode === "consignment" && supplier.settleCycle === "restock" ? "ขั้นที่ 3/3 · " : ""}รับของ ({mode === "resale" ? "ซื้อขาด" : "ฝากขาย"})
          </h2>
          <div className="divide-y divide-[var(--border)] rounded-lg border border-[var(--border)]">
            <div className="grid grid-cols-[minmax(0,1fr)_80px_100px] gap-2 p-2 text-xs text-[var(--muted)]">
              <span>เมนู/รส</span><span>จำนวน</span><span>{mode === "resale" ? "ราคาซื้อ/ชิ้น" : "จ่ายเจ้าของ/ชิ้น"}</span>
            </div>
            {rows.map((r, i) => (
              <div key={r.key} className="grid grid-cols-[minmax(0,1fr)_80px_100px] items-center gap-2 p-2 text-sm">
                <span>{r.label}</span>
                <input aria-label={`จำนวน ${r.label}`} className={`${inputClass} min-h-10`} inputMode="numeric" value={r.qty} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} />
                {isPercent(r.productId) ? (
                  <span className="text-xs text-[var(--muted)]">หัก % ตอนขาย</span>
                ) : (
                  <input aria-label={`ราคา ${r.label}`} className={`${inputClass} min-h-10`} inputMode="decimal" value={r.unitCost} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, unitCost: e.target.value } : x)))} />
                )}
              </div>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="text-[var(--muted)]">วันหมดอายุ (ถ้ามี)</span>
              <input type="date" className={inputClass} value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} />
            </label>
            <label className="block text-sm">
              <span className="text-[var(--muted)]">หมายเหตุ</span>
              <input className={inputClass} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
            </label>
          </div>
          {mode === "resale" && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-[var(--muted)]">จ่ายค่าของ {baht(receiveTotal)} บาท ด้วย</span>
              {(["cash", "transfer"] as const).map((m) => (
                <button key={m} type="button" onClick={() => setPayMethod(m)} className={`min-h-10 rounded-full border px-3 ${payMethod === m ? "border-[var(--tenant-primary)] bg-[var(--tenant-primary)] text-white" : "border-[var(--border)]"}`}>
                  {m === "cash" ? "เงินสด (ตัดลิ้นชัก)" : "โอน"}
                </button>
              ))}
            </div>
          )}
          <button type="button" className="btn-primary min-h-11" disabled={isPending} onClick={receive}>ยืนยันรับของ</button>
        </div>
      )}

      {supplier && step === "done" && (
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-secondary min-h-11" onClick={() => start(supplierId, mode)}>รับของอีกครั้ง</button>
          <Link href="/consignment" className="btn-secondary inline-flex min-h-11 items-center">ไปหน้าภาพรวม</Link>
        </div>
      )}
    </div>
  );
}
