// PR3-Live (diagnostics) — ตัวส่ง telemetry ฝั่งเบราว์เซอร์ของโหมดเสียงสด
//
// หน้าที่: รับ event จาก core/WebRTC/ปุ่มคำปลุก → เก็บลง buffer ในเครื่อง (ดูได้จาก DevTools)
// → ส่งขึ้น server เป็นชุด (batch) แบบ best-effort
//
// กฎที่ล็กไว้:
//   - **ห้ามทำให้ AI Live/POS พัง**: ทุกความล้มเหลวถูกกลืนที่นี่ ไม่มี throw ออกไปหาผู้เรียก
//   - ไม่มี transcript/เสียง/token ในทุก event (ฟิลด์ต้องห้ามถูกปฏิเสธที่ route อีกชั้น)
//   - UI ห้ามเรียก fetch เองกระจัดกระจาย — ทุก event เดินผ่าน emit() ตัวนี้
//   - buffer อยู่ในหน่วยความจำของแท็บเท่านั้น (ไม่มี localStorage ค้างข้ามวัน)
//   - server เป็นคนเติม org/store/user เสมอ ที่นี่ไม่เคยส่ง identity ใด ๆ ขึ้นไป

import {
  LIVE_TELEMETRY_LIMITS,
  type LiveTelemetryEventName,
  type LiveTelemetryResult,
  type LiveTelemetryStage,
} from "../live-telemetry-events";

export interface LiveTelemetryEvent {
  readonly event: LiveTelemetryEventName;
  readonly stage: LiveTelemetryStage;
  readonly result: LiveTelemetryResult;
  readonly sessionId?: string;
  readonly callId?: string;
  readonly reason?: string;
  readonly durationMs?: number;
  readonly cartVersion?: number;
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>;
}

/** event ที่ถูกจดไว้ในเครื่อง — เติมเวลาไว้ให้อ่าน timeline ได้ตรง ๆ */
export interface BufferedLiveTelemetryEvent extends LiveTelemetryEvent {
  readonly at: string;
}

export interface LiveTelemetry {
  readonly emit: (event: LiveTelemetryEvent) => void;
  /** ส่งของที่ค้างทันที (ใช้ตอนปิดแท็บ) */
  readonly flush: () => void;
  /** สำเนา buffer ล่าสุด — สำหรับเทสต์และหน้า DevTools */
  readonly recent: () => readonly BufferedLiveTelemetryEvent[];
}

export interface LiveTelemetryOptions {
  /** ปิดอยู่ = จด buffer ในเครื่องอย่างเดียว ไม่ส่งขึ้น server (ค่าเริ่มต้นตาม flag ของร้าน) */
  readonly enabled: boolean;
  readonly endpoint?: string;
  readonly send?: (body: string) => void;
  readonly now?: () => number;
  /** ส่งเป็นชุดทุกกี่มิลลิวินาที — 0 = ส่งทันทีทุก event (ใช้ในเทสต์) */
  readonly flushIntervalMs?: number;
  readonly bufferSize?: number;
}

const DEFAULT_ENDPOINT = "/api/ai-assistant/live/telemetry";
const DEFAULT_FLUSH_INTERVAL_MS = 2_000;

/** ชื่อ global ที่เปิด DevTools แล้วพิมพ์ดู timeline ได้ทันทีหน้าร้าน */
export const LIVE_DIAGNOSTICS_GLOBAL = "StoreOSAIDiagnostics";

function defaultSend(endpoint: string, body: string): void {
  try {
    // keepalive: ของที่ค้างตอนปิดแท็บยังถูกส่ง (เหมือนเส้นทางปิดเซสชัน)
    void fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // telemetry ล้มเหลวต้องไม่กระทบอะไรเลย
  }
}

export function createLiveTelemetry(options: LiveTelemetryOptions): LiveTelemetry {
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const now = options.now ?? (() => Date.now());
  const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const bufferSize = Math.max(1, options.bufferSize ?? LIVE_TELEMETRY_LIMITS.clientBufferSize);
  const send = options.send ?? ((body: string) => defaultSend(endpoint, body));

  let buffer: BufferedLiveTelemetryEvent[] = [];
  let pending: LiveTelemetryEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  function flush(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending.length === 0) return;
    const events = pending.slice(0, LIVE_TELEMETRY_LIMITS.maxEventsPerRequest);
    pending = pending.slice(events.length);
    if (!options.enabled) return;
    try {
      send(JSON.stringify({ events }));
    } catch {
      // ส่งไม่ได้ = ข้อมูลยังอยู่ใน buffer ในเครื่องให้เปิดดูเองได้
    }
    if (pending.length > 0) schedule();
  }

  function schedule(): void {
    if (timer !== null) return;
    if (flushIntervalMs <= 0) {
      flush();
      return;
    }
    timer = setTimeout(flush, flushIntervalMs);
  }

  return {
    emit(event: LiveTelemetryEvent): void {
      try {
        const entry: BufferedLiveTelemetryEvent = { ...event, at: new Date(now()).toISOString() };
        buffer = [...buffer, entry].slice(-bufferSize);
        if (typeof window !== "undefined") {
          (window as unknown as Record<string, unknown>)[LIVE_DIAGNOSTICS_GLOBAL] = buffer;
        }
        pending = [...pending, event].slice(-bufferSize);
        schedule();
      } catch {
        // telemetry ต้องไม่ทำให้เส้นทางหลักพังไม่ว่ากรณีใด
      }
    },
    flush,
    recent: () => buffer,
  };
}

/** ตัวเปล่า — ใช้เมื่อยังไม่มี telemetry ฉีดเข้ามา (โค้ดเรียก emit ได้เสมอโดยไม่ต้องเช็ค null) */
export const noopLiveTelemetry: LiveTelemetry = {
  emit: () => {},
  flush: () => {},
  recent: () => [],
};

// ── ตัวกลางของทั้งหน้า (ปุ่มคำปลุกกับแผงผู้ช่วยอยู่คนละต้นไม้ component) ──────────────
//
// ใช้รูปแบบเดียวกับ mic-ownership/wake-routing: แผงผู้ช่วยเป็นคนตั้งค่า (เพราะรู้ว่าร้านนี้
// เปิดโหมดวินิจฉัยไหม) ส่วนที่อื่นเรียก emitLiveTelemetry() ได้เลยโดยไม่ต้องรู้จักกัน
// ยังไม่ถูกตั้งค่า = noop (ไม่มี event ไหนทำให้เส้นทางหลักพัง)

let shared: LiveTelemetry = noopLiveTelemetry;

export function setSharedLiveTelemetry(telemetry: LiveTelemetry): () => void {
  shared = telemetry;
  return () => {
    if (shared === telemetry) shared = noopLiveTelemetry;
  };
}

export function emitLiveTelemetry(event: LiveTelemetryEvent): void {
  shared.emit(event);
}

export function readSharedLiveTelemetry(): LiveTelemetry {
  return shared;
}
