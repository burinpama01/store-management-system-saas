"use client";

import { bytesToBase64 } from "./print-job-base64";
import { buildReceiptPrinterBytes } from "./receipt-printer-bytes";
import type { StationTicketJob } from "./station-routing";

export interface StationPrintResult {
  printed: number;
  failed: Array<{ stationName: string; error: string }>;
}

/**
 * Renders each station ticket to raster bytes in the browser and enqueues it to
 * that station's network printer via the Print Hub (`/api/print/enqueue`). The
 * Hub agent on the LAN claims the job and prints it, so multiple stations
 * (bar, hot kitchen, …) print to their own printers in parallel.
 */
export async function enqueueStationTickets(jobs: StationTicketJob[]): Promise<StationPrintResult> {
  const result: StationPrintResult = { printed: 0, failed: [] };
  for (const job of jobs) {
    try {
      const printJobBase64 = bytesToBase64(await buildReceiptPrinterBytes(job.receipt, job.receipt));
      const res = await fetch("/api/print/enqueue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ printerId: job.printerId, printJobBase64 }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        result.failed.push({ stationName: job.stationName, error: body.error ?? `HTTP ${res.status}` });
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
