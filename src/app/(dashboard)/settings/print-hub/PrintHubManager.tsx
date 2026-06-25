"use client";

import { useCallback, useEffect, useState } from "react";
import { rotateHubTokenAction } from "./actions";
import { buildReceiptPrinterBytes } from "@/modules/printing/receipt-printer-bytes";
import { bytesToBase64 } from "@/modules/printing/print-job-base64";
import type { ReceiptData } from "@/modules/printing/types";

interface HubStatus {
  online: boolean;
  secondsAgo: number | null;
  pendingJobs: number;
}

interface TestPrinter {
  id: string;
  paperWidth: "58mm" | "80mm";
}

interface PrintHubManagerProps {
  serverUrl: string;
  storeId: string;
  storeName: string;
  hasToken: boolean;
  testPrinter: TestPrinter | null;
  initialStatus: HubStatus;
  loadError: string | null;
}

/** Mirrors the real POS receipt so the test exercises the same raster path. */
function buildHubTestReceipt(storeName: string, paperWidth: "58mm" | "80mm"): ReceiptData {
  return {
    storeName,
    showTaxId: false,
    orderNumber: "PRINT-HUB-TEST",
    items: [{ name: "ทดสอบ Print Hub", quantity: 1, unitPrice: 1, totalPrice: 1, modifierNames: [] }],
    subtotal: 1,
    discount: 0,
    total: 1,
    payments: [{ method: "test", amount: 1 }],
    paymentStatus: "paid",
    footerText: "ทดสอบส่งงานพิมพ์ผ่าน StoreOS Print Hub",
    showQrPayment: false,
    paperWidth,
    printedAt: new Date().toISOString(),
  };
}

function formatAgo(secondsAgo: number | null): string {
  if (secondsAgo === null) return "ยังไม่เคยเชื่อมต่อ";
  if (secondsAgo < 60) return `${secondsAgo} วินาทีที่แล้ว`;
  if (secondsAgo < 3600) return `${Math.round(secondsAgo / 60)} นาทีที่แล้ว`;
  return `${Math.round(secondsAgo / 3600)} ชั่วโมงที่แล้ว`;
}

export function PrintHubManager({
  serverUrl,
  storeId,
  storeName,
  hasToken,
  testPrinter,
  initialStatus,
  loadError,
}: PrintHubManagerProps) {
  const [status, setStatus] = useState<HubStatus>(initialStatus);
  const [token, setToken] = useState<string | null>(null);
  const [tokenExists, setTokenExists] = useState(hasToken);
  const [busy, setBusy] = useState<"token" | "test" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(loadError);
  const [copied, setCopied] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/print/hub/status", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { online?: boolean; secondsAgo?: number | null; pendingJobs?: number };
      setStatus({
        online: Boolean(data.online),
        secondsAgo: data.secondsAgo ?? null,
        pendingJobs: data.pendingJobs ?? 0,
      });
    } catch {
      // Keep the last known status on transient errors.
    }
  }, []);

  useEffect(() => {
    const id = setInterval(refreshStatus, 10_000);
    return () => clearInterval(id);
  }, [refreshStatus]);

  const copy = useCallback(async (value: string, key: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    } catch {
      setError("คัดลอกไม่สำเร็จ — คัดลอกด้วยมือแทน");
    }
  }, []);

  async function rotateToken() {
    setBusy("token");
    setError(null);
    setMessage(null);
    try {
      const result = await rotateHubTokenAction();
      if (result.error || !result.token) {
        setError(result.error ?? "สร้างโทเค็นไม่สำเร็จ");
        return;
      }
      setToken(result.token);
      setTokenExists(true);
      setMessage("สร้างโทเค็นใหม่แล้ว — คัดลอกไปวางในตัวติดตั้ง Print Hub (โทเค็นเดิมจะใช้ไม่ได้ทันที)");
    } finally {
      setBusy(null);
    }
  }

  async function testPrint() {
    if (!testPrinter) {
      setError("ยังไม่มีเครื่องพิมพ์ IP/WiFi ที่บันทึกไว้ — เพิ่มในแท็บ “เครื่องพิมพ์” ก่อน");
      return;
    }
    setBusy("test");
    setError(null);
    setMessage(null);
    try {
      // Render the receipt to a raster bitmap in the browser (same path as real
      // POS prints) so Thai text is not garbled by the printer code page.
      const receipt = buildHubTestReceipt(storeName, testPrinter.paperWidth);
      const printJobBase64 = bytesToBase64(await buildReceiptPrinterBytes(receipt, receipt));
      const res = await fetch("/api/print/enqueue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ printerId: testPrinter.id, printJobBase64 }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? "ส่งงานพิมพ์ไม่สำเร็จ");
        return;
      }
      setMessage("ส่งใบทดสอบเข้าคิวแล้ว — Print Hub บนเครื่องแคชเชียร์จะพิมพ์ภายในไม่กี่วินาที");
      void refreshStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : "ส่งงานพิมพ์ไม่สำเร็จ");
    } finally {
      setBusy(null);
    }
  }

  const configSnippet = JSON.stringify(
    { serverUrl, storeId, hubToken: token ?? "PASTE_TOKEN_HERE", pollIntervalMs: 2500 },
    null,
    2,
  );
  const installCommand = [
    "powershell -ExecutionPolicy Bypass -File .\\print-hub\\install-windows.ps1 `",
    `  -ServerUrl "${serverUrl}" \``,
    `  -StoreId   "${storeId}" \``,
    `  -HubToken  "${token ?? "<โทเค็น>"}"`,
  ].join("\n");

  return (
    <div className="space-y-5">
      {/* Status card */}
      <section className="panel max-w-3xl p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="panel-title mb-1">StoreOS Print Hub</h2>
            <p className="label-muted">
              ตัวกลางพิมพ์ใบเสร็จสำหรับร้านที่ใช้ POS บน iPad/แท็บเล็ต — งานพิมพ์ทุกเครื่องส่งผ่าน Hub บนเครื่องแคชเชียร์
            </p>
          </div>
          <span
            className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-semibold ${
              status.online
                ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                : "bg-red-50 text-red-700 border border-red-200"
            }`}
          >
            <span className={`h-2 w-2 rounded-full ${status.online ? "bg-emerald-500" : "bg-red-500"}`} />
            {status.online ? "ออนไลน์" : "ออฟไลน์"}
          </span>
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-muted)] p-3">
            <p className="text-xs text-[var(--muted)]">เชื่อมต่อล่าสุด</p>
            <p className="text-sm font-semibold text-[var(--ink)]">{formatAgo(status.secondsAgo)}</p>
          </div>
          <div className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-muted)] p-3">
            <p className="text-xs text-[var(--muted)]">งานพิมพ์ค้างในคิว</p>
            <p className="text-sm font-semibold text-[var(--ink)]">{status.pendingJobs} งาน</p>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={testPrint}
            disabled={busy !== null}
            className="btn-secondary min-h-11 px-3 text-xs disabled:opacity-40"
            title={testPrinter ? "ส่งใบทดสอบเข้าคิว" : "ยังไม่มีเครื่องพิมพ์ IP/WiFi"}
          >
            {busy === "test" ? "กำลังส่ง..." : "ทดสอบพิมพ์ผ่าน Hub"}
          </button>
          <button
            type="button"
            onClick={refreshStatus}
            disabled={busy !== null}
            className="btn-secondary min-h-11 px-3 text-xs disabled:opacity-40"
          >
            รีเฟรชสถานะ
          </button>
        </div>
        {!testPrinter && (
          <p className="mt-3 rounded-[var(--radius-md)] border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            ยังไม่มีเครื่องพิมพ์ IP/WiFi ที่บันทึกไว้ — เพิ่มในแท็บ “เครื่องพิมพ์” ก่อนทดสอบ
          </p>
        )}
      </section>

      {/* Token + config */}
      <section className="panel max-w-3xl p-5">
        <h3 className="panel-title mb-1">โทเค็นและการตั้งค่า Hub</h3>
        <p className="label-muted mb-3">
          สร้างโทเค็นลับสำหรับร้านนี้ แล้วนำไปใส่ตอนติดตั้ง Print Hub บนเครื่องแคชเชียร์ (เก็บเป็นความลับ)
        </p>
        <a
          href="/downloads/storeos-print-hub.zip"
          download
          className="btn-primary mb-3 inline-flex min-h-11 items-center gap-2 px-4 text-sm font-semibold"
        >
          ⬇ ดาวน์โหลดตัวติดตั้ง (.zip)
        </a>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={rotateToken}
            disabled={busy !== null}
            className="btn-secondary min-h-11 px-3 text-xs disabled:opacity-40"
          >
            {busy === "token" ? "กำลังสร้าง..." : tokenExists ? "สร้างโทเค็นใหม่ (หมุน)" : "สร้างโทเค็น"}
          </button>
          {tokenExists && !token && <span className="text-xs text-[var(--muted)]">มีโทเค็นอยู่แล้ว (ซ่อนไว้)</span>}
        </div>

        {token && (
          <div className="mt-3 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-muted)] p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold text-[var(--ink)]">โทเค็น (แสดงครั้งเดียว)</p>
              <button type="button" onClick={() => copy(token, "token")} className="btn-secondary min-h-9 px-2 text-[11px]">
                {copied === "token" ? "คัดลอกแล้ว" : "คัดลอก"}
              </button>
            </div>
            <code className="mt-1 block break-all text-xs text-[var(--ink)]">{token}</code>
          </div>
        )}

        <div className="mt-4 space-y-3">
          <div>
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold text-[var(--ink)]">ค่าเชื่อมต่อ (StoreId / serverUrl)</p>
              <button
                type="button"
                onClick={() => copy(configSnippet, "config")}
                className="btn-secondary min-h-9 px-2 text-[11px]"
              >
                {copied === "config" ? "คัดลอกแล้ว" : "คัดลอก JSON"}
              </button>
            </div>
            <pre className="mt-1 overflow-auto rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-muted)] p-3 text-[11px] text-[var(--ink)]">
{configSnippet}
            </pre>
            <p className="mt-1 text-[11px] text-[var(--muted)]">StoreId: <code>{storeId}</code></p>
          </div>

          <div>
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold text-[var(--ink)]">คำสั่งติดตั้ง (Windows · PowerShell แบบ Admin)</p>
              <button
                type="button"
                onClick={() => copy(installCommand, "install")}
                className="btn-secondary min-h-9 px-2 text-[11px]"
              >
                {copied === "install" ? "คัดลอกแล้ว" : "คัดลอกคำสั่ง"}
              </button>
            </div>
            <pre className="mt-1 overflow-auto rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-muted)] p-3 text-[11px] text-[var(--ink)]">
{installCommand}
            </pre>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="panel max-w-3xl p-5">
        <h3 className="panel-title mb-2">วิธีตั้งค่า (ทำครั้งเดียวต่อร้าน)</h3>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-[var(--ink)]">
          <li>เปิดเครื่อง Windows ในร้าน (มินิพีซี/เครื่องแคชเชียร์) ต่อ WiFi เดียวกับเครื่องพิมพ์ และติดตั้ง Node.js LTS</li>
          <li>กด “ดาวน์โหลดตัวติดตั้ง (.zip)” ด้านบน แล้วแตกไฟล์ (Extract All) จะได้โฟลเดอร์ <code>storeos-print-hub</code></li>
          <li>กด “สร้างโทเค็น” ด้านบน → เปิด PowerShell (Run as Administrator) → <code>cd</code> เข้าโฟลเดอร์ที่แตกไว้ → วางคำสั่งติดตั้ง</li>
          <li>เสร็จแล้ว Hub จะเปิดเองทุกครั้งที่เปิดเครื่อง — สถานะด้านบนจะเป็น 🟢 ออนไลน์ แล้วกด “ทดสอบพิมพ์”</li>
        </ol>
        <p className="mt-3 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-muted)] p-3 text-sm text-[var(--muted)]">
          iPad/แท็บเล็ตใช้ POS ได้ตามปกติ — เมื่อสั่งพิมพ์ ระบบจะส่งงานเข้าคิวบนเซิร์ฟเวอร์ แล้ว Print Hub บนเครื่องแคชเชียร์
          ดึงไปพิมพ์ออกเครื่องพิมพ์ในร้านให้อัตโนมัติ คู่มือฉบับเต็มอยู่ที่ <code>scripts/print-hub/README-TH.txt</code>
        </p>
      </section>

      {message && (
        <p className="max-w-3xl rounded-[var(--radius-md)] border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {message}
        </p>
      )}
      {error && (
        <p className="max-w-3xl rounded-[var(--radius-md)] border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
