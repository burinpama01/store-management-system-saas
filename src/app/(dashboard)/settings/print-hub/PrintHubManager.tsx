"use client";

import { useCallback, useEffect, useState } from "react";
import { rotateHubTokenAction } from "./actions";
import { PrinterConnectionPanel } from "@/modules/printing/PrinterConnectionPanel";
import { buildReceiptPrinterBytes } from "@/modules/printing/receipt-printer-bytes";
import { bytesToBase64 } from "@/modules/printing/print-job-base64";
import type { ReceiptData } from "@/modules/printing/types";
import type { Printer } from "@/modules/stores/types";

interface HubStatus {
  online: boolean;
  secondsAgo: number | null;
  pendingJobs: number;
}

interface TestPrinter {
  id: string;
  paperWidth: "58mm" | "80mm";
}

type SavePrinterAction = (
  prev: { error: string | null; saved?: boolean },
  formData: FormData,
) => Promise<{ error: string | null; saved?: boolean }>;

interface PrintHubManagerProps {
  serverUrl: string;
  storeId: string;
  storeName: string;
  hasToken: boolean;
  testPrinter: TestPrinter | null;
  printers: Printer[];
  paperWidth: "58mm" | "80mm";
  initialStatus: HubStatus;
  loadError: string | null;
  saveNetworkPrinterAction: SavePrinterAction;
  saveHubBluetoothPrinterAction: SavePrinterAction;
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

/** Plain-language overview so a non-technical owner sees how a print travels. */
function HubFlowDiagram() {
  const nodes = [
    { icon: "📱", t1: "iPad / POS", t2: "กดสั่งพิมพ์" },
    { icon: "☁️", t1: "เซิร์ฟเวอร์", t2: "คิวงานพิมพ์" },
    { icon: "💻", t1: "พีซีแคชเชียร์", t2: "Print Hub" },
    { icon: "🖨️", t1: "เครื่องพิมพ์", t2: "WiFi / Bluetooth" },
  ];
  const W = 128;
  const GAP = 32;
  return (
    <svg viewBox={`0 0 ${nodes.length * W + (nodes.length - 1) * GAP} 96`} className="h-auto w-full" role="img" aria-label="เส้นทางงานพิมพ์ผ่าน Print Hub">
      {nodes.map((n, i) => {
        const x = i * (W + GAP);
        return (
          <g key={n.t1}>
            <rect x={x} y={16} width={W} height={64} rx={10} fill="var(--surface-muted)" stroke="var(--border)" />
            <text x={x + W / 2} y={40} textAnchor="middle" fontSize={20}>{n.icon}</text>
            <text x={x + W / 2} y={58} textAnchor="middle" fontSize={11} fontWeight={700} fill="var(--ink)">{n.t1}</text>
            <text x={x + W / 2} y={72} textAnchor="middle" fontSize={9} fill="var(--muted)">{n.t2}</text>
            {i < nodes.length - 1 && (
              <g>
                <line x1={x + W + 4} y1={48} x2={x + W + GAP - 8} y2={48} stroke="var(--muted)" strokeWidth={2} />
                <polygon points={`${x + W + GAP - 10},44 ${x + W + GAP - 2},48 ${x + W + GAP - 10},52`} fill="var(--muted)" />
              </g>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/** A numbered wizard step with a done/checkmark state. */
function StepCard({
  index,
  title,
  done,
  children,
}: {
  index: number;
  title: string;
  done: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="panel max-w-3xl p-5">
      <div className="mb-3 flex items-center gap-3">
        <span
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold ${
            done
              ? "bg-emerald-500 text-white"
              : "bg-[var(--surface-muted)] text-[var(--ink)] border border-[var(--border)]"
          }`}
        >
          {done ? "✓" : index}
        </span>
        <h3 className="panel-title">{title}</h3>
      </div>
      {children}
    </section>
  );
}

export function PrintHubManager({
  serverUrl,
  storeId,
  storeName,
  hasToken,
  testPrinter,
  printers,
  paperWidth,
  initialStatus,
  loadError,
  saveNetworkPrinterAction,
  saveHubBluetoothPrinterAction,
}: PrintHubManagerProps) {
  const [status, setStatus] = useState<HubStatus>(initialStatus);
  const [token, setToken] = useState<string | null>(null);
  const [tokenExists, setTokenExists] = useState(hasToken);
  const [busy, setBusy] = useState<"token" | "test" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(loadError);
  const [copied, setCopied] = useState<string | null>(null);
  const [tested, setTested] = useState(false);

  const hasPrinter = printers.some(
    (p) => ((p.type === "ip" || p.type === "escpos") && p.ipAddress) || (p.type === "bluetooth" && p.hubBluetoothPort),
  );

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

  /** Saves the pre-filled print-hub.config.json so the operator only has to drop
   *  it next to install.cmd and double-click — no copy/paste into PowerShell. */
  const downloadConfig = useCallback((snippet: string) => {
    try {
      const blob = new Blob([snippet + "\n"], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "print-hub.config.json";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setError("ดาวน์โหลดไฟล์ตั้งค่าไม่สำเร็จ — คัดลอก JSON ด้วยมือแทน");
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
      setMessage("สร้างโทเค็นใหม่แล้ว — กดดาวน์โหลดไฟล์ตั้งค่าด้านล่าง (โทเค็นเดิมจะใช้ไม่ได้ทันที)");
    } finally {
      setBusy(null);
    }
  }

  async function testPrint() {
    if (!testPrinter) {
      setError("ยังไม่มีเครื่องพิมพ์ที่บันทึกไว้ — เพิ่มเครื่องพิมพ์ในขั้นตอนที่ 2 ก่อน");
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
      setTested(true);
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
      {/* Intro + live status */}
      <section className="panel max-w-3xl p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="panel-title mb-1">ตั้งค่า Print Hub (3 ขั้นตอน)</h2>
            <p className="label-muted">
              ทำให้ร้านที่ใช้ POS บน iPad/แท็บเล็ต พิมพ์ใบเสร็จออกเครื่องพิมพ์ในร้านได้ — รวมถึงเครื่องพิมพ์ Bluetooth ที่ iPad ต่อตรงไม่ได้
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
            {status.online ? "Hub ออนไลน์" : "Hub ออฟไลน์"}
          </span>
        </div>
        <div className="mt-4 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-muted)] p-3">
          <HubFlowDiagram />
        </div>
      </section>

      {/* Step 1 — install the Hub on the cashier PC */}
      <StepCard index={1} title="ติดตั้ง Print Hub บนเครื่องแคชเชียร์" done={status.online}>
        <p className="label-muted mb-3">
          ทำบนพีซี/มินิพีซี Windows ในร้าน (เปิดทิ้งไว้ตอนเปิดร้าน) — <b>ไม่ต้องลง Node.js เอง</b> ตัวติดตั้งจัดการให้
        </p>

        <ol className="mb-4 list-decimal space-y-1 pl-5 text-sm text-[var(--ink)]">
          <li>กด “สร้างโทเค็น” แล้วกด “⬇ ดาวน์โหลดไฟล์ตั้งค่า”</li>
          <li>กด “⬇ ดาวน์โหลดตัวติดตั้ง (.zip)” → คลิกขวา → Extract All</li>
          <li><b>ดับเบิลคลิก <code>install.cmd</code></b> → กด Yes ตอนถามสิทธิ์ผู้ดูแล → รอจนขึ้น Done</li>
          <li>สถานะด้านบนจะกลายเป็น 🟢 Hub ออนไลน์</li>
        </ol>

        <div className="mb-3 flex flex-wrap items-center gap-2">
          <a
            href="/downloads/storeos-print-hub.zip"
            download
            className="btn-primary inline-flex min-h-11 items-center gap-2 px-4 text-sm font-semibold"
          >
            ⬇ ดาวน์โหลดตัวติดตั้ง (.zip)
          </a>
          <button
            type="button"
            onClick={rotateToken}
            disabled={busy !== null}
            className="btn-secondary min-h-11 px-3 text-sm disabled:opacity-40"
          >
            {busy === "token" ? "กำลังสร้าง..." : tokenExists ? "สร้างโทเค็นใหม่ (หมุน)" : "สร้างโทเค็น"}
          </button>
          {tokenExists && !token && <span className="text-xs text-[var(--muted)]">มีโทเค็นอยู่แล้ว (ซ่อนไว้)</span>}
        </div>

        {token && (
          <div className="mb-3 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-muted)] p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold text-[var(--ink)]">โทเค็น (แสดงครั้งเดียว)</p>
              <button type="button" onClick={() => copy(token, "token")} className="btn-secondary min-h-9 px-2 text-[11px]">
                {copied === "token" ? "คัดลอกแล้ว" : "คัดลอก"}
              </button>
            </div>
            <code className="mt-1 block break-all text-xs text-[var(--ink)]">{token}</code>
            <button
              type="button"
              onClick={() => downloadConfig(configSnippet)}
              className="btn-primary mt-3 inline-flex min-h-11 items-center gap-2 px-4 text-sm font-semibold"
            >
              ⬇ ดาวน์โหลดไฟล์ตั้งค่า (print-hub.config.json)
            </button>
            <p className="mt-2 text-[11px] text-[var(--muted)]">
              ตัวติดตั้งจะดึงไฟล์นี้จากโฟลเดอร์ Downloads ให้อัตโนมัติ
            </p>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-muted)] p-3">
            <p className="text-xs text-[var(--muted)]">เชื่อมต่อล่าสุด</p>
            <p className="text-sm font-semibold text-[var(--ink)]">{formatAgo(status.secondsAgo)}</p>
          </div>
          <div className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-muted)] p-3">
            <p className="text-xs text-[var(--muted)]">งานพิมพ์ค้างในคิว</p>
            <p className="text-sm font-semibold text-[var(--ink)]">{status.pendingJobs} งาน</p>
          </div>
        </div>

        <details className="mt-3 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-muted)] p-3">
          <summary className="cursor-pointer text-xs font-semibold text-[var(--muted)]">
            วิธีติดตั้งแบบกำหนดเอง / ค่าเชื่อมต่อ (ขั้นสูง)
          </summary>
          <div className="mt-2 space-y-3">
            <div>
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-semibold text-[var(--ink)]">ค่าเชื่อมต่อ (StoreId / serverUrl)</p>
                <button type="button" onClick={() => copy(configSnippet, "config")} className="btn-secondary min-h-9 px-2 text-[11px]">
                  {copied === "config" ? "คัดลอกแล้ว" : "คัดลอก JSON"}
                </button>
              </div>
              <pre className="mt-1 overflow-auto rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-3 text-[11px] text-[var(--ink)]">
{configSnippet}
              </pre>
              <p className="mt-1 text-[11px] text-[var(--muted)]">StoreId: <code>{storeId}</code></p>
            </div>
            <div>
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-semibold text-[var(--ink)]">คำสั่งติดตั้ง (PowerShell แบบ Admin)</p>
                <button type="button" onClick={() => copy(installCommand, "install")} className="btn-secondary min-h-9 px-2 text-[11px]">
                  {copied === "install" ? "คัดลอกแล้ว" : "คัดลอกคำสั่ง"}
                </button>
              </div>
              <pre className="mt-1 overflow-auto rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-3 text-[11px] text-[var(--ink)]">
{installCommand}
              </pre>
            </div>
          </div>
        </details>
      </StepCard>

      {/* Step 2 — add a printer (WiFi or Bluetooth, unified) */}
      <StepCard index={2} title="เพิ่มเครื่องพิมพ์ (WiFi หรือ Bluetooth)" done={hasPrinter}>
        <p className="label-muted mb-2">
          เพิ่มเครื่องพิมพ์ที่อยู่ในร้าน — เลือกได้ทั้งแบบ <b>IP / WiFi</b> หรือ <b>Bluetooth ผ่าน Hub</b>
        </p>
        <p className="mb-3 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-muted)] p-3 text-xs text-[var(--muted)]">
          🔵 เครื่องพิมพ์ Bluetooth: จับคู่กับเครื่องแคชเชียร์ก่อน แล้วดับเบิลคลิก <code>find-bluetooth-ports.cmd</code> (อยู่ในตัวติดตั้ง) เพื่อดูเลขพอร์ต COM
          มากรอกในช่อง “พอร์ต COM”
        </p>
        <PrinterConnectionPanel
          variant="panel"
          className="max-w-none"
          printers={printers}
          storeName={storeName}
          paperWidth={paperWidth}
          saveNetworkPrinterAction={saveNetworkPrinterAction}
          saveHubBluetoothPrinterAction={saveHubBluetoothPrinterAction}
        />
      </StepCard>

      {/* Step 3 — test print */}
      <StepCard index={3} title="ทดสอบพิมพ์" done={tested}>
        <p className="label-muted mb-3">
          กดทดสอบเพื่อส่งใบทดสอบผ่าน Hub ไปยังเครื่องพิมพ์หลัก (เครื่องพิมพ์ Bluetooth กดทดสอบจากปุ่ม “BT (Hub)” ในขั้นตอนที่ 2 ได้)
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={testPrint}
            disabled={busy !== null || !testPrinter}
            className="btn-primary min-h-11 px-4 text-sm font-semibold disabled:opacity-40"
            title={testPrinter ? "ส่งใบทดสอบเข้าคิว" : "ยังไม่มีเครื่องพิมพ์ที่บันทึกไว้"}
          >
            {busy === "test" ? "กำลังส่ง..." : "ทดสอบพิมพ์ผ่าน Hub"}
          </button>
          <button
            type="button"
            onClick={refreshStatus}
            disabled={busy !== null}
            className="btn-secondary min-h-11 px-3 text-sm disabled:opacity-40"
          >
            รีเฟรชสถานะ
          </button>
        </div>
        {!testPrinter && (
          <p className="mt-3 rounded-[var(--radius-md)] border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            ยังไม่มีเครื่องพิมพ์ที่บันทึกไว้ — เพิ่มในขั้นตอนที่ 2 ก่อนทดสอบ
          </p>
        )}
      </StepCard>

      {/* Done */}
      <section className="panel max-w-3xl bg-emerald-50 p-5">
        <h3 className="panel-title mb-1 text-emerald-800">🎉 พร้อมใช้งานบน iPad แล้ว</h3>
        <p className="text-sm text-emerald-700">
          พนักงานใช้ POS บน iPad/แท็บเล็ตได้ตามปกติ — เมื่อกดพิมพ์ ระบบจะส่งงานเข้าคิว แล้ว Print Hub บนเครื่องแคชเชียร์
          ดึงไปพิมพ์ออกเครื่องพิมพ์ในร้านให้อัตโนมัติ ภายในไม่กี่วินาที
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
