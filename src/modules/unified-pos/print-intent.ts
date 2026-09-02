/**
 * Unified POS — Settlement print intent (Task U11, v0.37.2)
 *
 * แผนอ้างอิง: Plan/QR Order Voice Unified POS Implementation Plan v2.html
 *   - Task "U11 · Bill tools + print replay contract" (version 0.37.2)
 *
 * สัญญา (contract):
 *   - Settlement→print intent ทำงาน "หลัง commit ของ settlement เสมอ" (server action
 *     เรียกต่อจาก unified_pos_settle_table_order สำเร็จ) — ไม่เคยสร้าง print job
 *     ภายใน transaction ของการชำระเงิน (U7 กันไว้แล้ว: งานพิมพ์ผูกกับ commit ไม่ได้)
 *   - ทุกงานพิมพ์ของ intent มี source_key ที่ deterministic จาก settlement
 *     operation key → replay ของคำขอเดิม (same key + same hash) ได้ job id ชุดเดิม
 *     โดยไม่ duplicate ใบเสร็จ/ตั๋วครัว (dedupe ระดับ schema: unique index
 *     print_jobs.source_key — migration 20260902000001)
 *   - client ไม่เคย browser-auto-print ผล replay — การพิมพ์ซ้ำต้องเป็น action
 *     ชัดเจน (reprint) และทุกครั้งมี audit row (append-only audit_logs)
 *   - Print Hub retry ใช้ job แถวเดิม lifecycle เดิม (pending→claimed→printed|failed)
 *     — ไม่มีทางสร้างแถวใหม่จาก retry; การ enqueue ซ้ำของคีย์เดิมคืน id เดิม
 *
 * การเลือกเครื่องพิมพ์ฝั่ง server: intent ใช้ "default printer ของร้าน"
 * (printers.is_default = true) ก่อน แล้วค่อยไล่เครื่องที่ Print Hub ถึงได้
 * (ip/escpos + ip_address ใน LAN หรือ bluetooth + hub_bluetooth_port) —
 * ถ้าไม่มีเครื่องไหนถึง Hub ได้ ไม่สร้างงานพิมพ์ แต่แจ้ง notice (ไม่บล็อกการชำระเงิน)
 * เครื่องพิมพ์ browser/usb (พิมพ์จากเครื่องนั้นตรง ๆ) ใช้เส้นทาง client เดิม —
 * server เลือก target ให้ไม่ได้โดยดีไซน์
 */

import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import type { Database } from "@/server/integrations/supabase/database.types";
import { CMD, buildEscPosReceipt, type EscPosReceiptInput } from "@/modules/printing/escpos";
import {
  validateHubBluetoothPort,
  validatePrintPayloadBase64,
  validatePrintTarget,
} from "@/modules/printing/print-hub";
import {
  countPrintJobsBySourceKeyPrefix,
  enqueuePrintJob,
  findPrintJobIdBySourceKey,
} from "@/modules/printing/print-hub-repository";
import { isValidOperationKey } from "./envelope";
import { normalizePrintCopies } from "@/modules/printing/types";
import { parseModifierNames } from "./bill-repository";
import type { UnifiedPosSettlementResult } from "./settlement";

type PrinterRow = Database["public"]["Tables"]["printers"]["Row"];
type ReceiptSettingsRow = Database["public"]["Tables"]["receipt_settings"]["Row"];
type KitchenStationRow = Database["public"]["Tables"]["kitchen_stations"]["Row"];

/** prefix ของ receipt reference — deterministic จาก settlement operation key */
export const RECEIPT_REFERENCE_PREFIX = "unified_pos_settlement:";

/** คีย์กำกับงานของ intent */
export const RECEIPT_JOB_SUFFIX = "receipt";
export const STATION_JOB_PREFIX = "station";
export const REPRINT_JOB_PREFIX = "reprint";

/** reference ที่ stable ของการชำระเงินครั้งนี้ (ใช้พิมพ์/ค้นหา job + audit) */
export function buildUnifiedPosReceiptReference(operationKey: string): string {
  return `${RECEIPT_REFERENCE_PREFIX}${operationKey}`;
}

export function buildReceiptJobSourceKey(receiptReference: string): string {
  return `${receiptReference}:${RECEIPT_JOB_SUFFIX}`;
}

export function buildStationJobSourceKey(receiptReference: string, stationId: string): string {
  return `${receiptReference}:${STATION_JOB_PREFIX}:${stationId}`;
}

export function buildReprintJobSourceKey(receiptJobSourceKey: string, reprintNumber: number): string {
  return `${receiptJobSourceKey}:${REPRINT_JOB_PREFIX}:${reprintNumber}`;
}

/** ผลของ print intent ที่ client (Bills tab) เห็น — ส่งต่อจาก server action */
export interface SettlementPrintIntentView {
  /** อ้างอิงใบเสร็จ stable — deterministic จาก operation key ของ settlement */
  readonly reference: string;
  /** job id ของใบเสร็จ (null = ไม่มีงานอัตโนมัติ — ดู receiptNotice) */
  readonly receiptJobId: string | null;
  /** job id ของตั๋วครัวต่อ station (auto_print_station_tickets) */
  readonly stationJobIds: readonly string[];
  /** เหตุผลที่ไม่มีงานใบเสร็จอัตโนมัติ (ปิด auto / ไม่มีเครื่องพิมพ์) */
  readonly receiptNotice: string | null;
  /** เหตุผลที่รายการบางส่วนไม่ได้ส่งตั๋วครัว (ไม่มี station/เครื่องพิมพ์) */
  readonly stationNotice: string | null;
}

export interface SettlementPrintIntentInput {
  organizationId: string;
  storeId: string;
  /** ผู้ก่อให้เกิด intent (actor ของ settlement — ใช้เขียน audit ของ reprint) */
  actorUserId: string;
  /** ผลที่ RPC settlement คืน (executed/replayed — เดิมทั้งคู่) */
  settlement: UnifiedPosSettlementResult;
  /** operation key เดิมของคำขอชำระเงิน (idempotency key — replay reuse key เดิม) */
  operationKey: string;
  /** replay = retry ของคำขอเดิม → job เดิมถูกอ้างอิงด้วย key เดียวกัน */
  replayed: boolean;
}

export interface ResolvedHubTarget {
  printerId: string;
  kind: "ip" | "bt";
  host?: string;
  port?: number;
  device?: string;
}

/** แปลงแถวเครื่องพิมพ์ → target ที่ Print Hub เอาไปพิมพ์ได้จริง (null = พิมพ์ผ่าน Hub ไม่ได้) */
export function toHubRoutableTarget(printer: PrinterRow): ResolvedHubTarget | null {
  if (printer.type === "bluetooth") {
    if (!printer.hub_bluetooth_port) return null;
    const btCheck = validateHubBluetoothPort(printer.hub_bluetooth_port);
    if (btCheck.error || !btCheck.device) return null;
    return { printerId: printer.id, kind: "bt", device: btCheck.device };
  }
  if (printer.type === "ip" || printer.type === "escpos") {
    if (!printer.ip_address) return null;
    const targetCheck = validatePrintTarget({ host: printer.ip_address, port: printer.port });
    if (targetCheck.error || !targetCheck.target) return null;
    return { printerId: printer.id, kind: "ip", host: targetCheck.target.host, port: targetCheck.target.port };
  }
  // browser/usb — พิมพ์ตรงจากเครื่องนั้น (เส้นทาง client เดิม) — server เลือก target ไม่ได้
  return null;
}

type EscPosLineItem = EscPosReceiptInput["items"][number];

interface SettledOrderRow {
  id: string;
  order_number: string;
  table_number: string | null;
  subtotal: number | null;
  discount: number | null;
  total: number | null;
  loyalty_points_earned: number | null;
}

interface SettledItemRow {
  order_id: string;
  product_name: string;
  variant_name: string | null;
  modifiers: unknown;
  quantity: number;
  unit_price: number;
  total_price: number;
  note: string | null;
  kitchen_station_id: string | null;
}

interface SettledPaymentRow {
  order_id: string;
  method: string;
  amount: number;
  received_amount: number | null;
  change_amount: number | null;
}

/** concat bytes ตาม print_copies (mirror การทำซ้ำของ buildReceiptPrinterBytes ฝั่ง browser) */
function repeatBytes(bytes: Uint8Array, copies: number): Uint8Array {
  const total = new Uint8Array(bytes.length * copies);
  for (let i = 0; i < copies; i += 1) total.set(bytes, i * bytes.length);
  return total;
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/**
 * build ESC/POS payload ของใบเสร็จหลังชำระ — อ่านจาก server state เท่านั้น
 * (รายการ voided=false + ยอด orders.total + payment แถวจริง) ไม่มี PromptPay QR
 * เพราะใบเสร็จสถานะ paid ห้ามแสดง QR (convention 2026-06-22)
 */
export function buildSettlementReceiptPayload(input: {
  settings: Pick<
    ReceiptSettingsRow,
    "store_name" | "address" | "phone" | "header_text" | "footer_text" | "paper_width" | "print_copies"
  >;
  orderRows: ReadonlyArray<SettledOrderRow>;
  itemRows: ReadonlyArray<SettledItemRow>;
  paymentRows: ReadonlyArray<SettledPaymentRow>;
  printedAt: string;
}): { payload?: string; error?: string } {
  const itemsByOrder = new Map<string, SettledItemRow[]>();
  for (const item of input.itemRows) {
    const list = itemsByOrder.get(item.order_id) ?? [];
    list.push(item);
    itemsByOrder.set(item.order_id, list);
  }

  const items: EscPosLineItem[] = [];
  let subtotal = 0;
  let discount = 0;
  let total = 0;
  let loyaltyPointsEarned = 0;
  for (const order of input.orderRows) {
    for (const item of itemsByOrder.get(order.id) ?? []) {
      items.push({
        name: item.product_name,
        variantName: item.variant_name ?? undefined,
        modifierNames: parseModifierNames(item.modifiers),
        quantity: item.quantity,
        totalPrice: Number(item.total_price),
        note: item.note ?? undefined,
      });
    }
    subtotal += Number(order.subtotal ?? order.total ?? 0);
    discount += Number(order.discount ?? 0);
    total += Number(order.total ?? 0);
    loyaltyPointsEarned += Number(order.loyalty_points_earned ?? 0);
  }

  const singleOrder = input.orderRows.length === 1;
  const firstTableNumber = input.orderRows[0]?.table_number ?? null;
  const receipt: EscPosReceiptInput = {
    storeName: input.settings.store_name,
    address: input.settings.address ?? undefined,
    phone: input.settings.phone ?? undefined,
    headerText: input.settings.header_text ?? undefined,
    // หลายบิล (whole_table / partial หลายใบ) → ระบุเป็นบิลโต๊ะ (parity กับ TableBillModal)
    orderNumber: singleOrder ? input.orderRows[0]!.order_number : `TABLE-${firstTableNumber ?? "TABLE"}`,
    tableNumber: firstTableNumber ?? undefined,
    items,
    subtotal: Math.round(subtotal * 100) / 100,
    discount: Math.round(discount * 100) / 100,
    total: Math.round(total * 100) / 100,
    // ชำระหลายบิลในครั้งเดียว: เงินรับ/เงินทอนของ "รอบ" อยู่กับบิลแรกเท่านั้น (ตาม RPC U7)
    payments: input.paymentRows.map((payment, index) => ({
      method: payment.method,
      amount: Number(payment.amount),
      receivedAmount: index === 0 ? (payment.received_amount ?? undefined) : undefined,
      changeAmount: index === 0 ? (payment.change_amount ?? undefined) : undefined,
    })),
    loyaltyPointsEarned: loyaltyPointsEarned > 0 ? loyaltyPointsEarned : undefined,
    footerText: input.settings.footer_text ?? undefined,
    paperWidth: input.settings.paper_width === "80mm" ? "80mm" : "58mm",
    printedAt: input.printedAt,
  };

  const bytes = repeatBytes(
    buildEscPosReceipt(receipt),
    normalizePrintCopies(input.settings.print_copies ?? 1),
  );
  return validatePrintPayloadBase64(toBase64(bytes));
}

const encoder = new TextEncoder();
function encodeText(text: string): number[] {
  return Array.from(encoder.encode(text));
}

/**
 * ตั๋วครัว ESC/POS แบบเรียบง่าย (สถานี + รายการ ไม่มีราคา — intent หลังชำระ)
 * เจตนา minimal: ตั๋ว intent นี้ใช้เป็น "บันทึกท้ายรอบ" ต่อสถานี ไม่ใช่ตั๋วส่งครัวปกติ
 * (ไม่มีเวลา/เลขโต๊ะ/นับ print_copies — encoding UTF-8 + CODEPAGE_THAI ตาม convention
 * เดียวกับ buildEscPosReceipt) — ตั๋วส่งครัวปกติยังอยู่ในเส้นทาง QR notifier เดิม
 */
export function buildStationTicketBytes(input: {
  stationName: string;
  paperWidth: "58mm" | "80mm";
  orderRows: ReadonlyArray<{ id: string; order_number: string }>;
  itemRows: ReadonlyArray<SettledItemRow>;
}): Uint8Array {
  const cols = input.paperWidth === "80mm" ? 42 : 32;
  const bytes: number[] = [];
  const push = (...chunks: (readonly number[])[]) => {
    for (const chunk of chunks) bytes.push(...chunk);
  };
  push(CMD.INIT, CMD.CODEPAGE_THAI);
  push(CMD.ALIGN_CENTER, CMD.BOLD_ON, CMD.DOUBLE_HEIGHT);
  push(encodeText(`${input.stationName}\n`));
  push(CMD.NORMAL_SIZE, CMD.BOLD_OFF);
  push(CMD.ALIGN_LEFT);
  push(encodeText("=".repeat(cols) + "\n"));
  push(encodeText(`บิล: ${input.orderRows.map((o) => o.order_number).join(", ")}\n`));
  push(encodeText("=".repeat(cols) + "\n"));
  for (const item of input.itemRows) {
    const name = item.variant_name ? `${item.product_name} (${item.variant_name})` : item.product_name;
    push(CMD.BOLD_ON, encodeText(`x${item.quantity} ${name}\n`), CMD.BOLD_OFF);
    const modifiers = parseModifierNames(item.modifiers);
    if (modifiers.length > 0) push(encodeText(`  + ${modifiers.join(", ")}\n`));
    if (item.note) push(encodeText(`  * ${item.note}\n`));
  }
  push(CMD.CUT);
  return new Uint8Array(bytes);
}

/**
 * สร้างงานพิมพ์อัตโนมัติของ settlement (post-commit intent):
 *   - ใบเสร็จ เมื่อ auto_print_receipt เปิด (key: <reference>:receipt)
 *   - ตั๋วครัวต่อ station เมื่อ auto_print_station_tickets เปิด
 *     (key: <reference>:station:<station_id>)
 * ทุกงานใช้ enqueue idempotent (source_key) — replay คืน job id เดิม ไม่มี duplicate
 */
export async function resolveSettlementPrintIntent(
  input: SettlementPrintIntentInput,
): Promise<SettlementPrintIntentView> {
  const { organizationId, storeId, settlement, operationKey } = input;
  const reference = buildUnifiedPosReceiptReference(operationKey);
  const supabase = await createSupabaseServiceClient();

  const empty = (overrides: Partial<SettlementPrintIntentView> = {}): SettlementPrintIntentView => ({
    reference,
    receiptJobId: null,
    stationJobIds: [],
    receiptNotice: null,
    stationNotice: null,
    ...overrides,
  });

  const { data: settingsRow } = await supabase
    .from("receipt_settings")
    .select(
      "store_name, address, phone, header_text, footer_text, paper_width, print_copies, auto_print_receipt, auto_print_station_tickets",
    )
    .eq("store_id", storeId)
    .maybeSingle();
  if (!settingsRow) {
    return empty({ receiptNotice: "ร้านนี้ยังไม่ได้ตั้งค่าใบเสร็จ — ไม่สร้างงานพิมพ์อัตโนมัติ" });
  }
  const settings = settingsRow as Pick<
    ReceiptSettingsRow,
    | "store_name"
    | "address"
    | "phone"
    | "header_text"
    | "footer_text"
    | "paper_width"
    | "print_copies"
    | "auto_print_receipt"
    | "auto_print_station_tickets"
  >;
  const wantReceipt = settings.auto_print_receipt === true;
  const wantStations = settings.auto_print_station_tickets === true;
  if (!wantReceipt && !wantStations) {
    return empty({ receiptNotice: "การพิมพ์อัตโนมัติปิดอยู่ — จะไม่มีงานพิมพ์ถูกสร้าง" });
  }

  const orderIds = [...settlement.order_ids];
  if (orderIds.length === 0) {
    return empty({ receiptNotice: "ไม่มีออเดอร์ในผลการชำระ — ไม่สร้างงานพิมพ์" });
  }

  // ---- server state ของบิลที่เพิ่งชำระ (อ่านใหม่ — intent ไม่ใช้ snapshot ของ client) ----
  // (orderIds มาจาก RPC แล้ว แต่ scope ด้วย store_id อีกชั้นเป็น defense-in-depth)
  const [{ data: orderRows }, { data: itemRows }, { data: paymentRows }, { data: printerRows }] = await Promise.all([
    supabase
      .from("orders")
      .select("id, order_number, table_number, subtotal, discount, total, loyalty_points_earned")
      .eq("store_id", storeId)
      .in("id", orderIds),
    supabase
      .from("order_items")
      .select("order_id, product_name, variant_name, modifiers, quantity, unit_price, total_price, note, kitchen_station_id")
      .in("order_id", orderIds)
      .eq("voided", false),
    supabase
      .from("payments")
      .select("order_id, method, amount, received_amount, change_amount")
      .in("order_id", orderIds)
      .eq("status", "completed"),
    supabase
      .from("printers")
      .select("id, name, type, is_default, ip_address, port, hub_bluetooth_port")
      .eq("store_id", storeId)
      .eq("organization_id", organizationId)
      .order("is_default", { ascending: false })
      .order("created_at", { ascending: true })
      .order("id", { ascending: true }),
  ]);

  const orders = (orderRows ?? []) as SettledOrderRow[];
  const items = (itemRows ?? []) as SettledItemRow[];
  const payments = (paymentRows ?? []) as SettledPaymentRow[];
  const printers = (printerRows ?? []) as PrinterRow[];
  if (orders.length === 0) {
    return empty({ receiptNotice: "อ่านข้อมูลบิลที่ชำระไม่สำเร็จ — ไม่สร้างงานพิมพ์" });
  }

  // ---- ใบเสร็จ (auto_print_receipt) ----
  let receiptJobId: string | null = null;
  let receiptNotice: string | null = null;
  if (wantReceipt) {
    const receiptKey = buildReceiptJobSourceKey(reference);
    receiptJobId = await findPrintJobIdBySourceKey(storeId, receiptKey); // replay → job เดิม
    if (!receiptJobId) {
      const printer = printers.find((p) => toHubRoutableTarget(p) !== null) ?? null;
      const target = printer ? toHubRoutableTarget(printer) : null;
      if (!printer || !target) {
        receiptNotice = "ไม่มีเครื่องพิมพ์ที่ Print Hub ถึงได้ — ยังไม่สร้างงานพิมพ์ใบเสร็จ";
      } else {
        const built = buildSettlementReceiptPayload({
          settings,
          orderRows: orders,
          itemRows: items,
          paymentRows: payments,
          printedAt: new Date().toISOString(),
        });
        if (built.error || !built.payload) {
          receiptNotice = "สร้างข้อมูลใบเสร็จไม่สำเร็จ — ยังไม่สร้างงานพิมพ์";
        } else {
          const enqueued = await enqueuePrintJob({
            organizationId,
            storeId,
            printerId: target.printerId,
            kind: target.kind,
            host: target.host ?? null,
            port: target.port,
            device: target.device ?? null,
            payloadB64: built.payload,
            sourceKey: receiptKey,
            jobKind: "receipt",
          });
          receiptJobId = enqueued.data?.id ?? null;
          if (!receiptJobId) receiptNotice = "สร้างงานพิมพ์ใบเสร็จไม่สำเร็จ";
        }
      }
    }
  } else {
    receiptNotice = "การพิมพ์ใบเสร็จอัตโนมัติปิดอยู่";
  }

  // ---- ตั๋วครัวต่อ station (auto_print_station_tickets) ----
  const stationJobIds: string[] = [];
  let stationNotice: string | null = null;
  if (wantStations) {
    const stationIds = [...new Set(items.map((item) => item.kitchen_station_id).filter((id): id is string => id !== null))];
    let stations: Pick<KitchenStationRow, "id" | "name" | "printer_id">[] = [];
    if (stationIds.length > 0) {
      const { data: stationRows } = await supabase
        .from("kitchen_stations")
        .select("id, name, printer_id")
        .eq("store_id", storeId)
        .in("id", stationIds);
      stations = (stationRows ?? []) as Pick<KitchenStationRow, "id" | "name" | "printer_id">[];
    }
    const itemsByStation = new Map<string, SettledItemRow[]>();
    let unroutedItemCount = 0;
    for (const item of items) {
      if (!item.kitchen_station_id) {
        unroutedItemCount += item.quantity;
        continue;
      }
      const list = itemsByStation.get(item.kitchen_station_id) ?? [];
      list.push(item);
      itemsByStation.set(item.kitchen_station_id, list);
    }

    for (const station of stations) {
      const stationItems = itemsByStation.get(station.id) ?? [];
      if (stationItems.length === 0) continue;
      const printer = printers.find((p) => p.id === station.printer_id) ?? null;
      const target = printer ? toHubRoutableTarget(printer) : null;
      if (!printer || !target) {
        unroutedItemCount += stationItems.reduce((sum, item) => sum + item.quantity, 0);
        continue;
      }
      const sourceKey = buildStationJobSourceKey(reference, station.id);
      const existing = await findPrintJobIdBySourceKey(storeId, sourceKey); // replay → job เดิม
      if (existing) {
        stationJobIds.push(existing);
        continue;
      }
      const payload = validatePrintPayloadBase64(
        toBase64(
          buildStationTicketBytes({
            stationName: station.name,
            paperWidth: settings.paper_width === "80mm" ? "80mm" : "58mm",
            orderRows: orders,
            itemRows: stationItems,
          }),
        ),
      );
      if (payload.error || !payload.payload) continue; // payload เกินขนาด — ข้าม station นี้ (fail-safe)
      const enqueued = await enqueuePrintJob({
        organizationId,
        storeId,
        printerId: target.printerId,
        kind: target.kind,
        host: target.host ?? null,
        port: target.port,
        device: target.device ?? null,
        payloadB64: payload.payload,
        sourceKey,
        jobKind: "station_ticket",
      });
      if (enqueued.data?.id) stationJobIds.push(enqueued.data.id);
    }
    if (unroutedItemCount > 0) {
      stationNotice = `รายการ ${unroutedItemCount} ชิ้นไม่ได้ผูกสถานีครัว/เครื่องพิมพ์ — ไม่สร้างตั๋วครัวให้`;
    }
  } else {
    stationNotice = "การพิมพ์ตั๋วครัวอัตโนมัติปิดอยู่";
  }

  return empty({ receiptJobId, receiptNotice, stationJobIds, stationNotice });
}

/**
 * พิมพ์ใบเสร็จซ้ำอย่างชัดเจน (manual reprint) — action เดียวที่ client เรียกได้
 *   - หาใบเสร็จต้นฉบับด้วย source key (<reference>:receipt) — ไม่มี = ไม่มีอะไรให้พิมพ์ซ้ำ
 *   - copy แถวเดิมเป็น job ใหม่ด้วยคีย์ reprint:<n> (n = ลำดับ reprint ถัดไป นับจากของเดิม)
 *     — collision จากการกดพร้อมกันแก้ด้วยการนับใหม่ (unique index เป็นผู้ตัดสิน)
 *   - เขียน audit row (append-only) ทุกครั้ง — request_id = คีย์ของงานพิมพ์ซ้ำ
 */
export async function reprintUnifiedPosReceipt(input: {
  organizationId: string;
  storeId: string;
  actorUserId: string;
  receiptReference: string;
}): Promise<{ ok: true; jobId: string; sourceKey: string } | { ok: false; code: string; message: string }> {
  const { organizationId, storeId, actorUserId, receiptReference } = input;
  const supabase = await createSupabaseServiceClient();

  // reference จาก client — ต้องเป็น prefix ที่รู้จัก + operation key ท้าย reference ผ่าน
  // guard ขนาด/ชนิดเดียวกับ envelope (กันค่าแปลกเข้าถึงคิวงานพิมพ์)
  if (!receiptReference.startsWith(RECEIPT_REFERENCE_PREFIX)) {
    return { ok: false, code: "up_invalid_item", message: "อ้างอิงใบเสร็จไม่ถูกต้อง" };
  }
  const operationKey = receiptReference.slice(RECEIPT_REFERENCE_PREFIX.length);
  if (!isValidOperationKey(operationKey)) {
    return { ok: false, code: "up_invalid_item", message: "อ้างอิงใบเสร็จไม่ถูกต้อง" };
  }

  const originalKey = buildReceiptJobSourceKey(receiptReference);
  const { data: original, error: originalError } = await supabase
    .from("print_jobs")
    .select("id, payload_b64, printer_id, target_kind, target_host, target_port, target_device, source_key")
    .eq("store_id", storeId)
    .eq("source_key", originalKey)
    .maybeSingle();
  if (originalError) {
    return { ok: false, code: "up_not_found", message: "อ่านงานพิมพ์เดิมไม่สำเร็จ" };
  }
  if (!original) {
    return { ok: false, code: "up_not_found", message: "ไม่พบงานพิมพ์ใบเสร็จเดิม — การพิมพ์อัตโนมัติอาจปิดอยู่" };
  }

  const originalRow = original as {
    id: string;
    payload_b64: string;
    printer_id: string | null;
    target_kind: "ip" | "bt";
    target_host: string | null;
    target_port: number;
    target_device: string | null;
    source_key: string | null;
  };

  // n ถัดไปของ reprint — นับจากแถวจริง (คีย์เก่าถูก unique index ปิดทางเสมอ);
  // ถ้าอีกคำขอชนะคีย์นี้ในช่วงเสี้ยววินาทีเดียวกัน (deduped) ต้อง "นับใหม่" ด้วย n ถัดไป —
  // reprint เป็น explicit action แต่ละครั้งต้องได้ job + audit ของตัวเอง ไม่ dedupe ทับกัน
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const existingCount = await countPrintJobsBySourceKeyPrefix(storeId, `${originalKey}:${REPRINT_JOB_PREFIX}:`);
    const nextNumber = existingCount + 1 + attempt;
    const reprintKey = buildReprintJobSourceKey(originalKey, nextNumber);
    const enqueued = await enqueuePrintJob({
      organizationId,
      storeId,
      printerId: originalRow.printer_id,
      kind: originalRow.target_kind,
      host: originalRow.target_host,
      port: originalRow.target_port,
      device: originalRow.target_device,
      payloadB64: originalRow.payload_b64, // พิมพ์ซ้ำ = ข้อมูลใบเสร็จเดิมเป๊ะ (ไม่ rebuild)
      sourceKey: reprintKey,
      jobKind: "receipt",
    });
    if (enqueued.data?.id && !enqueued.data.deduped) {
      const { error: auditError } = await supabase.from("audit_logs").insert({
        organization_id: organizationId,
        store_id: storeId,
        actor_user_id: actorUserId,
        action: "unified_pos.reprint_receipt",
        before: {
          receipt_reference: receiptReference,
          original_job_id: originalRow.id,
          original_source_key: originalRow.source_key,
        },
        after: {
          reprint_job_id: enqueued.data.id,
          reprint_source_key: reprintKey,
          reprint_number: nextNumber,
        },
        reason: "พิมพ์ใบเสร็จซ้ำอย่างชัดเจนจากแท็บบิล (unified POS)",
        request_id: reprintKey,
      });
      if (auditError) {
        // reprint ต้องถูก audit เสมอ — audit fail = ยอมรับงานพิมพ์ไม่ได้: ทำเครื่องหมาย
        // job เป็น failed (เก็บหลักฐาน + Print Hub จะไม่พิมพ์ — ต่างจาก delete ที่ทำให้
        // Hub ที่ claim อยู่พิมพ์โดยไม่มี audit) แล้ว fail-loud; กลไกนี้เป็น best-effort
        // สุดท้าย (job+audit แยก call — ถ้า update ล้มเหลวด้วยถือเป็น incident)
        await supabase
          .from("print_jobs")
          .update({ status: "failed", error: "reprint audit failed — งานนี้ถูกยกเลิก" })
          .eq("id", enqueued.data.id)
          .eq("store_id", storeId);
        return { ok: false, code: "up_unexpected", message: "บันทึกประวัติการพิมพ์ซ้ำไม่สำเร็จ" };
      }
      return { ok: true, jobId: enqueued.data.id, sourceKey: reprintKey };
    }
  }
  return { ok: false, code: "up_unexpected", message: "สร้างงานพิมพ์ซ้ำไม่สำเร็จ กรุณาลองอีกครั้ง" };
}
