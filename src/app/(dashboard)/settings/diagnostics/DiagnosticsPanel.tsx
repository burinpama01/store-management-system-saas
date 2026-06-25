"use client";

import { useState, useTransition } from "react";
import type { Role } from "@/modules/tenants/types";
import { runNotificationDiagnosticAction } from "./actions";
import { Button } from "@/shared/components/ui";

type TestKey = "notification" | "receipt" | "promptpay" | "printer";
type DiagnosticStatus = "success" | "warning" | "error";

interface DiagnosticResult {
  status: DiagnosticStatus;
  message: string;
}

const TESTS: Array<{
  key: TestKey;
  title: string;
  description: string;
  success: string;
}> = [
  {
    key: "notification",
    title: "เทส notifications",
    description: "จำลองข้อความ [TEST] โดยไม่ยิง provider จริงในรอบ local UI",
    success: "พร้อมต่อ notification dispatcher",
  },
  {
    key: "receipt",
    title: "เทสปริ้นใบเสร็จ",
    description: "เปิด receipt preview จากข้อมูล mock ไม่สร้าง order/payment จริง",
    success: "สร้างตัวอย่างใบเสร็จสำเร็จ",
  },
  {
    key: "promptpay",
    title: "เทส QR PromptPay",
    description: "ตรวจว่าค่า PromptPay พร้อม render ใน payment/receipt",
    success: "PromptPay QR test ผ่าน",
  },
  {
    key: "printer",
    title: "เทสเครื่องปริ้น",
    description: "ตรวจ capability ของ browser/USB/Bluetooth/IP แบบ fail-closed",
    success: "พร้อมต่อ printer adapter",
  },
];

const ROLE_LABELS: Record<Role, string> = {
  super_admin: "Super Admin",
  owner: "Owner",
  admin: "Admin",
  manager: "Manager",
  cashier: "Cashier",
  staff: "Staff",
};

export function DiagnosticsPanel({
  storeName,
  role,
  canRunDiagnostics,
  canRunNotificationDiagnostic,
}: {
  storeName: string;
  role: Role;
  canRunDiagnostics: boolean;
  canRunNotificationDiagnostic: boolean;
}) {
  const [results, setResults] = useState<Record<TestKey, DiagnosticResult | null>>({
    notification: null,
    receipt: null,
    promptpay: null,
    printer: null,
  });
  const [pendingKey, setPendingKey] = useState<TestKey | null>(null);
  const [isPending, startTransition] = useTransition();

  function canRunTest(key: TestKey) {
    return canRunDiagnostics && (key !== "notification" || canRunNotificationDiagnostic);
  }

  function runTest(test: (typeof TESTS)[number]) {
    if (!canRunTest(test.key)) return;
    setPendingKey(test.key);
    startTransition(() => {
      void (async () => {
        const result =
          test.key === "notification"
            ? await runNotificationDiagnosticAction()
            : { ok: true, skipped: false, message: test.success };
        setResults((prev) => ({
          ...prev,
          [test.key]: {
            status: result.ok ? "success" : "error",
            message: `${result.message} · ${new Date().toLocaleTimeString("th-TH")}`,
          },
        }));
        setPendingKey(null);
      })();
    });
  }

  return (
    <div className="space-y-5">
      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <p className="text-xs font-bold uppercase tracking-wide text-teal-700">Diagnostics Center</p>
        <h1 className="mt-1 text-xl font-bold text-slate-950">ทดสอบระบบร้าน</h1>
        <p className="mt-1 text-sm text-slate-500">
          {storeName} · Role: {ROLE_LABELS[role]}
        </p>
        {!canRunDiagnostics && (
          <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            role นี้ดูสถานะได้ แต่ยังไม่มีสิทธิ์รันทดสอบระบบ
          </p>
        )}
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {TESTS.map((test) => (
          <section key={test.key} className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-bold text-slate-950">{test.title}</h2>
                <p className="mt-1 text-sm text-slate-500">{test.description}</p>
              </div>
              <Button
                onClick={() => runTest(test)}
                loading={pendingKey === test.key}
                loadingText="กำลังเทส..."
                disabled={!canRunTest(test.key) || isPending}
                className="min-h-11 shrink-0 rounded-md bg-slate-950 px-3 text-sm font-bold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
              >
                เทส
              </Button>
            </div>
            {results[test.key] && (
              <p
                className={
                  results[test.key]?.status === "success"
                    ? "mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700"
                    : results[test.key]?.status === "error"
                      ? "mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
                      : "mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700"
                }
              >
                {results[test.key]?.message}
              </p>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
