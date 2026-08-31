/**
 * Unified POS — Idempotency operation envelope (Task U4, v0.35.4)
 *
 * ตามแผน: Plan/QR Order Voice Unified POS Implementation Plan v2.html (Task U4)
 *   - QR action สร้าง operationKey + requestHash (SHA-256 ของ canonical payload)
 *     และ reuse key/hash เดิมเมื่อ retry ของ request เดียวกัน
 *   - RPC ฝั่ง DB (create_qr_order_with_items_v2 / add_items_to_table_v2) ตรวจ
 *     unique (store_id, operation_key) + hash ก่อน execute (U2 receipts)
 *
 * กฎของ hash (สำคัญ):
 *   - ต้อง hash เฉพาะ semantic ของคำขอ (store/table/items/subtotal) เท่านั้น
 *     ห้ามรวมค่า "ที่ regenerate ทุกครั้ง" เช่น orderNumber หรือ timestamp
 *     มิฉะนั้น retry ที่ถือ payload เดียวกันจะได้ hash ต่าง → hash_conflict ทั้งที่
 *     เป็นคำขอเดียวกัน (แผน: same key + same hash → replay)
 *   - canonicalize: sort key ของ object แบบ recursive, คงลำดับ array ไว้
 *     (ลำดับ cart เป็น semantic ของคำขอ), drop undefined
 */
import { createHash, randomUUID } from "node:crypto";

/** payload ที่ใช้ hash ของการส่งออร์เดอร์ QR / staff add-items (เฉพาะ semantic) */
export interface TableOrderOperationPayload {
  storeId: string;
  tableId: string;
  subtotal: number;
  items: ReadonlyArray<{
    productId: string;
    variantId?: string;
    modifierOptionIds: ReadonlyArray<string>;
    quantity: number;
    note?: string;
  }>;
}

/** operation key ใหม่ต่อ request (retry ต้อง reuse key เดิมของ request นั้น) */
export function createOperationKey(): string {
  return randomUUID();
}

/** guard ขนาด/ชนิดของ operation key ที่ส่งข้าม wire (กันค่าแปลกๆ เข้า RPC) */
export function isValidOperationKey(key: string): boolean {
  return typeof key === "string" && key.length >= 8 && key.length <= 128;
}

/** guard ขนาด/ชนิดของ request hash */
export function isValidRequestHash(hash: string): boolean {
  return typeof hash === "string" && /^[0-9a-f]{16,128}$/i.test(hash);
}

/** sort key ของ object แบบ recursive (array คงลำดับ) — ผลลัพธ์ JSON.stringify แล้ว deterministic */
export function canonicalizeOperationPayload(value: unknown): string {
  const normalize = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(normalize);
    if (v !== null && typeof v === "object") {
      const entries = Object.entries(v as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .map(([key, child]) => [key, normalize(child)] as const)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return Object.fromEntries(entries);
    }
    return v;
  };
  return JSON.stringify(normalize(value));
}

/** SHA-256 hex ของ canonical payload — ใช้เป็น requestHash ใน RPC v2 */
export function computeRequestHash(payload: unknown): string {
  return createHash("sha256").update(canonicalizeOperationPayload(payload)).digest("hex");
}

/**
 * result ที่ RPC v2 (create_qr_order_with_items_v2 / add_items_to_table_v2) คืนใน receipt
 * โครงตรงกับ result ของ UnifiedPosOperationOutcome ใน contracts (U1)
 */
export interface UnifiedPosTableOrderResult {
  order_id: string;
  order_number: string;
  table_id: string;
  table_number: string | null;
  subtotal: number;
  revision: number;
}

/**
 * jsonb ที่ RPC v2 คืนทั้งหมด:
 *   - executed/replayed ตาม UnifiedPosOperationOutcome (replayed.result อาจเป็น null
 *     เมื่อ payload ถูก purge ตาม retention 30 วัน — tombstone ยังกัน execute ซ้ำ)
 *   - hash_conflict ตาม contracts
 *   - error: {status, code: UNIFIED_POS_ERROR_CODES, message} (shape สม่ำเสมอตาม U4 brief)
 */
export type UnifiedPosTableOrderRpcOutcome =
  | { status: "executed"; result: UnifiedPosTableOrderResult }
  | { status: "replayed"; result: UnifiedPosTableOrderResult | null }
  | { status: "hash_conflict" }
  | { status: "error"; code: string; message: string };
