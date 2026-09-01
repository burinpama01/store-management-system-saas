/**
 * Unified POS — Governed dine-in table settlement facade (Task U7, v0.35.7)
 *
 * ตามแผน: Plan/QR Order Voice Unified POS Implementation Plan v2.html (Task U7)
 *   - เส้นทาง governed ของ payment surfaces เดิม (collectPaymentAction /
 *     checkoutAndPayAction / settleWholeTableAction) เมื่อร้านเปิด unified_pos_enabled
 *   - เรียก RPC unified_pos_settle_table_order ผ่าน service client (convention U4-U6)
 *     และส่ง actor ชัดเจน — RPC ตรวจสิทธิ์เองด้วย user_has_permission_in_store
 *   - หลัก "never client totals": ยอดจริง (orders.total) อ่านจาก DB ฝั่ง server เพื่อ
 *     สร้าง expected revisions + ยอดรวมของ whole_table; partial ยังส่งยอดที่ client
 *     อ้างให้ RPC เทียบกับยอดรวม server (ยอดไม่ตรง → up_invalid_payment เหมือน legacy)
 *
 * Idempotency: operationKey ถูก reuse เมื่อ retry ของ request เดียวกัน (caller ส่ง
 * idempotencyKey มาจาก opts เดิม); requestHash hash เฉพาะ semantic ของคำขอ
 * (store/table/mode/orderIds/method/amount/received/change/reference) — retry ที่ถือ
 * payload เดียวกันได้ hash เดิม → replay, payload ต่าง → hash_conflict (RPC ตอบกลับ)
 */

import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { computeRequestHash, createOperationKey } from "@/modules/unified-pos/envelope";

export type SettlementMode = "partial" | "whole_table";

export interface UnifiedPosSettlementPayment {
  order_id: string;
  payment_id: string;
  amount: number;
  received_amount: number | null;
  change_amount: number | null;
}

export interface UnifiedPosSettlementOrderState {
  order_id: string;
  status: string;
  prep_status: string;
  revision: number;
  points_earned: number;
}

export interface UnifiedPosSettlementResult {
  mode: SettlementMode;
  table_id: string | null;
  table_closed: boolean;
  order_ids: string[];
  grand_total: number;
  payments: UnifiedPosSettlementPayment[];
  orders: UnifiedPosSettlementOrderState[];
}

/** outcome ของ RPC unified_pos_settle_table_order (โครงเดียวกับ U4/U5/U6) */
export type UnifiedPosSettlementOutcome =
  | { status: "executed"; result: UnifiedPosSettlementResult }
  | { status: "replayed"; result: UnifiedPosSettlementResult | null }
  | { status: "hash_conflict" }
  | { status: "error"; code: string; message: string };

export interface SettlementRequestPayload {
  storeId: string;
  tableId: string | null;
  mode: SettlementMode;
  orderIds: ReadonlyArray<string>;
  method: string;
  amount: number;
  receivedAmount?: number | null;
  changeAmount?: number | null;
  reference?: string | null;
}

/**
 * Hash ของ semantic ของคำขอชำระเงิน (เป็น pure function — unit test ครอบคลุม)
 * กฎเดียวกับ envelope: hash เฉพาะ semantic เท่านั้น ไม่รวม key/timestamp/actor
 */
export function buildSettlementRequestHash(payload: SettlementRequestPayload): string {
  return computeRequestHash({
    storeId: payload.storeId,
    tableId: payload.tableId ?? null,
    mode: payload.mode,
    orderIds: [...payload.orderIds],
    method: payload.method,
    amount: payload.amount,
    receivedAmount: payload.receivedAmount ?? null,
    changeAmount: payload.changeAmount ?? null,
    reference: payload.reference ?? null,
  });
}

export interface GovernedSettlementInput {
  organizationId: string;
  storeId: string;
  mode: SettlementMode;
  /** partial: order ids ที่จะชำระ; whole_table: ต้องว่าง (server derive จากโต๊ะ) */
  orderIds?: ReadonlyArray<string>;
  /** whole_table: ต้องระบุ; partial: ไม่ระบุ → ใช้ของ order ถ้าทุกใบผูกโต๊ะเดียวกัน */
  tableId?: string | null;
  method: "cash" | "qr_promptpay" | "credit_card" | "bank_transfer" | "other";
  /** ยอดที่ client อ้าง (partial — RPC เทียบกับยอดรวม server); whole_table คำนวณเอง */
  amount?: number | null;
  receivedAmount?: number | null;
  changeAmount?: number | null;
  reference?: string | null;
  actorUserId: string;
  /** reuse เมื่อ retry ของ request เดียวกัน (เหมือน idempotencyKey ของ surfaces เดิม) */
  idempotencyKey?: string | null;
}

export interface GovernedSettlementResult {
  ok: true;
  replayed: boolean;
  result: UnifiedPosSettlementResult;
}

export interface GovernedSettlementFailure {
  ok: false;
  error: { code: string; message: string; userMessage: string };
}

export type GovernedSettlementResponse = GovernedSettlementResult | GovernedSettlementFailure;

/**
 * อ่าน store flag ของ Unified POS (fail closed — ร้านไม่พบ/ปิด flag = false)
 * ใช้กำหนดเส้นทาง flags-gated ใน actions: flag on → governed, flag off → legacy
 */
export async function getUnifiedPosStoreFlag(storeId: string): Promise<{ organizationId: string | null; enabled: boolean }> {
  const supabase = await createSupabaseServiceClient();
  const { data } = await supabase
    .from("stores")
    .select("organization_id, unified_pos_enabled")
    .eq("id", storeId)
    .maybeSingle();
  return {
    organizationId: data?.organization_id ?? null,
    enabled: data?.unified_pos_enabled === true,
  };
}

/**
 * อ่านสถานะ server (revision/total/table) ของชุดบิล แล้วเรียก RPC governed
 * (partial อ่านตาม ids, whole_table อ่านทุกบิล open ของโต๊ะ) — ห้ามเชื่อ client state
 */
export async function settleOrdersGoverned(input: GovernedSettlementInput): Promise<GovernedSettlementResponse> {
  const supabase = await createSupabaseServiceClient();
  const orderIds = [...(input.orderIds ?? [])];

  // --- server-read state: revision + total + table ---
  let rows: { id: string; revision: number; total: number; table_id: string | null }[] = [];
  if (input.mode === "whole_table") {
    if (!input.tableId) {
      return { ok: false, error: { code: "up_invalid_item", message: "ต้องระบุโต๊ะ", userMessage: "ต้องระบุโต๊ะ" } };
    }
    const { data, error } = await supabase
      .from("orders")
      .select("id, revision, total, table_id")
      .eq("store_id", input.storeId)
      .eq("table_id", input.tableId)
      .eq("status", "open")
      .is("paid_at", null)
      .order("created_at", { ascending: true });
    if (error) return { ok: false, error: { code: error.code ?? "unknown", message: error.message, userMessage: "อ่านข้อมูลบิลไม่สำเร็จ" } };
    rows = (data ?? []) as { id: string; revision: number; total: number; table_id: string | null }[];
    if (rows.length === 0) {
      return { ok: false, error: { code: "up_not_found", message: "โต๊ะนี้ไม่มีบิลที่เปิดอยู่", userMessage: "โต๊ะนี้ไม่มีบิลที่เปิดอยู่" } };
    }
  } else {
    if (orderIds.length === 0) {
      return { ok: false, error: { code: "up_invalid_item", message: "ไม่มีออเดอร์ที่จะชำระ", userMessage: "ไม่มีออเดอร์ที่จะชำระ" } };
    }
    const { data, error } = await supabase
      .from("orders")
      .select("id, revision, total, table_id")
      .in("id", orderIds)
      .eq("store_id", input.storeId);
    if (error) return { ok: false, error: { code: error.code ?? "unknown", message: error.message, userMessage: "อ่านข้อมูลบิลไม่สำเร็จ" } };
    rows = (data ?? []) as { id: string; revision: number; total: number; table_id: string | null }[];
    if (rows.length !== orderIds.length) {
      return { ok: false, error: { code: "up_not_found", message: "ไม่พบออเดอร์", userMessage: "ไม่พบออเดอร์" } };
    }
  }

  // partial: ถ้าทุกบิลผูกโต๊ะเดียวกัน → ส่ง tableId ให้ RPC ล็อคโต๊ะ + ตรวจขอบเขต
  let tableId: string | null = input.tableId ?? null;
  if (input.mode === "partial") {
    const distinctTables = new Set(rows.map((r) => r.table_id));
    tableId = distinctTables.size === 1 ? [...distinctTables][0] ?? null : null;
  }

  const expectedRevisions: Record<string, number> = {};
  for (const row of rows) {
    expectedRevisions[row.id] = row.revision;
  }

  // whole_table: ยอดรวมมาจาก server-read; partial: ยอดที่ client อ้าง (RPC เทียบเอง)
  const amount =
    input.mode === "whole_table"
      ? Math.round(rows.reduce((sum, r) => sum + Number(r.total), 0) * 100) / 100
      : input.amount ?? 0;

  const operationKey = input.idempotencyKey?.trim() || createOperationKey();
  const requestHash = buildSettlementRequestHash({
    storeId: input.storeId,
    tableId,
    mode: input.mode,
    orderIds: input.mode === "whole_table" ? rows.map((r) => r.id) : orderIds,
    method: input.method,
    amount,
    receivedAmount: input.receivedAmount ?? null,
    changeAmount: input.changeAmount ?? null,
    reference: input.reference ?? null,
  });

  const { data, error } = await supabase.rpc("unified_pos_settle_table_order", {
    p_organization_id: input.organizationId,
    p_store_id: input.storeId,
    p_table_id: tableId,
    p_mode: input.mode,
    p_order_ids: input.mode === "whole_table" ? null : orderIds,
    p_expected_revisions: expectedRevisions,
    p_operation_key: operationKey,
    p_request_hash: requestHash,
    p_actor_user_id: input.actorUserId,
    p_method: input.method,
    p_amount: amount,
    p_received_amount: input.receivedAmount ?? null,
    p_change_amount: input.changeAmount ?? null,
    p_reference: input.reference ?? null,
  });

  if (error) {
    return { ok: false, error: { code: error.code ?? "unknown", message: error.message, userMessage: "ชำระเงินไม่สำเร็จ" } };
  }
  const outcome = data as UnifiedPosSettlementOutcome | null;
  if (!outcome) {
    return { ok: false, error: { code: "up_unexpected", message: "ชำระเงินไม่สำเร็จ กรุณาลองใหม่", userMessage: "ชำระเงินไม่สำเร็จ กรุณาลองใหม่" } };
  }
  return mapSettlementOutcome(outcome);
}

/**
 * map outcome ของ RPC → response ของ facade (pure — unit test ครอบคลุม)
 * - executed/replayed → สำเร็จ (replayed = retry ของคำขอเดิม — ถือว่าสำเร็จแบบ idempotent)
 * - hash_conflict → ข้อความไทยคงที่ (client refetch)
 * - error → ส่ง message จาก RPC ตรงๆ
 */
export function mapSettlementOutcome(outcome: UnifiedPosSettlementOutcome): GovernedSettlementResponse {
  switch (outcome.status) {
    case "executed":
      return { ok: true, replayed: false, result: outcome.result };
    case "replayed":
      if (outcome.result) return { ok: true, replayed: true, result: outcome.result };
      // result โดน purge (receipt เก่ามากก่อน U7) — ถือว่าสำเร็จ ให้ client refetch สถานะ
      return { ok: true, replayed: true, result: { mode: "partial", table_id: null, table_closed: false, order_ids: [], grand_total: 0, payments: [], orders: [] } };
    case "hash_conflict":
      return { ok: false, error: { code: "up_hash_conflict", message: "คำขอชำระเงินขัดแย้งกัน กรุณารีเฟรชหน้าจอ", userMessage: "คำขอชำระเงินขัดแย้งกัน กรุณารีเฟรชหน้าจอ" } };
    case "error":
      return { ok: false, error: { code: outcome.code, message: outcome.message, userMessage: outcome.message } };
  }
}
