"use client";

import { useState, useTransition } from "react";
import { runNotificationDiagnosticAction } from "../diagnostics/actions";

export function NotificationTest({ canRun }: { canRun: boolean }) {
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [pending, start] = useTransition();

  function run() {
    start(() => {
      void (async () => {
        const r = await runNotificationDiagnosticAction();
        setResult({ ok: r.ok, message: `${r.message} · ${new Date().toLocaleTimeString("th-TH")}` });
      })();
    });
  }

  return (
    <div className="rounded-md border border-[var(--color-border)] bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-bold text-[var(--color-text-primary)]">ทดสอบส่งการแจ้งเตือน</p>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
            ส่งข้อความ [TEST] ผ่าน notification dispatcher เพื่อตรวจการเชื่อมต่อ provider
          </p>
        </div>
        <button
          type="button"
          onClick={run}
          disabled={!canRun || pending}
          className="btn-secondary shrink-0 text-xs disabled:opacity-40"
        >
          {pending ? "กำลังทดสอบ..." : "ทดสอบ"}
        </button>
      </div>
      {!canRun && (
        <p className="mt-2 text-xs text-amber-700">ต้องมีสิทธิ์ notifications.manage จึงจะทดสอบได้</p>
      )}
      {result && (
        <p
          className={`mt-3 rounded-md px-3 py-2 text-sm ${
            result.ok
              ? "border border-emerald-200 bg-emerald-50 text-emerald-700"
              : "border border-red-200 bg-red-50 text-red-700"
          }`}
        >
          {result.message}
        </p>
      )}
    </div>
  );
}
