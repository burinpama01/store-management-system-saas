"use client";

import { bytesToBase64 } from "./print-job-base64";
import { buildReceiptPrinterBytes } from "./receipt-printer-bytes";
import { isDirectPrintAvailable, printDirect } from "./launcher-direct-print";
import {
  buildStationTicketJobs,
  type StationRoutingItem,
  type StationRoutingStation,
  type StationTicketJob,
} from "./station-routing";

export interface StationPrintResult {
  /** ส่งเข้าคิวใหม่ (รวมงานเดิมที่ failed แล้วถูกส่งกลับเข้าคิว) — ยังไม่ใช่ "พิมพ์ออกแล้ว" */
  queued: number;
  /** จอ/ช่องทางอื่นส่งไปแล้ว และงานนั้นรอพิมพ์/กำลังพิมพ์/พิมพ์แล้ว */
  alreadyQueued: number;
  /** งานเดิมสถานะ unknown — ไม่รู้ว่าออกไหม ไม่ส่งซ้ำให้อัตโนมัติ ต้องตรวจที่เครื่อง */
  uncertain: Array<{ stationName: string }>;
  failed: Array<{ stationName: string; error: string }>;
}

interface EnqueueResponseBody {
  error?: string;
  jobStatus?: "pending" | "claimed" | "printed" | "failed" | "unknown";
  deduped?: boolean;
  requeued?: boolean;
  skipped?: string;
}

/**
 * Renders each station ticket to raster bytes in the browser and enqueues it to
 * that station's network printer via the Print Hub (`/api/print/enqueue`). The
 * Hub agent on the LAN claims the job and prints it, so multiple stations
 * (bar, hot kitchen, …) print to their own printers in parallel.
 *
 * ตั๋วที่มี sourceKey (ออเดอร์+สถานี) ถูก dedupe ฝั่ง server — เปิดกี่จอก็ออกใบเดียว
 * และ server เลือกเครื่องพิมพ์ของสถานีเอง (printerId ที่ส่งไปเป็นแค่ค่าอ้างอิง)
 */
interface DirectClaimBody {
  mode?: "hub" | "direct";
  claim?: "mine" | "taken" | "skip";
  status?: string;
  printer?: { id: string; host: string; port: number };
  error?: string;
}

/**
 * เฟส D3 — ร้านโหมดพิมพ์ตรง + เปิดในโปรแกรม StoreOS POS: จองตั๋วที่ server (กันซ้ำข้ามจอ) แล้วยิงตรงเข้า
 * เครื่องพิมพ์ของสถานี คืน null = ร้านยังโหมด hub (ให้ไปทางคิวเดิม)
 */
async function printStationTicketDirect(
  job: StationTicketJob,
  printJobBase64: string,
  result: StationPrintResult,
): Promise<"done" | "hub"> {
  const claimRes = await fetch("/api/print/direct-claim", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sourceKey: job.sourceKey }),
  });
  const claim = (await claimRes.json().catch(() => ({}))) as DirectClaimBody;
  if (claimRes.ok && claim.mode === "hub") return "hub";
  if (!claimRes.ok) {
    result.failed.push({ stationName: job.stationName, error: claim.error ?? `HTTP ${claimRes.status}` });
    return "done";
  }
  if (claim.claim === "skip") return "done";
  if (claim.claim === "taken") {
    if (claim.status === "unknown") result.uncertain.push({ stationName: job.stationName });
    else result.alreadyQueued += 1;
    return "done";
  }
  if (claim.claim !== "mine" || !claim.printer) {
    result.failed.push({ stationName: job.stationName, error: "จองตั๋วครัวไม่สำเร็จ" });
    return "done";
  }
  const printed = await printDirect({
    printerId: claim.printer.id,
    host: claim.printer.host,
    port: claim.printer.port,
    bytesBase64: printJobBase64,
    kind: "kitchen",
    label: `${job.stationName} ${job.receipt.orderNumber ?? ""}`.trim(),
  });
  // รายงานผลให้ server — failed = ปล่อยการจองให้ลองใหม่ได้ / printed, unknown = กันพิมพ์ซ้ำ
  await fetch("/api/print/direct-result", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sourceKey: job.sourceKey, outcome: printed.outcome, error: printed.error }),
  }).catch(() => undefined);
  if (printed.outcome === "printed") result.queued += 1;
  else if (printed.outcome === "unknown") result.uncertain.push({ stationName: job.stationName });
  else result.failed.push({ stationName: job.stationName, error: printed.error ?? "พิมพ์ไม่สำเร็จ" });
  return "done";
}

export async function enqueueStationTickets(jobs: StationTicketJob[]): Promise<StationPrintResult> {
  const result: StationPrintResult = { queued: 0, alreadyQueued: 0, uncertain: [], failed: [] };
  const direct = await isDirectPrintAvailable();
  for (const job of jobs) {
    try {
      const printJobBase64 = bytesToBase64(await buildReceiptPrinterBytes(job.receipt, job.receipt));
      if (direct && job.sourceKey && (await printStationTicketDirect(job, printJobBase64, result)) === "done") continue;
      const res = await fetch("/api/print/enqueue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ printerId: job.printerId, printJobBase64, sourceKey: job.sourceKey }),
      });
      const body = (await res.json().catch(() => ({}))) as EnqueueResponseBody;
      if (!res.ok) {
        result.failed.push({ stationName: job.stationName, error: body.error ?? `HTTP ${res.status}` });
      } else if (body.deduped && body.jobStatus === "unknown") {
        result.uncertain.push({ stationName: job.stationName });
      } else if (body.deduped) {
        result.alreadyQueued += 1;
      } else {
        result.queued += 1;
      }
    } catch (e) {
      result.failed.push({
        stationName: job.stationName,
        error: e instanceof Error ? e.message : "ส่งตั๋วครัวไม่สำเร็จ",
      });
    }
  }
  return result;
}

export interface DispatchOrderStationTicketsInput {
  orderId: string;
  orderNumber: string;
  tableNumber?: string;
  paperWidth: "58mm" | "80mm";
  items: StationRoutingItem[];
  stations: StationRoutingStation[];
}

/**
 * แตกออเดอร์ 1 รอบเป็นตั๋วต่อสถานีแล้วส่งเข้า Hub — ใช้ร่วมกันทุกช่องทาง
 * (QR เข้า, POS จ่ายทันที, POS ส่งเข้าครัว) คีย์ผูก orderId จึงไม่ซ้ำแม้หลายจอยิงพร้อมกัน
 * คืน null เมื่อไม่มีตั๋วให้พิมพ์ (ไม่มีสถานีที่ผูกเครื่องพิมพ์)
 */
export async function dispatchOrderStationTickets(
  input: DispatchOrderStationTicketsInput,
): Promise<(StationPrintResult & { unroutedItemCount: number }) | null> {
  const { jobs, unroutedItemCount } = buildStationTicketJobs({
    orderId: input.orderId,
    orderNumber: input.orderNumber,
    tableNumber: input.tableNumber,
    paperWidth: input.paperWidth,
    printedAt: new Date().toISOString(),
    items: input.items,
    stations: input.stations,
  });
  if (jobs.length === 0) return null;
  const res = await enqueueStationTickets(jobs);
  return { ...res, unroutedItemCount };
}

/** ข้อความสั้นสำหรับแถบสถานะ — บอกตามจริง: ส่งเข้าคิว ≠ พิมพ์ออก, unknown/ล้มเหลว ต้องแจ้ง */
export function describeStationPrintResult(res: StationPrintResult): string {
  const parts: string[] = [];
  if (res.queued > 0) parts.push(`ส่งตั๋วครัวเข้าคิว ${res.queued} สถานี`);
  if (res.alreadyQueued > 0) {
    parts.push(res.queued > 0 ? `อีก ${res.alreadyQueued} สถานีจออื่นส่งแล้ว` : "ตั๋วครัวถูกส่งจากอีกจอแล้ว");
  }
  if (res.uncertain.length > 0) {
    parts.push(
      `ตั๋ว ${res.uncertain.map((u) => u.stationName).join(", ")} สถานะไม่แน่ชัด — ตรวจที่เครื่องพิมพ์/แถบคิวพิมพ์`,
    );
  }
  if (res.failed.length > 0) {
    parts.push(`ส่งตั๋วไม่สำเร็จ ${res.failed.length} สถานี (${res.failed.map((f) => f.stationName).join(", ")})`);
  }
  return parts.join(" · ");
}

/** ต้องให้พนักงานเห็นไหม (ล้มเหลว/ไม่แน่ชัด) — เส้นทางที่ไม่อยากรบกวนตอนสำเร็จใช้ตัวนี้ */
export function stationPrintNeedsAttention(res: StationPrintResult): boolean {
  return res.failed.length > 0 || res.uncertain.length > 0;
}
