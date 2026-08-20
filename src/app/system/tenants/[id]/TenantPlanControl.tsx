"use client";

import { useState, useTransition } from "react";
import type { BillingPlan } from "@/modules/billing/types";
import { PLAN_LABELS } from "@/modules/billing/types";
import { setTenantPlanAction } from "./actions";
import { Button } from "@/shared/components/ui";

const PLANS: BillingPlan[] = ["free", "starter", "standard", "premium", "enterprise"];

/** input[type=date] ต้องการ "YYYY-MM-DD" ตามเวลาเครื่อง */
function toDateInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  // สัญญาไม่มีวันหมดอายุใช้ค่า sentinel ปี 2099 — ไม่ต้องเอามาโชว์ในช่องวันที่
  if (d.getUTCFullYear() >= 2099) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function TenantPlanControl({
  organizationId,
  currentPlan,
  currentEnterpriseLimited = false,
  currentPeriodEnd = null,
}: {
  organizationId: string;
  currentPlan: BillingPlan;
  /** true = สัญญา Enterprise แบบจำกัดเวลาอยู่แล้ว */
  currentEnterpriseLimited?: boolean;
  currentPeriodEnd?: string | null;
}) {
  const [plan, setPlan] = useState<BillingPlan>(currentPlan);
  const [limited, setLimited] = useState(currentEnterpriseLimited);
  const [endsAt, setEndsAt] = useState(toDateInput(currentPeriodEnd));
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, start] = useTransition();

  const isEnterprise = plan === "enterprise";
  const unchanged =
    plan === currentPlan &&
    (!isEnterprise ||
      (limited === currentEnterpriseLimited &&
        (!limited || endsAt === toDateInput(currentPeriodEnd))));

  function save() {
    setError(null);
    setDone(false);
    const fd = new FormData();
    fd.set("organizationId", organizationId);
    fd.set("plan", plan);
    if (isEnterprise && limited) {
      fd.set("enterpriseLimited", "1");
      // ให้หมดอายุตอนสิ้นวันที่เลือก ไม่ใช่เที่ยงคืนต้นวัน
      fd.set("enterpriseEndsAt", endsAt ? `${endsAt}T23:59:59` : "");
    }
    start(() => {
      void (async () => {
        const r = await setTenantPlanAction({ error: null }, fd);
        if (r.error) setError(r.error);
        else setDone(true);
      })();
    });
  }

  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-muted)] p-3">
      <p className="label-muted mb-2">เปลี่ยนแพ็กเกจ (override โดยผู้ดูแล ไม่ต้องชำระเงิน)</p>
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={plan}
          onChange={(e) => setPlan(e.target.value as BillingPlan)}
          className="form-input max-w-[200px]"
        >
          {PLANS.map((p) => (
            <option key={p} value={p}>{PLAN_LABELS[p]}</option>
          ))}
        </select>
        <Button
          variant="primary"
          onClick={save}
          loading={pending}
          loadingText="กำลังบันทึก..."
          disabled={unchanged}
          className="text-xs disabled:opacity-40"
        >
          บันทึกแพ็กเกจ
        </Button>
      </div>

      {isEnterprise && (
        <div className="mt-3 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-3">
          <p className="text-xs font-bold text-[var(--ink)]">รูปแบบสัญญา Enterprise</p>
          <div className="mt-2 flex flex-col gap-2 text-sm text-[var(--ink-2)]">
            <label className="flex items-start gap-2">
              <input
                type="radio"
                name="enterprise-mode"
                checked={!limited}
                onChange={() => setLimited(false)}
                className="mt-1"
              />
              <span>
                <span className="font-bold">ไม่มีวันหมดอายุ</span>
                <span className="block text-xs text-[var(--muted)]">
                  ใช้งานได้ตลอดจนกว่าจะเปลี่ยนแพ็กเกจ (สำหรับดีลที่ตกลงกันแล้ว)
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2">
              <input
                type="radio"
                name="enterprise-mode"
                checked={limited}
                onChange={() => setLimited(true)}
                className="mt-1"
              />
              <span>
                <span className="font-bold">จำกัดเวลา</span>
                <span className="block text-xs text-[var(--muted)]">
                  ครบกำหนดแล้วสิทธิ์ตกกลับเป็นแพ็กเกจฟรีจนกว่าจะต่อสัญญา
                </span>
              </span>
            </label>
          </div>
          {limited && (
            <div className="mt-3">
              <label htmlFor="enterprise-ends-at" className="field-label">
                ใช้งานได้ถึงวันที่
              </label>
              <input
                id="enterprise-ends-at"
                type="date"
                value={endsAt}
                onChange={(e) => setEndsAt(e.target.value)}
                className="form-input max-w-[220px]"
              />
            </div>
          )}
        </div>
      )}

      {error && <p className="alert-danger mt-2">{error}</p>}
      {done && <p className="mt-2 text-xs text-emerald-700">เปลี่ยนแพ็กเกจแล้ว</p>}
    </div>
  );
}
