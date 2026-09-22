// อ่าน/เขียนข้อเสนอต่ออายุ Enterprise รายบัญชี — service client เท่านั้น
// (ตารางนี้ revoke สิทธิ์ anon/authenticated ไว้ ผู้เรียกต้องเช็คสิทธิ์มาก่อนแล้ว)
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { mapError } from "@/shared/utils/error";
import type { EnterpriseOffer, EnterpriseOfferTerm } from "./enterprise-offer";

type OfferRow = {
  organization_id: string;
  amount: number | string;
  term_kind: string;
  term_days: number | null;
  ends_at: string | null;
  active: boolean;
  note: string | null;
  updated_at: string | null;
};

function toOffer(row: OfferRow): EnterpriseOffer | null {
  const term: EnterpriseOfferTerm | null =
    row.term_kind === "days" && row.term_days
      ? { kind: "days", days: row.term_days }
      : row.term_kind === "until" && row.ends_at
        ? { kind: "until", endsAt: row.ends_at }
        : null;
  if (!term) return null;
  return {
    organizationId: row.organization_id,
    amount: Number(row.amount),
    term,
    active: row.active,
    note: row.note,
    updatedAt: row.updated_at,
  };
}

// ตารางนี้จงใจไม่อยู่ใน database.types — การเพิ่มตารางใหม่เข้าไปทำให้ generic ของ
// supabase-js บานทั้ง repo (ดูบันทึก 2026-08-28) ใช้ทางหนีแบบเดียวกับ activation_nudge_log
function offersTable(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  return supabase.from("organization_enterprise_offers");
}

/** ข้อเสนอขององค์กร (รวมที่ปิดอยู่) — หน้าแอดมินใช้ */
export async function getEnterpriseOffer(organizationId: string): Promise<EnterpriseOffer | null> {
  const supabase = await createSupabaseServiceClient();
  const { data, error } = await offersTable(supabase)
    .select("organization_id, amount, term_kind, term_days, ends_at, active, note, updated_at")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error || !data) return null;
  return toOffer(data as OfferRow);
}

/**
 * ข้อเสนอที่ "ใช้ชำระได้จริงตอนนี้" — เป็นด่านเดียวที่เส้นทางชำระเงินควรเรียก
 * ปิดอยู่ หรือแบบ until ที่เลยวันไปแล้ว = ใช้ไม่ได้
 */
export async function getPayableEnterpriseOffer(
  organizationId: string,
  now: Date = new Date(),
): Promise<EnterpriseOffer | null> {
  const offer = await getEnterpriseOffer(organizationId);
  if (!offer || !offer.active) return null;
  if (offer.term.kind === "until" && new Date(offer.term.endsAt).getTime() <= now.getTime()) return null;
  return offer;
}

export async function upsertEnterpriseOffer(input: {
  organizationId: string;
  amount: number;
  term: EnterpriseOfferTerm;
  note: string | null;
  active: boolean;
  updatedBy: string;
}): Promise<{ ok: boolean; error: string | null }> {
  const supabase = await createSupabaseServiceClient();
  const { error } = await offersTable(supabase).upsert(
    {
      organization_id: input.organizationId,
      amount: input.amount,
      term_kind: input.term.kind,
      term_days: input.term.kind === "days" ? input.term.days : null,
      ends_at: input.term.kind === "until" ? input.term.endsAt : null,
      active: input.active,
      note: input.note,
      updated_by: input.updatedBy,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "organization_id" },
  );
  if (error) return { ok: false, error: mapError(error).userMessage };
  return { ok: true, error: null };
}

export async function setEnterpriseOfferActive(
  organizationId: string,
  active: boolean,
): Promise<{ ok: boolean; error: string | null }> {
  const supabase = await createSupabaseServiceClient();
  const { error } = await offersTable(supabase)
    .update({ active, updated_at: new Date().toISOString() })
    .eq("organization_id", organizationId);
  if (error) return { ok: false, error: mapError(error).userMessage };
  return { ok: true, error: null };
}
