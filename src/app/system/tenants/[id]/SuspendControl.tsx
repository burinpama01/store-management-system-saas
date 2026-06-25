"use client";

import { useState, useTransition } from "react";
import { ConfirmDialog, Button } from "@/shared/components/ui";
import { setTenantSuspensionAction } from "./actions";

export function SuspendControl({
  organizationId,
  suspended,
}: {
  organizationId: string;
  suspended: boolean;
}) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  function submit() {
    setConfirmOpen(false);
    setError(null);
    const fd = new FormData();
    fd.set("organizationId", organizationId);
    fd.set("suspend", suspended ? "0" : "1");
    fd.set("reason", reason);
    startTransition(() => {
      void (async () => {
        const result = await setTenantSuspensionAction({ error: null }, fd);
        if (result.error) setError(result.error);
        else setReason("");
      })();
    });
  }

  return (
    <section className="panel max-w-3xl p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="panel-title">การระงับการใช้งาน (Platform)</h2>
          <p className="label-muted">
            {suspended
              ? "tenant นี้ถูกระงับ สมาชิกทั้งหมด (ยกเว้น super_admin) เข้าใช้งานไม่ได้"
              : "ระงับจะบล็อกการเข้าใช้งานของสมาชิกและยกเลิก subscription"}
          </p>
        </div>
        <span className={`badge ${suspended ? "badge-warning" : "badge-success"}`}>
          {suspended ? "ถูกระงับ" : "ปกติ"}
        </span>
      </div>

      <label className="field-label">เหตุผล (บันทึกใน audit log)</label>
      <input
        type="text"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        maxLength={300}
        disabled={isPending}
        placeholder={suspended ? "เหตุผลในการปลดระงับ" : "เหตุผลในการระงับ"}
        className="form-input"
      />

      {error && <p className="alert-danger mt-3">{error}</p>}

      <Button
        variant={suspended ? "primary" : "secondary"}
        onClick={() => setConfirmOpen(true)}
        loading={isPending}
        loadingText="กำลังดำเนินการ..."
        className="mt-4 disabled:opacity-40"
      >
        {suspended ? "ปลดระงับ tenant" : "ระงับ tenant"}
      </Button>

      <ConfirmDialog
        open={confirmOpen}
        title={suspended ? "ปลดระงับ tenant" : "ระงับ tenant"}
        message={
          suspended
            ? "ยืนยันปลดระงับ? สมาชิกจะกลับมาเข้าใช้งานได้ (subscription ไม่ถูกกู้คืนอัตโนมัติ)"
            : "ยืนยันระงับ? สมาชิกทั้งหมดจะเข้าใช้งานไม่ได้ทันที และ subscription จะถูกยกเลิก"
        }
        confirmLabel={suspended ? "ปลดระงับ" : "ระงับ"}
        danger={!suspended}
        onConfirm={submit}
        onCancel={() => setConfirmOpen(false)}
      />
    </section>
  );
}
