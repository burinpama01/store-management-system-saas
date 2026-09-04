"use client";

import { useActionState, useCallback, useEffect, useState } from "react";
import {
  forgetUsbBindingAction,
  resolveUnknownPrintJobAction,
  rotateHubTokenAction,
  setUsbBindingPolicyAction,
} from "./actions";
import { HUB_USB_BINDING_POLICIES } from "@/modules/printing/print-hub";
import { PrinterConnectionPanel } from "@/modules/printing/PrinterConnectionPanel";
import { buildReceiptPrinterBytes } from "@/modules/printing/receipt-printer-bytes";
import { bytesToBase64 } from "@/modules/printing/print-job-base64";
import type { ReceiptData } from "@/modules/printing/types";
import type { Printer } from "@/modules/stores/types";

/** งานที่ Hub เคลมไปแล้วแต่ไม่ได้รายงานผล — ต้องให้คนดูกระดาษจริงก่อนตัดสิน */
export interface UnknownPrintJob {
  id: string;
  jobKind: "receipt" | "station_ticket" | null;
  attempts: number;
  claimedAt: string | null;
  createdAt: string;
}

interface HubStatus {
  online: boolean;
  secondsAgo: number | null;
  pendingJobs: number;
  claimedJobs: number;
  unknownJobs: number;
  failedJobs: number;
  unknownJobList: UnknownPrintJob[];
  /** เครื่องพิมพ์ที่ Hub agent สแกนเจอบนพีซีแคชเชียร์ (อัปเดตทุก 10 วินาที) */
  devices: HubDevice[];
}

/** เครื่องพิมพ์หนึ่งตัวที่ Windows บนพีซีแคชเชียร์มองเห็น */
export interface HubDevice {
  name: string;
  port: string;
  isDefault: boolean;
  isUsb: boolean;
  offline: boolean;
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
  saveHubUsbPrinterAction: SavePrinterAction;
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
    { icon: "🖨️", t1: "เครื่องพิมพ์", t2: "USB / WiFi / BT" },
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

/**
 * งานพิมพ์ที่ Hub เคลมไปแล้วแต่ไม่ได้รายงานผล (สถานะ "รอตรวจสอบ").
 *
 * ระบบไม่พิมพ์ซ้ำให้เองเด็ดขาด เพราะกระดาษอาจออกไปแล้วแต่ ack หายระหว่างทาง —
 * เดาผิดข้างหนึ่งคือใบเสร็จซ้ำ อีกข้างคือใบเสร็จหาย คนที่เห็นกระดาษจริงเท่านั้นที่ตัดสินได้
 * การ์ดนี้จึงมีแค่สองปุ่ม: ยืนยันว่าออกแล้ว หรือสั่งพิมพ์ใหม่
 */
function UnknownJobsCard({ jobs, onResolved }: { jobs: UnknownPrintJob[]; onResolved: () => void }) {
  const [state, formAction, working] = useActionState(resolveUnknownPrintJobAction, { error: null });

  useEffect(() => {
    if (state.done) onResolved();
  }, [state.done, onResolved]);

  if (jobs.length === 0) return null;

  return (
    <div className="mt-3 rounded-[var(--radius-md)] border border-amber-300 bg-amber-50 p-3">
      <p className="text-sm font-semibold text-amber-900">
        ⚠️ งานพิมพ์ที่ต้องตรวจสอบ ({jobs.length})
      </p>
      <p className="mt-1 text-[11px] text-amber-800">
        Hub รับงานไปแล้วแต่ไม่ได้รายงานผลกลับ (เน็ตหลุด/เครื่องดับ) — ดูที่เครื่องพิมพ์ว่ากระดาษออกหรือยัง
        แล้วเลือกให้ระบบ ระบบจะไม่พิมพ์ซ้ำเองเพื่อไม่ให้ได้ใบซ้ำ
      </p>
      <ul className="mt-2 space-y-2">
        {jobs.map((job) => (
          <li
            key={job.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-md)] border border-amber-200 bg-[var(--surface)] px-3 py-2"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-[var(--ink)]">
                {job.jobKind === "station_ticket" ? "ตั๋วครัว" : job.jobKind === "receipt" ? "ใบเสร็จ" : "งานพิมพ์"}
              </p>
              <p className="text-[11px] text-[var(--muted)]">
                ส่งเมื่อ {new Date(job.createdAt).toLocaleString("th-TH")} · พยายามแล้ว {job.attempts} ครั้ง
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              <form action={formAction}>
                <input type="hidden" name="jobId" value={job.id} />
                <input type="hidden" name="resolution" value="printed_confirmed" />
                <button type="submit" disabled={working} className="btn-secondary min-h-9 px-3 text-xs disabled:opacity-40">
                  ออกแล้ว
                </button>
              </form>
              <form action={formAction}>
                <input type="hidden" name="jobId" value={job.id} />
                <input type="hidden" name="resolution" value="retried" />
                <button type="submit" disabled={working} className="btn-primary min-h-9 px-3 text-xs disabled:opacity-40">
                  พิมพ์ใหม่
                </button>
              </form>
            </div>
          </li>
        ))}
      </ul>
      {state.error && (
        <p className="mt-2 rounded-[var(--radius-md)] border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {state.error}
        </p>
      )}
    </div>
  );
}

/**
 * ระดับที่ร้านยอมให้ Hub เลือกเครื่องพิมพ์เอง + ปุ่ม "ลืมเครื่องนี้"
 *
 * ร้านเครื่องเดียวอยากให้เสียบแล้วใช้ได้เลย ส่วนร้านที่มีเครื่องพิมพ์หลายตัว (ใบเสร็จ + ฉลาก)
 * การเดาผิดหมายถึงใบเสร็จออกผิดเครื่องโดยไม่มีใครรู้ จึงต้องเลือกได้ว่าจะให้เดาแค่ไหน
 *
 * ทุกข้อความในนี้พูดถึง "ค่าเริ่มต้นของ StoreOS" เท่านั้น — ระบบไม่อ่านและไม่แก้
 * เครื่องพิมพ์เริ่มต้นของ Windows
 */
function UsbBindingPolicyCard({ printer }: { printer: Printer }) {
  const [policyState, policyAction, savingPolicy] = useActionState(setUsbBindingPolicyAction, { error: null });
  const [forgetState, forgetAction, forgetting] = useActionState(forgetUsbBindingAction, { error: null });
  const current = printer.hubUsbBindingPolicy ?? "auto_single";

  return (
    <div className="mb-3 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-3">
      <p className="text-sm font-semibold text-[var(--ink)]">ค่าเริ่มต้นของ StoreOS สำหรับเครื่องพิมพ์ USB</p>
      <p className="mt-1 text-[11px] text-[var(--muted)]">
        ใช้เฉพาะภายใน StoreOS — ไม่แก้เครื่องพิมพ์เริ่มต้นของ Windows และไม่ส่งงานไปออกเครื่องเอกสาร A4
      </p>

      <form action={policyAction} className="mt-2 space-y-2">
        <input type="hidden" name="printerId" value={printer.id} />
        {HUB_USB_BINDING_POLICIES.map((option) => (
          <label
            key={option.value}
            className="flex cursor-pointer items-start gap-2 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2"
          >
            <input
              type="radio"
              name="policy"
              value={option.value}
              defaultChecked={current === option.value}
              className="mt-1"
            />
            <span>
              <span className="block text-xs font-semibold text-[var(--ink)]">{option.label}</span>
              <span className="block text-[11px] text-[var(--muted)]">{option.hint}</span>
            </span>
          </label>
        ))}
        <button type="submit" disabled={savingPolicy} className="btn-secondary min-h-9 px-3 text-xs disabled:opacity-40">
          {savingPolicy ? "กำลังบันทึก..." : "บันทึกระดับการเลือกอัตโนมัติ"}
        </button>
      </form>

      {(printer.hubUsbName || printer.hubUsbIdentityQueueName) && (
        <form action={forgetAction} className="mt-3 border-t border-[var(--border)] pt-2">
          <input type="hidden" name="printerId" value={printer.id} />
          <p className="text-[11px] text-[var(--muted)]">
            ระบบจำเครื่องนี้ไว้: <b>{printer.hubUsbIdentityQueueName ?? printer.hubUsbName}</b>
          </p>
          <button type="submit" disabled={forgetting} className="btn-secondary mt-1 min-h-9 px-3 text-xs disabled:opacity-40">
            {forgetting ? "กำลังล้าง..." : "ลืมเครื่องนี้ (เปลี่ยนเครื่องพิมพ์ใหม่)"}
          </button>
        </form>
      )}

      {(policyState.error || forgetState.error) && (
        <p className="mt-2 rounded-[var(--radius-md)] border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {policyState.error ?? forgetState.error}
        </p>
      )}
    </div>
  );
}

/**
 * เครื่องพิมพ์ USB ที่เสียบกับพีซีแคชเชียร์.
 *
 * Hub agent สแกนเครื่องพิมพ์ที่ Windows มองเห็นแล้วรายงานกลับมาทุกรอบ poll (~2.5 วินาที)
 * ร้านจึงแค่เสียบสาย USB → ชื่อเครื่องพิมพ์โผล่ที่นี่ → กด "ใช้เครื่องนี้" จบ ไม่ต้องตั้งค่า
 * WiFi ของเครื่องพิมพ์ และไม่ต้องพิมพ์ชื่อ/พอร์ตเอง.
 *
 * โหมด "ตรวจจับอัตโนมัติ" ไม่ผูกชื่อเครื่องพิมพ์ไว้เลย — ย้ายพอร์ต USB, เปลี่ยนสาย หรือ
 * เปลี่ยนเครื่องพิมพ์รุ่นใหม่ ก็ยังพิมพ์ได้โดยไม่ต้องกลับมาแก้ค่าอีก.
 */
function DetectedUsbPrinters({
  devices,
  hubOnline,
  paperWidth,
  existingPrinter,
  saveAction,
  onRefresh,
}: {
  devices: HubDevice[];
  hubOnline: boolean;
  paperWidth: "58mm" | "80mm";
  existingPrinter: Printer | null;
  saveAction: SavePrinterAction;
  onRefresh: () => void;
}) {
  const [state, formAction, saving] = useActionState(saveAction, { error: null });
  // USB ขึ้นก่อนเสมอ — เป็นสิ่งที่ผู้ใช้กำลังมองหา ส่วนที่เหลือเป็นตัวเลือกสำรอง
  const sorted = [...devices].sort((a, b) => Number(b.isUsb) - Number(a.isUsb));
  const usbCount = devices.filter((d) => d.isUsb).length;

  return (
    <div className="mb-4 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-muted)] p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-[var(--ink)]">
          🔌 เครื่องพิมพ์ USB ที่เสียบกับเครื่องแคชเชียร์
        </p>
        <button type="button" onClick={onRefresh} className="btn-secondary min-h-9 px-2 text-[11px]">
          สแกนใหม่
        </button>
      </div>

      {existingPrinter && <UsbBindingPolicyCard printer={existingPrinter} />}

      {existingPrinter && (
        <p className="mb-2 rounded-[var(--radius-md)] border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
          ใช้อยู่: <b>{existingPrinter.name}</b>{" "}
          {existingPrinter.hubUsbName
            ? `(ผูกกับ "${existingPrinter.hubUsbName}")`
            : "(ตรวจจับอัตโนมัติ — ย้ายพอร์ต USB ได้โดยไม่ต้องตั้งค่าใหม่)"}
        </p>
      )}

      {!hubOnline ? (
        <p className="rounded-[var(--radius-md)] border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Hub ยังออฟไลน์ — ติดตั้ง Print Hub บนเครื่องแคชเชียร์ในขั้นตอนที่ 1 ก่อน แล้วรายชื่อเครื่องพิมพ์จะขึ้นเองภายในไม่กี่วินาที
        </p>
      ) : devices.length === 0 ? (
        <p className="rounded-[var(--radius-md)] border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          ยังไม่พบเครื่องพิมพ์บนเครื่องแคชเชียร์ — เสียบสาย USB แล้วรอ Windows ติดตั้งไดรเวอร์สักครู่ จากนั้นกด “สแกนใหม่”
        </p>
      ) : (
        <>
          {usbCount === 0 && (
            <p className="mb-2 rounded-[var(--radius-md)] border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              ยังไม่พบเครื่องพิมพ์ที่ต่อผ่าน USB — ตรวจสายและรอ Windows ติดตั้งไดรเวอร์ (รายการด้านล่างเป็นเครื่องพิมพ์อื่นบนพีซีเครื่องนั้น)
            </p>
          )}
          <ul className="space-y-2">
            {sorted.map((device) => (
              <li
                key={`${device.name}|${device.port}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-[var(--ink)]">{device.name}</p>
                  <p className="text-[11px] text-[var(--muted)]">
                    พอร์ต {device.port || "ไม่ทราบ"}
                    {device.isUsb ? " · USB" : ""}
                    {device.isDefault ? " · ค่าเริ่มต้นของ Windows" : ""}
                    {device.offline ? " · ปิดอยู่/ออฟไลน์" : ""}
                  </p>
                </div>
                <form action={formAction} className="shrink-0">
                  <input type="hidden" name="printerId" value={existingPrinter?.id ?? ""} />
                  <input type="hidden" name="name" value={device.name} />
                  <input type="hidden" name="windowsPrinterName" value={device.name} />
                  <input type="hidden" name="paperWidth" value={paperWidth} />
                  <button
                    type="submit"
                    disabled={saving}
                    className="btn-secondary min-h-9 px-3 text-xs disabled:opacity-40"
                  >
                    ใช้เครื่องนี้
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </>
      )}

      <form action={formAction} className="mt-3">
        <input type="hidden" name="printerId" value={existingPrinter?.id ?? ""} />
        <input type="hidden" name="name" value="เครื่องพิมพ์ USB (ตรวจจับอัตโนมัติ)" />
        <input type="hidden" name="windowsPrinterName" value="" />
        <input type="hidden" name="paperWidth" value={paperWidth} />
        <button type="submit" disabled={saving} className="btn-primary min-h-11 px-4 text-sm font-semibold disabled:opacity-40">
          {saving ? "กำลังบันทึก..." : "ใช้โหมดตรวจจับอัตโนมัติ (แนะนำ)"}
        </button>
        <p className="mt-1 text-[11px] text-[var(--muted)]">
          ไม่ผูกชื่อเครื่องพิมพ์ไว้ — Hub จะเลือกเครื่องพิมพ์ USB ที่เสียบอยู่ให้เองทุกครั้งที่พิมพ์
        </p>
      </form>

      {state.error && (
        <p className="mt-2 rounded-[var(--radius-md)] border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {state.error}
        </p>
      )}
      {state.saved && !state.error && (
        <p className="mt-2 rounded-[var(--radius-md)] border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
          บันทึกเครื่องพิมพ์ USB แล้ว — ทดสอบพิมพ์ได้ในขั้นตอนที่ 3
        </p>
      )}
    </div>
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
  saveHubUsbPrinterAction,
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
    (p) =>
      ((p.type === "ip" || p.type === "escpos") && p.ipAddress) ||
      (p.type === "bluetooth" && p.hubBluetoothPort) ||
      (p.type === "usb" && p.hubUsbEnabled),
  );
  const usbHubPrinter = printers.find((p) => p.type === "usb" && p.hubUsbEnabled) ?? null;

  const refreshStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/print/hub/status", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as {
        online?: boolean;
        secondsAgo?: number | null;
        pendingJobs?: number;
        claimedJobs?: number;
        unknownJobs?: number;
        failedJobs?: number;
        unknownJobList?: UnknownPrintJob[];
        devices?: HubDevice[];
      };
      setStatus({
        online: Boolean(data.online),
        secondsAgo: data.secondsAgo ?? null,
        pendingJobs: data.pendingJobs ?? 0,
        claimedJobs: data.claimedJobs ?? 0,
        unknownJobs: data.unknownJobs ?? 0,
        failedJobs: data.failedJobs ?? 0,
        unknownJobList: Array.isArray(data.unknownJobList) ? data.unknownJobList : [],
        devices: Array.isArray(data.devices) ? data.devices : [],
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
            <p className="text-sm font-semibold text-[var(--ink)]">
              {status.pendingJobs} งาน
              {status.claimedJobs > 0 ? ` · กำลังพิมพ์ ${status.claimedJobs}` : ""}
            </p>
          </div>
        </div>

        <UnknownJobsCard jobs={status.unknownJobList} onResolved={refreshStatus} />

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

      {/* Step 2 — add a printer (USB, WiFi or Bluetooth, unified) */}
      <StepCard index={2} title="เพิ่มเครื่องพิมพ์ (USB, WiFi หรือ Bluetooth)" done={hasPrinter}>
        <p className="label-muted mb-2">
          เพิ่มเครื่องพิมพ์ที่อยู่ในร้าน — เลือกได้ทั้งแบบ <b>USB ต่อตรงกับเครื่องแคชเชียร์</b>, <b>IP / WiFi</b> หรือ{" "}
          <b>Bluetooth ผ่าน Hub</b>
        </p>
        <DetectedUsbPrinters
          devices={status.devices}
          hubOnline={status.online}
          paperWidth={paperWidth}
          existingPrinter={usbHubPrinter}
          saveAction={saveHubUsbPrinterAction}
          onRefresh={refreshStatus}
        />
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
