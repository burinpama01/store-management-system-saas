// ข้อเสนอต่ออายุ Enterprise รายบัญชี — ตรรกะบริสุทธิ์ (ทดสอบแยกได้ ไม่แตะ DB)
//
// ซุปเปอร์แอดมินตกลงราคากับร้านเป็นรายกรณี แล้วตั้งไว้ว่า "จ่ายเท่านี้ ใช้ได้ถึงเมื่อนี้"
// ร้านจ่ายผ่านช่องทางอัตโนมัติเดิม ถ้าไม่อยากต่อก็เลือกแพ็กเกจปกติได้ตามเดิม

export const ENTERPRISE_OFFER_MAX_DAYS = 3650;

/** อายุที่แอดมินกำหนด: เพิ่มเป็นจำนวนวัน หรือ กำหนดวันหมดอายุตายตัว */
export type EnterpriseOfferTerm =
  | { readonly kind: "days"; readonly days: number }
  | { readonly kind: "until"; readonly endsAt: string };

export interface EnterpriseOffer {
  readonly organizationId: string;
  readonly amount: number;
  readonly term: EnterpriseOfferTerm;
  readonly active: boolean;
  readonly note: string | null;
  readonly updatedAt: string | null;
}

export type EnterpriseOfferRejection =
  | "amount_invalid"
  | "days_invalid"
  | "ends_at_invalid"
  | "ends_at_past";

export function describeOfferRejection(reason: EnterpriseOfferRejection | string | null): string {
  switch (reason) {
    case "amount_invalid":
      return "ราคาต้องเป็นตัวเลขมากกว่า 0 บาท";
    case "days_invalid":
      return `จำนวนวันต้องอยู่ระหว่าง 1 ถึง ${ENTERPRISE_OFFER_MAX_DAYS} วัน`;
    case "ends_at_invalid":
      return "วันหมดอายุไม่ถูกต้อง";
    case "ends_at_past":
      return "วันหมดอายุต้องเป็นวันในอนาคต";
    default:
      return "บันทึกข้อเสนอไม่สำเร็จ";
  }
}

/**
 * ตรวจค่าที่แอดมินกรอก คืนข้อเสนอที่ normalize แล้ว หรือเหตุผลที่รับไม่ได้
 * เป็นด่านเดียวที่เขียนลงตาราง จึงต้องกันค่าพิลึกให้ครบตรงนี้
 */
export function parseEnterpriseOfferInput(
  input: { amount: unknown; termKind: unknown; termDays?: unknown; endsAt?: unknown; note?: unknown },
  now: Date = new Date(),
): { ok: true; amount: number; term: EnterpriseOfferTerm; note: string | null } | { ok: false; reason: EnterpriseOfferRejection } {
  const amount = typeof input.amount === "number" ? input.amount : Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, reason: "amount_invalid" };

  const note = typeof input.note === "string" && input.note.trim() ? input.note.trim() : null;

  if (input.termKind === "days") {
    const days = typeof input.termDays === "number" ? input.termDays : Number(input.termDays);
    if (!Number.isInteger(days) || days < 1 || days > ENTERPRISE_OFFER_MAX_DAYS) {
      return { ok: false, reason: "days_invalid" };
    }
    return { ok: true, amount: round2(amount), term: { kind: "days", days }, note };
  }

  if (input.termKind === "until") {
    const raw = typeof input.endsAt === "string" ? input.endsAt : "";
    const parsed = new Date(raw);
    if (!raw || Number.isNaN(parsed.getTime())) return { ok: false, reason: "ends_at_invalid" };
    if (parsed.getTime() <= now.getTime()) return { ok: false, reason: "ends_at_past" };
    return { ok: true, amount: round2(amount), term: { kind: "until", endsAt: parsed.toISOString() }, note };
  }

  return { ok: false, reason: "ends_at_invalid" };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * วันหมดอายุที่ร้านจะได้เมื่อชำระ
 * แบบ days สะสมจากวันหมดอายุเดิมถ้ายังไม่หมด (เหมือน computeNewExpiry ของแพ็กเกจปกติ)
 * แบบ until คือวันตายตัวตามที่ตกลง ไม่สนว่าเหลือเวลาเดิมอยู่เท่าไร
 */
export function computeOfferExpiry(
  term: EnterpriseOfferTerm,
  currentExpiryISO: string | null,
  now: Date = new Date(),
): string {
  if (term.kind === "until") return new Date(term.endsAt).toISOString();
  const current = currentExpiryISO ? new Date(currentExpiryISO) : null;
  const base =
    current && !Number.isNaN(current.getTime()) && current.getTime() > now.getTime() ? current : now;
  const next = new Date(base.getTime());
  next.setUTCDate(next.getUTCDate() + term.days);
  return next.toISOString();
}

function formatThaiDate(iso: string): string {
  return new Date(iso).toLocaleDateString("th-TH", {
    timeZone: "Asia/Bangkok",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/** ประโยคสรุปให้ทั้งแอดมิน (ก่อนบันทึก) และร้าน (บนการ์ดชำระเงิน) เห็นตรงกัน */
export function describeOffer(
  offer: { amount: number; term: EnterpriseOfferTerm },
  currentExpiryISO: string | null,
  now: Date = new Date(),
): string {
  const expiry = computeOfferExpiry(offer.term, currentExpiryISO, now);
  const amount = offer.amount.toLocaleString("th-TH", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  const term =
    offer.term.kind === "days" ? `ต่ออีก ${offer.term.days} วัน` : "ตามวันที่ตกลงไว้";
  return `จ่าย ฿${amount} · ${term} · ใช้ Enterprise ได้ถึง ${formatThaiDate(expiry)}`;
}
