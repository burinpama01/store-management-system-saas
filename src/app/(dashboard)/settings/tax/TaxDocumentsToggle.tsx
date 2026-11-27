"use client";

import { useState, useTransition } from "react";
import { setTaxDocumentsEnabledAction } from "./actions";

export function TaxDocumentsToggle({ enabled, ready }: { enabled: boolean; ready: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function toggle() {
    setError(null);
    startTransition(async () => {
      const result = await setTaxDocumentsEnabledAction(!enabled);
      if (result.error) setError(result.error);
    });
  }

  return (
    <div className="mt-3 space-y-2">
      {!enabled && (
        <p className="text-xs text-gray-600">
          แนะนำให้นักบัญชีของร้านตรวจตัวอย่างเอกสารก่อนเปิดใช้จริง · เปิดแล้วบิลที่ออกใบกำกับจะยกเลิก/คืนเงินไม่ได้จนกว่าจะออกใบลดหนี้
        </p>
      )}
      <button type="button" className={enabled ? "btn-secondary min-h-10 text-sm" : "btn-primary min-h-10 text-sm"} disabled={isPending || (!enabled && !ready)} onClick={toggle}>
        {enabled ? "ปิดใบกำกับภาษีเต็มรูป" : "เปิดใช้ใบกำกับภาษีเต็มรูป"}
      </button>
      {error && <p className="text-sm text-red-700" role="alert">{error}</p>}
    </div>
  );
}
