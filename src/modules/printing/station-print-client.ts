"use client";

import { bytesToBase64 } from "./print-job-base64";
import { buildReceiptPrinterBytes } from "./receipt-printer-bytes";
import {
  buildStationTicketJobs,
  type StationRoutingItem,
  type StationRoutingStation,
  type StationTicketJob,
} from "./station-routing";

export interface StationPrintResult {
  printed: number;
  /** ตั๋วที่จอ/ช่องทางอื่นส่งเข้าคิวไปแล้ว (server คืน job เดิม) — ไม่นับเป็นงานใหม่ */
  deduped: number;
  failed: Array<{ stationName: string; error: string }>;
}

/**
 * Renders each station ticket to raster bytes in the browser and enqueues it to
 * that station's network printer via the Print Hub (`/api/print/enqueue`). The
 * Hub agent on the LAN claims the job and prints it, so multiple stations
 * (bar, hot kitchen, …) print to their own printers in parallel.
 *
 * ตั๋วที่มี sourceKey (ออเดอร์+สถานี) ถูก dedupe ฝั่ง server — เปิดกี่จอก็ออกใบเดียว
 */
export async function enqueueStationTickets(jobs: StationTicketJob[]): Promise<StationPrintResult> {
  const result: StationPrintResult = { printed: 0, deduped: 0, failed: [] };
  for (const job of jobs) {
    try {
      const printJobBase64 = bytesToBase64(await buildReceiptPrinterBytes(job.receipt, job.receipt));
      const res = await fetch("/api/print/enqueue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ printerId: job.printerId, printJobBase64, sourceKey: job.sourceKey }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; deduped?: boolean };
      if (!res.ok) {
        result.failed.push({ stationName: job.stationName, error: body.error ?? `HTTP ${res.status}` });
      } else if (body.deduped) {
        result.deduped += 1;
      } else {
        result.printed += 1;
      }
    } catch (e) {
      result.failed.push({
        stationName: job.stationName,
        error: e instanceof Error ? e.message : "พิมพ์ตั๋วไม่สำเร็จ",
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

/** ข้อความสั้นสำหรับแถบสถานะ — deduped อย่างเดียว = จออื่นพิมพ์ไปแล้ว */
export function describeStationPrintResult(res: StationPrintResult): string {
  if (res.failed.length > 0) {
    return `พิมพ์ตั๋ว ${res.printed + res.deduped} สำเร็จ, ล้มเหลว ${res.failed.length} (${res.failed
      .map((f) => f.stationName)
      .join(", ")})`;
  }
  if (res.printed === 0 && res.deduped > 0) return "ตั๋วครัวถูกส่งจากอีกจอแล้ว";
  return `พิมพ์ตั๋วครัว ${res.printed + res.deduped} สถานีแล้ว`;
}
