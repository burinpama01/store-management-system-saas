"use server";

import { revalidatePath } from "next/cache";
import { logSystemEvent } from "@/modules/system/event-log";
import { getTaxDocumentsAccess } from "@/modules/tax/access";
import {
  cancelSalesDocument,
  findOrderByNumber,
  issueFullCreditNote,
  issueTaxInvoiceFromOrder,
  type OrderForInvoice,
} from "@/modules/tax/documents-repository";
import { saveTaxParty, searchTaxParties } from "@/modules/tax/repository";
import { validateTaxParty } from "@/modules/tax/rules";
import type { TaxParty, TaxPartyInput } from "@/modules/tax/types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ทุกเส้นทางเอกสารภาษีต้องทิ้ง log ทั้งสำเร็จและล้มเหลว (กฎโปรเจกต์: ห้ามสำเร็จแบบเงียบ) */
async function logTax(input: {
  action: string;
  ok: boolean;
  message: string;
  organizationId: string;
  storeId: string;
  actorUserId: string;
  context?: Record<string, unknown>;
}) {
  await logSystemEvent({
    level: input.ok ? "info" : "warn",
    source: "tax",
    action: input.action,
    message: input.message,
    organizationId: input.organizationId,
    storeId: input.storeId,
    actorUserId: input.actorUserId,
    context: input.context,
  }).catch(() => undefined);
}

function cleanReason(raw: string): string | null {
  const reason = (raw ?? "").trim();
  return reason && reason.length <= 500 ? reason : null;
}

export async function findOrderForInvoiceAction(orderNumber: string): Promise<{ data: OrderForInvoice | null; error: string | null }> {
  const { decision, ctx } = await getTaxDocumentsAccess();
  if (!decision.allowed) return { data: null, error: decision.message };
  const number = (orderNumber ?? "").trim();
  if (!number || number.length > 40) return { data: null, error: "กรอกเลขบิลให้ถูกต้อง" };
  const result = await findOrderByNumber(ctx.storeId, number);
  if (result.error) return { data: null, error: result.error };
  if (!result.data) return { data: null, error: `ไม่พบบิลเลขที่ ${number} ในสาขานี้` };
  return { data: result.data, error: null };
}

export async function searchBuyersAction(query: string): Promise<{ data: TaxParty[]; error: string | null }> {
  const { decision, ctx } = await getTaxDocumentsAccess();
  if (!decision.allowed) return { data: [], error: decision.message };
  const result = await searchTaxParties(ctx.storeId, (query ?? "").slice(0, 60), 20);
  return { data: result.data ?? [], error: result.error };
}

export async function saveBuyerAction(input: TaxPartyInput): Promise<{ data: { id: string } | null; error: string | null }> {
  const { decision, ctx, user } = await getTaxDocumentsAccess();
  if (!decision.allowed) return { data: null, error: decision.message };
  const validated = validateTaxParty(input);
  if ("error" in validated) return { data: null, error: validated.error };
  const result = await saveTaxParty({ organizationId: ctx.organizationId, storeId: ctx.storeId }, validated.value, user.id);
  await logTax({
    action: "saveBuyer",
    ok: !result.error,
    message: result.error ? `บันทึกผู้ซื้อไม่สำเร็จ: ${result.error}` : input.id ? "แก้ข้อมูลผู้ซื้อ" : "เพิ่มผู้ซื้อ",
    organizationId: ctx.organizationId,
    storeId: ctx.storeId,
    actorUserId: user.id,
    context: { partyId: result.data?.id ?? input.id ?? null, partyType: validated.value.partyType, hasTaxId: Boolean(validated.value.taxId) },
  });
  return result.error ? { data: null, error: result.error } : { data: result.data, error: null };
}

export async function issueTaxInvoiceAction(orderId: string, partyId: string): Promise<{ data: { id: string; docNo: string } | null; error: string | null }> {
  const { decision, ctx, user } = await getTaxDocumentsAccess();
  if (!decision.allowed) return { data: null, error: decision.message };
  if (!decision.canIssue) return { data: null, error: "สาขานี้ยังไม่พร้อมออกใบกำกับภาษี (ตั้งค่า › ข้อมูลภาษี)" };
  if (!UUID_RE.test(orderId) || !UUID_RE.test(partyId)) return { data: null, error: "ข้อมูลไม่ถูกต้อง" };
  const result = await issueTaxInvoiceFromOrder(orderId, partyId);
  await logTax({
    action: "issueTaxInvoice",
    ok: !result.error,
    message: result.error ? `ออกใบกำกับภาษีไม่สำเร็จ: ${result.error}` : `ออกใบกำกับภาษี ${result.data?.docNo}`,
    organizationId: ctx.organizationId,
    storeId: ctx.storeId,
    actorUserId: user.id,
    context: { orderId, partyId, documentId: result.data?.id ?? null, docNo: result.data?.docNo ?? null },
  });
  if (result.error) return { data: null, error: result.error };
  revalidatePath("/tax-documents");
  return { data: result.data, error: null };
}

export async function issueCreditNoteAction(documentId: string, reason: string): Promise<{ data: { id: string; docNo: string } | null; error: string | null }> {
  const { decision, ctx, user } = await getTaxDocumentsAccess();
  if (!decision.allowed) return { data: null, error: decision.message };
  if (!decision.canVoid) return { data: null, error: "ออกใบลดหนี้ได้เฉพาะผู้จัดการขึ้นไป" };
  if (!UUID_RE.test(documentId)) return { data: null, error: "ข้อมูลไม่ถูกต้อง" };
  const cleaned = cleanReason(reason);
  if (!cleaned) return { data: null, error: "กรุณาระบุเหตุผลการลดหนี้ (ไม่เกิน 500 ตัวอักษร)" };
  const result = await issueFullCreditNote(documentId, cleaned);
  await logTax({
    action: "issueCreditNote",
    ok: !result.error,
    message: result.error ? `ออกใบลดหนี้ไม่สำเร็จ: ${result.error}` : `ออกใบลดหนี้ ${result.data?.docNo}`,
    organizationId: ctx.organizationId,
    storeId: ctx.storeId,
    actorUserId: user.id,
    context: { sourceDocumentId: documentId, documentId: result.data?.id ?? null, reason: cleaned },
  });
  if (result.error) return { data: null, error: result.error };
  revalidatePath("/tax-documents");
  return { data: result.data, error: null };
}

export async function cancelDocumentAction(documentId: string, reason: string): Promise<{ error: string | null }> {
  const { decision, ctx, user } = await getTaxDocumentsAccess();
  if (!decision.allowed) return { error: decision.message };
  if (!decision.canVoid) return { error: "ยกเลิกเอกสารได้เฉพาะผู้จัดการขึ้นไป" };
  if (!UUID_RE.test(documentId)) return { error: "ข้อมูลไม่ถูกต้อง" };
  const cleaned = cleanReason(reason);
  if (!cleaned) return { error: "กรุณาระบุเหตุผลการยกเลิก (ไม่เกิน 500 ตัวอักษร)" };
  const result = await cancelSalesDocument(documentId, cleaned);
  await logTax({
    action: "cancelDocument",
    ok: !result.error,
    message: result.error ? `ยกเลิกเอกสารไม่สำเร็จ: ${result.error}` : "ยกเลิกเอกสารภาษี",
    organizationId: ctx.organizationId,
    storeId: ctx.storeId,
    actorUserId: user.id,
    context: { documentId, reason: cleaned },
  });
  if (result.error) return { error: result.error };
  revalidatePath("/tax-documents");
  return { error: null };
}
