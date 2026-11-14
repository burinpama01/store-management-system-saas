"use client";

import { useState, useTransition } from "react";
import { startChecklistRunAction } from "./actions";

export function StartRunButton({ templateId, label }: { templateId: string; label: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        className="btn-primary"
        disabled={pending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const result = await startChecklistRunAction(templateId);
            if (result && !result.ok) setError(result.error);
          });
        }}
      >
        {pending ? "กำลังเปิด…" : label}
      </button>
      {error && <p className="text-xs text-red-700" role="alert">{error}</p>}
    </div>
  );
}
