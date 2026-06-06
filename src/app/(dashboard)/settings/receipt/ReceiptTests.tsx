"use client";

import { useState } from "react";

type Key = "receipt" | "promptpay" | "printer";

export function ReceiptTests({ promptpayConfigured }: { promptpayConfigured: boolean }) {
  const [results, setResults] = useState<Record<Key, { ok: boolean; message: string } | null>>({
    receipt: null,
    promptpay: null,
    printer: null,
  });

  function set(key: Key, ok: boolean, message: string) {
    setResults((p) => ({ ...p, [key]: { ok, message } }));
  }

  function runReceipt() {
    const ok = typeof window !== "undefined" && typeof window.print === "function";
    set("receipt", ok, ok ? "เบราว์เซอร์รองรับการพิมพ์ใบเสร็จ (window.print)" : "เบราว์เซอร์นี้ไม่รองรับการพิมพ์");
  }

  function runPromptpay() {
    set(
      "promptpay",
      promptpayConfigured,
      promptpayConfigured
        ? "ตั้งค่า PromptPay สำหรับใบเสร็จแล้ว พร้อม render QR"
        : "ยังไม่ได้ตั้งค่า PromptPay ID ในใบเสร็จ",
    );
  }

  function runPrinter() {
    const caps: string[] = [];
    const nav = typeof navigator !== "undefined" ? (navigator as Navigator & { usb?: unknown; bluetooth?: unknown; serial?: unknown }) : undefined;
    if (nav?.usb) caps.push("USB");
    if (nav?.bluetooth) caps.push("Bluetooth");
    if (nav?.serial) caps.push("Serial");
    caps.push("Browser");
    set("printer", true, `ช่องทางที่เบราว์เซอร์รองรับ: ${caps.join(", ")}`);
  }

  const TESTS: Array<{ key: Key; title: string; desc: string; run: () => void }> = [
    { key: "receipt", title: "ทดสอบพิมพ์ใบเสร็จ", desc: "ตรวจว่าเบราว์เซอร์พิมพ์ใบเสร็จได้", run: runReceipt },
    { key: "promptpay", title: "ทดสอบ QR PromptPay บนใบเสร็จ", desc: "ตรวจว่าตั้งค่า PromptPay พร้อม render", run: runPromptpay },
    { key: "printer", title: "ทดสอบเครื่องพิมพ์", desc: "ตรวจช่องทาง USB/Bluetooth/IP/Browser", run: runPrinter },
  ];

  return (
    <section className="panel max-w-3xl p-5">
      <h2 className="panel-title mb-3">ทดสอบการพิมพ์ & ชำระเงิน</h2>
      <div className="grid gap-3 sm:grid-cols-3">
        {TESTS.map((t) => (
          <div key={t.key} className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-muted)] p-3">
            <p className="text-sm font-bold text-[var(--ink)]">{t.title}</p>
            <p className="mt-1 text-xs text-[var(--muted)]">{t.desc}</p>
            <button type="button" onClick={t.run} className="btn-secondary mt-3 w-full text-xs">
              ทดสอบ
            </button>
            {results[t.key] && (
              <p
                className={`mt-2 rounded px-2 py-1 text-xs ${
                  results[t.key]!.ok
                    ? "border border-emerald-200 bg-emerald-50 text-emerald-700"
                    : "border border-amber-200 bg-amber-50 text-amber-800"
                }`}
              >
                {results[t.key]!.message}
              </p>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
