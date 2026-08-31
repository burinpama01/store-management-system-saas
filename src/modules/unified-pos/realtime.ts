/**
 * Unified POS — Realtime typed event contract + client tracker (Task U3)
 *
 * Source of truth ของ envelope/parser/tracker ที่ R2 client integration ต้องใช้
 * แผนอ้างอิง: Plan/QR Order Voice Unified POS Implementation Plan v2.html
 *   - Task "U3 · Realtime publication + typed event contract + client tracker" (version 0.35.3)
 *
 * กฎเหล็กของไฟล์นี้:
 *   - ห้าม import @supabase/supabase-js — ทุกอย่างรับผ่าน interface/unknown payload ล้วน
 *     (wiring กับ channel จริงเป็นหน้าที่ผู้เรียก — R2 client integration)
 *   - envelope ระบุเฉพาะ 7 field ด้านล่าง — ห้าม leak field อื่นจาก record
 *     (เช่น ราคา/unit_price, โน้ต/note, คอลัมน์เชิงธุรกิจอื่น)
 *   - ใช้ enum ของ U1 contracts (FULFILLMENT_STATUSES) — ห้ามมี 'voided' ใน
 *     fulfillmentStatus เพราะ canonical void คือ field `voided` (boolean)
 *
 * ข้อจำกัดจาก schema จริง (ตรวจ ณ commit 92151bb):
 *   - order_items ไม่มีคอลัมน์ store_id → storeId มาจาก context ที่ผู้เรียกระบุ
 *     (ผู้เรียกคือผู้รู้ว่าตัวเองฟังร้านไหน — สอดคล้องกับ RLS ที่ scope ผ่าน orders.store_id)
 *   - fulfillment_version เป็น bigint → ผ่าน realtime อาจมาเป็น number หรือ string
 *     parser รับทั้งสองแบบและ normalize เป็น number เสมอ
 */

import { FULFILLMENT_STATUSES, type FulfillmentStatus } from "./contracts";

/** ประเภท event ที่ Realtime postgres_changes ส่งมาได้ (เท่านั้น — "*" ใช้ตอน subscribe ไม่ใช่ตอน deliver) */
export type UnifiedPosItemEventType = "INSERT" | "UPDATE" | "DELETE";

/**
 * Envelope ของ order_item event — 7 field นี้เท่านั้น (no-leak contract)
 * แผน: U3 — "typed event contract" ที่ KDS/R2 client ใช้ตัดสินใจต่อโดยไม่ต้องรู้ row เต็ม
 */
export interface UnifiedPosItemEvent {
  /** ร้านของ event (มาจาก context ของผู้เรียก — order_items ไม่มีคอลัมน์ store_id) */
  storeId: string;
  orderId: string;
  itemId: string;
  /** version เดิมของ DB (bigint) — ผ่าน trigger U2 เดินหน้าเสมอ ใช้ dedupe ต่อ item */
  fulfillmentVersion: number;
  /** สถานะ fulfillment ของ row — ตอน DELETE อ่านจาก old record */
  fulfillmentStatus: FulfillmentStatus;
  /** canonical void (U1: voided boolean ชนะ fulfillment status เสมอ) */
  voided: boolean;
  eventType: UnifiedPosItemEventType;
}

/** ชุด key ของ envelope — ใช้ assert ว่า parser ไม่ leak field อื่น */
export const UNIFIED_POS_ITEM_EVENT_FIELDS = Object.freeze([
  "storeId",
  "orderId",
  "itemId",
  "fulfillmentVersion",
  "fulfillmentStatus",
  "voided",
  "eventType",
] as const);

/** Context เพิ่มเติมของผู้เรียกตอน parse (order_items ไม่มีคอลัมน์ store_id จึงต้องรับจากผู้เรียก) */
export interface UnifiedPosRealtimeParseContext {
  /** store ที่ผู้เรียกฟังอยู่ (ต้องเป็น string ที่ไม่ว่าง มิฉะนั้น parse ไม่ผ่าน) */
  storeId?: string;
}

/** ตรวจว่าเป็น plain object (ไม่รับ array/null) */
function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** bigint ผ่าน realtime อาจมาเป็น number หรือ numeric string — normalize เป็น number หรือ null */
function parseFulfillmentVersion(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 1 ? value : null;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
  }
  return null;
}

/** fulfillment_status ต้องอยู่ใน enum ของ U1 contracts เท่านั้น (ห้ามมี 'voided') */
function parseFulfillmentStatus(value: unknown): FulfillmentStatus | null {
  if (typeof value !== "string") return null;
  return (FULFILLMENT_STATUSES as readonly string[]).includes(value) ? (value as FulfillmentStatus) : null;
}

/** string ที่ไม่ว่างเท่านั้น */
function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function parseEventType(value: unknown): UnifiedPosItemEventType | null {
  if (value !== "INSERT" && value !== "UPDATE" && value !== "DELETE") return null;
  return value;
}

/**
 * Parse payload ของ supabase-js RealtimePostgresChangesPayload (shape: eventType + new/old)
 * ให้กลายเป็น UnifiedPosItemEvent — คืน null เมื่อ payload ไม่ครบ/ใช้ไม่ได้
 *
 * กฎ:
 *   - INSERT/UPDATE อ่านจาก `new`, DELETE อ่านจาก `old`
 *     (ต้องมี replica identity full บน order_items จาก migration U3 — DELETE จึงได้ row เต็ม)
 *   - storeId: จาก context.storeId ก่อน, ถ้าไม่มีใช้ record.store_id (เผื่ออนาคต
 *     ถ้าเพิ่มคอลัมน์) — ไม่มีทั้งคู่ = payload ใช้ไม่ได้ → null
 *   - field อื่นทั้งหมดถูกทิ้ง (no-leak envelope)
 */
export function parseOrderItemRealtimePayload(
  payload: unknown,
  context?: UnifiedPosRealtimeParseContext,
): UnifiedPosItemEvent | null {
  if (!isRecordObject(payload)) return null;

  const eventType = parseEventType(payload.eventType);
  if (eventType === null) return null;

  // DELETE ใช้ old record (fulfillment_version/fulfillment_status จาก old), INSERT/UPDATE ใช้ new
  const record = eventType === "DELETE" ? payload.old : payload.new;
  if (!isRecordObject(record)) return null;

  const itemId = nonEmptyString(record.id);
  const orderId = nonEmptyString(record.order_id);
  const fulfillmentVersion = parseFulfillmentVersion(record.fulfillment_version);
  const fulfillmentStatus = parseFulfillmentStatus(record.fulfillment_status);
  if (itemId === null || orderId === null || fulfillmentVersion === null || fulfillmentStatus === null) {
    return null;
  }
  if (typeof record.voided !== "boolean") return null;

  const storeId =
    nonEmptyString(context?.storeId) ??
    nonEmptyString(record.store_id); // เผื่อ schema อนาคตเพิ่ม store_id บน order_items
  if (storeId === null) return null;

  // สร้าง envelope ใหม่ทั้งหมด — ไม่ spread record เพื่อกัน leak field อื่น
  return {
    storeId,
    orderId,
    itemId,
    fulfillmentVersion,
    fulfillmentStatus,
    voided: record.voided,
    eventType,
  };
}

/** สถานะ connection ที่ tracker รับ (ผู้เรียก map จาก channel status ของ supabase-js เอง) */
export type UnifiedPosConnectionStatus = "SUBSCRIBED" | "DISCONNECTED";

/** Injectable timer เพื่อให้ test ด้วย vi.useFakeTimers / ผู้เรียกคุม lifecycle เอง */
export interface UnifiedPosPollTimer {
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}

const defaultPollTimer: UnifiedPosPollTimer = {
  setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/** pollTick ทุก 5 วินาทีเมื่อสถานะไม่ใช่ SUBSCRIBED (แผน: fallback polling ระหว่างขาด connection) */
export const DEFAULT_POLL_INTERVAL_MS = 5000;

export interface UnifiedPosItemTrackerOptions {
  /** เรียกเมื่อ event ใหม่ (version > seen) ผ่าน dedupe — event stale/duplicate จะไม่มาถึงนี่ */
  onItemEvent?: (event: UnifiedPosItemEvent) => void;
  /** เรียกครั้งเดียวต่อการ reconnect (DISCONNECTED → SUBSCRIBED) — ผู้เรียกต้อง refetch snapshot */
  onSnapshotRefetchRequired?: () => void;
  /** เรียกทุก pollIntervalMs เมื่อสถานะไม่ใช่ SUBSCRIBED */
  onPollTick?: () => void;
  /** interval ของ pollTick (default 5000ms) */
  pollIntervalMs?: number;
  /** timer แบบ injectable (default: global setInterval/clearInterval) */
  timer?: UnifiedPosPollTimer;
}

export interface UnifiedPosItemTracker {
  /**
   * รับ event ที่ parse แล้ว — คืน true เมื่อ propagate (event ใหม่), false เมื่อทิ้ง
   * กฎ dedupe: version <= seen ของ item นั้น = stale/duplicate → ทิ้ง
   * (item ต่างกันไม่กันกัน — seen เก็บต่อ itemId)
   */
  handleEvent(event: UnifiedPosItemEvent): boolean;
  /** อัปเดตสถานะ connection — reconnect (DISCONNECTED → SUBSCRIBED) จะ emit snapshotRefetchRequired หนึ่งครั้ง */
  setConnectionStatus(status: UnifiedPosConnectionStatus): void;
  /** สถานะล่าสุด (null = ยังไม่เคยรับสถานะ) */
  getConnectionStatus(): UnifiedPosConnectionStatus | null;
  /** ล้าง poll timer + หยุด propagate/status callback ทั้งหมด (เรียกตอน unmount/unsubscribe) */
  dispose(): void;
}

function isValidUnifiedPosItemEvent(event: UnifiedPosItemEvent): boolean {
  return (
    nonEmptyString(event.storeId) !== null &&
    nonEmptyString(event.orderId) !== null &&
    nonEmptyString(event.itemId) !== null &&
    typeof event.fulfillmentVersion === "number" &&
    Number.isSafeInteger(event.fulfillmentVersion) &&
    event.fulfillmentVersion >= 1 &&
    (FULFILLMENT_STATUSES as readonly string[]).includes(event.fulfillmentStatus) &&
    typeof event.voided === "boolean" &&
    (event.eventType === "INSERT" || event.eventType === "UPDATE" || event.eventType === "DELETE")
  );
}

/**
 * Tracker ฝั่ง client — pure ต่อ supabase-js (รับ event ผ่าน interface ล้วน)
 *
 * Lifecycle ที่คาดหวัง:
 *   1) สร้าง tracker → poll เริ่มทันที (สถานะยังไม่ SUBSCRIBED) เพื่อกันข้อมูลค้าง
 *   2) setConnectionStatus("SUBSCRIBED") ครั้งแรก = connect ปกติ → หยุด poll, ไม่ emit snapshot
 *   3) setConnectionStatus("DISCONNECTED") → poll กลับมาทุก pollIntervalMs
 *   4) setConnectionStatus("SUBSCRIBED") หลัง disconnect = reconnect → emit
 *      onSnapshotRefetchRequired หนึ่งครั้ง (ต้อง refetch เพราะอาจพลาด event ระหว่างหลุด)
 */
export function createUnifiedPosItemTracker(
  options: UnifiedPosItemTrackerOptions = {},
): UnifiedPosItemTracker {
  const pollIntervalMs =
    typeof options.pollIntervalMs === "number" && options.pollIntervalMs > 0
      ? options.pollIntervalMs
      : DEFAULT_POLL_INTERVAL_MS;
  const timer = options.timer ?? defaultPollTimer;

  let disposed = false;
  let status: UnifiedPosConnectionStatus | null = null;
  let pollHandle: unknown = null;
  const seenVersions = new Map<string, number>();

  function stopPolling(): void {
    if (pollHandle === null) return;
    timer.clearInterval(pollHandle);
    pollHandle = null;
  }

  function startPolling(): void {
    if (disposed || pollHandle !== null) return;
    pollHandle = timer.setInterval(() => options.onPollTick?.(), pollIntervalMs);
  }

  // poll เริ่มทันทีตั้งแต่สร้าง (สถานะยังไม่ SUBSCRIBED) — setConnectionStatus("SUBSCRIBED") จะหยุดเอง
  startPolling();

  return {
    handleEvent(event: UnifiedPosItemEvent): boolean {
      if (disposed) return false;
      if (!isValidUnifiedPosItemEvent(event)) return false;

      const seen = seenVersions.get(event.itemId);
      if (seen !== undefined && event.fulfillmentVersion <= seen) {
        // stale/duplicate ของ item นี้ (item อื่นไม่ได้รับผลกระทบ)
        return false;
      }
      seenVersions.set(event.itemId, event.fulfillmentVersion);
      options.onItemEvent?.(event);
      return true;
    },

    setConnectionStatus(next: UnifiedPosConnectionStatus): void {
      // dispose แล้วต้องเงียบทั้งหมด (กัน status callback ตีกลับมาช้าหลัง unmount)
      if (disposed) return;
      const previous = status;
      status = next;
      if (next === "SUBSCRIBED") {
        stopPolling();
        // reconnect เท่านั้น (เคย DISCONNECTED จริง) — ครั้งแรกที่ connect ไม่นับ
        if (previous === "DISCONNECTED") options.onSnapshotRefetchRequired?.();
      } else {
        startPolling();
      }
    },

    getConnectionStatus: () => status,

    dispose(): void {
      disposed = true;
      stopPolling();
      seenVersions.clear();
    },
  };
}
