"use client";

import { useState } from "react";
import { printReceiptAuto, CHANNEL_LABELS } from "@/modules/printing/print-router";
import type { ReceiptData } from "@/modules/printing/types";

const SAMPLE_ITEMS = [
  { name: "กาแฟดำ", quantity: 1, unitPrice: 45, totalPrice: 45, modifierNames: [] as string[] },
  { name: "ลาเต้", variantName: "ร้อน", quantity: 2, unitPrice: 55, totalPrice: 110, modifierNames: ["หวานน้อย"] },
];

type Key = "receipt" | "promptpay" | "printer";

export function ReceiptTests({
  promptpayConfigured,
  storeName,
  paperWidth,
}: {
  promptpayConfigured: boolean;
  storeName: string;
  paperWidth: "58mm" | "80mm";
}) {
  const [results, setResults] = useState<Record<Key, { ok: boolean; message: string } | null>>({
    receipt: null,
    promptpay: null,
    printer: null,
  });

  function set(key: Key, ok: boolean, message: string) {
    setResults((p) => ({ ...p, [key]: { ok, message } }));
  }

  async function runReceipt() {
    const printedAt = new Date().toISOString();
    const payments = [{ method: "cash", amount: 155, receivedAmount: 160, changeAmount: 5 }];
    const browser: ReceiptData = {
      storeName,
      paperWidth,
      printedAt,
      orderNumber: "TEST-0001",
      showTaxId: false,
      showQrPayment: false,
      items: SAMPLE_ITEMS,
      subtotal: 155,
      discount: 0,
      total: 155,
      payments,
      footerText: "ขอบคุณที่ใช้บริการ · ใบเสร็จทดสอบ",
    };
    try {
      // Fallback order: Bluetooth → USB → PDF/Browser.
      const channel = await printReceiptAuto(
        {
          storeName,
          orderNumber: "TEST-0001",
          items: SAMPLE_ITEMS,
          subtotal: 155,
          discount: 0,
          total: 155,
          payments,
          footerText: "ใบเสร็จทดสอบ",
          paperWidth,
          printedAt,
        },
        browser,
      );
      set("receipt", true, `ส่งใบเสร็จผ่าน ${CHANNEL_LABELS[channel]} แล้ว`);
    } catch (e) {
      set("receipt", false, e instanceof Error ? e.message : "สั่งพิมพ์ไม่สำเร็จ");
    }
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
