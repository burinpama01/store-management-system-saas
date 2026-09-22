"use client";

import { useMemo, useState, useTransition } from "react";
import { describeOffer, type EnterpriseOfferTerm } from "@/modules/billing/enterprise-offer";
import { saveEnterpriseOfferAction } from "./actions";

/** input[type=date] ต้องการ "YYYY-MM-DD" ตามเวลาเครื่อง */
function toDateInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function EnterpriseOfferControl({
  organizationId,
  currentPeriodEnd,
  initial,
}: {
  organizationId: string;
  /** วันหมดอายุปัจจุบันของร้าน — ใช้คำนวณตัวอย่างผลลัพธ์แบบ "ต่ออีก N วัน" */
  currentPeriodEnd: string | null;
  initial: {
    amount: number | null;
    termKind: "days" | "until";
    termDays: number | null;
    endsAt: string | null;
    active: boolean;
    note: string | null;
  } | null;
}) {
  const [amount, setAmount] = useState(initial?.amount != null ? String(initial.amount) : "");
  const [termKind, setTermKind] = useState<"days" | "until">(initial?.termKind ?? "days");
  const [termDays, setTermDays] = useState(initial?.termDays != null ? String(initial.termDays) : "365");
  const [endsAt, setEndsAt] = useState(toDateInput(initial?.endsAt ?? null));
  const [note, setNote] = useState(initial?.note ?? "");
  const [active, setActive] = useState(initial?.active ?? true);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, start] = useTransition();

  // ตัวอย่างผลลัพธ์ที่ร้านจะเห็น — คำนวณด้วยฟังก์ชันตัวเดียวกับที่ใช้ตอนคิดเงินจริง
  const preview = useMemo(() => {
    const amountNum = Number(amount);
    if (!Number.isFinite(amountNum) || amountNum <= 0) return null;
    let term: EnterpriseOfferTerm | null = null;
    if (termKind === "days") {
      const days = Number(termDays);
      if (Number.isInteger(days) && days > 0) term = { kind: "days", days };
    } else if (endsAt) {
      const parsed = new Date(`${endsAt}T23:59:59`);
      if (!Number.isNaN(parsed.getTime())) term = { kind: "until", endsAt: parsed.toISOString() };
    }
    if (!term) return null;
    return describeOffer({ amount: amountNum, term }, currentPeriodEnd);
  }, [amount, termKind, termDays, endsAt, currentPeriodEnd]);

  function save() {
    setError(null);
    setDone(false);
    const fd = new FormData();
    fd.set("organizationId", organizationId);
    fd.set("amount", amount);
    fd.set("termKind", termKind);
    if (termKind === "days") fd.set("termDays", termDays);
    // ให้หมดอายุตอนสิ้นวันที่เลือก ไม่ใช่เที่ยงคืนต้นวัน
    else fd.set("endsAt", endsAt ? `${endsAt}T23:59:59` : "");
    fd.set("note", note);
    fd.set("active", active ? "1" : "0");
    start(() => {
      void (async () => {
        const r = await saveEnterpriseOfferAction({ error: null }, fd);
        if (r.error) setError(r.error);
        else setDone(true);
      })();
    });
  }

  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-muted)] p-3">
      <p className="label-muted mb-1">ข้อเสนอต่ออายุ Enterprise (ร้านเป็นคนจ่ายเอง)</p>
      <p className="mb-3 text-xs text-[var(--muted)]">
        ตั้งราคาและอายุเฉพาะบัญชีนี้ — ร้านจะเห็นการ์ดในหน้าแพ็กเกจและชำระผ่านช่องทางอัตโนมัติ
        ถ้าไม่ต่อก็เลือกแพ็กเกจอื่นได้ตามปกติ
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="offer-amount" className="field-label">ราคา (บาท)</label>
          <input
            id="offer-amount"
            type="number"
            min={1}
            step="0.01"
            value={amount}
            disabled={pending}
            onChange={(e) => { setAmount(e.target.value); setDone(false); }}
            className="form-input tabular-nums"
          />
        </div>
        <div>
          <label htmlFor="offer-term-kind" className="field-label">อายุที่ได้เมื่อชำระ</label>
          <select
            id="offer-term-kind"
            value={termKind}
            disabled={pending}
            onChange={(e) => { setTermKind(e.target.value as "days" | "until"); setDone(false); }}
            className="form-input"
          >
            <option value="days">ต่ออีกเป็นจำนวนวัน</option>
            <option value="until">ถึงวันที่กำหนด</option>
          </select>
        </div>
        {termKind === "days" ? (
          <div>
            <label htmlFor="offer-days" className="field-label">จำนวนวัน</label>
            <input
              id="offer-days"
              type="number"
              min={1}
              max={3650}
              value={termDays}
              disabled={pending}
              onChange={(e) => { setTermDays(e.target.value); setDone(false); }}
              className="form-input tabular-nums"
            />
          </div>
        ) : (
          <div>
            <label htmlFor="offer-ends" className="field-label">ใช้ได้ถึงวันที่</label>
            <input
              id="offer-ends"
              type="date"
              value={endsAt}
              disabled={pending}
              onChange={(e) => { setEndsAt(e.target.value); setDone(false); }}
              className="form-input"
            />
          </div>
        )}
        <div>
          <label htmlFor="offer-note" className="field-label">บันทึกภายใน (ร้านไม่เห็น)</label>
          <input
            id="offer-note"
            type="text"
            value={note}
            disabled={pending}
            onChange={(e) => { setNote(e.target.value); setDone(false); }}
            className="form-input"
            placeholder="เช่น ตกลงกับคุณ… ทางโทรศัพท์"
          />
        </div>
      </div>

      <label className="mt-3 flex items-center gap-2 text-sm font-bold text-[var(--ink-2)]">
        <input
          type="checkbox"
          checked={active}
          disabled={pending}
          onChange={(e) => { setActive(e.target.checked); setDone(false); }}
        />
        เปิดข้อเสนอให้ร้านเห็นและชำระได้
      </label>

      {preview && (
        <p className="mt-3 rounded-[var(--radius-md)] border border-[var(--tenant-primary)] bg-[var(--tenant-primary-soft)] px-3 py-2 text-sm text-[var(--tenant-primary-strong)]">
          ร้านจะเห็นว่า: {preview}
        </p>
      )}
      {error && (
        <p className="mt-3 rounded-[var(--radius-md)] border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700" role="alert">
          {error}
        </p>
      )}
      {done && (
        <p className="mt-3 text-xs font-semibold text-green-700" role="status">บันทึกข้อเสนอแล้ว</p>
      )}

      <button
        type="button"
        onClick={save}
        disabled={pending || !preview}
        className="btn-primary mt-3 min-h-11 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {pending ? "กำลังบันทึก..." : "บันทึกข้อเสนอ"}
      </button>
    </div>
  );
}
