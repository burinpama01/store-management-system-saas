"use client";

import { useState, useTransition } from "react";
import type { BillingPlan } from "@/modules/billing/types";
import { PLAN_LABELS } from "@/modules/billing/types";
import { setTenantPlanAction } from "./actions";

const PLANS: BillingPlan[] = ["free", "starter", "standard", "premium", "enterprise"];

export function TenantPlanControl({
  organizationId,
  currentPlan,
}: {
  organizationId: string;
  currentPlan: BillingPlan;
}) {
  const [plan, setPlan] = useState<BillingPlan>(currentPlan);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, start] = useTransition();

  function save() {
    setError(null);
    setDone(false);
    const fd = new FormData();
    fd.set("organizationId", organizationId);
    fd.set("plan", plan);
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
        <button
          type="button"
          onClick={save}
          disabled={pending || plan === currentPlan}
          className="btn-primary text-xs disabled:opacity-40"
        >
          {pending ? "กำลังบันทึก..." : "บันทึกแพ็กเกจ"}
        </button>
      </div>
      {error && <p className="alert-danger mt-2">{error}</p>}
      {done && <p className="mt-2 text-xs text-emerald-700">เปลี่ยนแพ็กเกจแล้ว</p>}
    </div>
  );
}
