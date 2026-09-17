// PR2 — ส่วน pure ของ overlay ข้อความบนหน้าขาย
// หน้าที่: parse ผลจาก /api/ai-assistant/text-command → รูปทรงที่ UI ใช้, สร้าง id ตามรูปแบบที่
// server รับ, แปลง outcomes เป็น "ขั้นตอน" ที่ตัวควบคุมเดินตาม, และ fingerprint ตะกร้าสำหรับ
// กัน undo ทับการแก้ด้วยมือ — ไม่มี React/fetch ที่นี่ (ตัวควบคุมอยู่ที่ text-assistant-core.ts)

import type { Cart } from "@/modules/pos/types";

/** เพดานความยาวข้อความ — ตรงกับ route (VOICE_INTENT_MAX_UTTERANCE) แต่ค่าคงที่นี้ใช้ฝั่ง client ได้ */
export const TEXT_COMMAND_MAX_LENGTH = 500;

/** รูปแบบ activeCartId ที่ route/session ยอมรับ — จุดเดียวของฝั่ง client (M4 review) */
export const ASSISTANT_CART_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export interface AssistantCandidate {
  readonly id: string;
  readonly name: string;
}

export type ParsedAssistantToolResult =
  | { readonly kind: "apply"; readonly intent: Record<string, unknown>; readonly productName: string }
  | { readonly kind: "apply_batch"; readonly items: readonly { intent: Record<string, unknown>; productName: string }[] }
  | { readonly kind: "open_checkout"; readonly announcement: string }
  | {
      readonly kind: "clarification";
      readonly reason: string;
      readonly productId?: string;
      readonly productName?: string;
      readonly note?: string;
      readonly candidates?: readonly AssistantCandidate[];
    }
  | { readonly kind: "matched"; readonly productName?: string; readonly price?: number | null; readonly outOfStock?: boolean; readonly note?: string | null }
  | { readonly kind: "ambiguous"; readonly candidates: readonly AssistantCandidate[] }
  | { readonly kind: "not_found"; readonly note?: string }
  | { readonly kind: "current_order"; readonly announcement: string; readonly itemCount: number; readonly total: number; readonly locked: boolean };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asCandidates(value: unknown): AssistantCandidate[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const candidates: AssistantCandidate[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    const id = asString(record?.id);
    const name = asString(record?.name);
    if (id && name) candidates.push({ id, name });
  }
  return candidates.length > 0 ? candidates : undefined;
}

/** parse ผล tool ที่ผ่าน result schema มาแล้ว — รูปทรงไม่รู้จัก = null (UI ต้อง fail แบบมีข้อความ) */
export function parseAssistantToolResult(result: unknown): ParsedAssistantToolResult | null {
  const record = asRecord(result);
  if (!record) return null;
  const status = asString(record.status);
  if (status === "apply" && asString(record.productName) && asRecord(record.intent)?.type) {
    return { kind: "apply", intent: asRecord(record.intent)!, productName: asString(record.productName)! };
  }
  if (status === "apply_batch" && Array.isArray(record.items)) {
    // ทุกรายการต้องครบรูปทรง ไม่งั้นถือว่าผลลัพธ์เสียหาย (ห้ามใส่ตะกร้าบางส่วน)
    const items: { intent: Record<string, unknown>; productName: string }[] = [];
    for (const entry of record.items) {
      const item = asRecord(entry);
      const intent = asRecord(item?.intent);
      const productName = asString(item?.productName);
      if (!intent || !intent.type || !productName) return null;
      items.push({ intent, productName });
    }
    return items.length > 0 ? { kind: "apply_batch", items } : null;
  }
  if (status === "client_action" && asString(record.action) === "open_checkout") {
    return { kind: "open_checkout", announcement: asString(record.announcement) ?? "เปิดหน้าจอรับชำระให้แล้ว" };
  }
  if (status === "clarification" && asString(record.reason)) {
    return {
      kind: "clarification",
      reason: asString(record.reason)!,
      productId: asString(record.productId),
      productName: asString(record.productName),
      note: asString(record.note),
      candidates: asCandidates(record.candidates),
    };
  }
  if (status === "matched") {
    const product = asRecord(record.product);
    return {
      kind: "matched",
      productName: asString(product?.name),
      price: typeof record.price === "number" ? record.price : null,
      outOfStock: record.outOfStock === true,
      note: asString(record.note) ?? null,
    };
  }
  if (status === "ambiguous") {
    const candidates = asCandidates(record.candidates);
    return candidates ? { kind: "ambiguous", candidates } : null;
  }
  if (status === "not_found") return { kind: "not_found", note: asString(record.note) };
  if (asString(record.announcement) && typeof record.itemCount === "number" && typeof record.total === "number") {
    return {
      kind: "current_order",
      announcement: asString(record.announcement)!,
      itemCount: record.itemCount,
      total: record.total,
      locked: record.locked === true,
    };
  }
  return null;
}

export const MUTATION_CLOSED_CODES: ReadonlySet<string> = new Set(["MUTATIONS_DISABLED", "DURABLE_STORAGE_REQUIRED"]);

/** ข้อความอธิบาย denial code จาก dispatcher — บอกทางออกเสมอ ไม่โชว์ code ดิบ */
export function describeDenialCode(code: string): string {
  if (MUTATION_CLOSED_CODES.has(code)) {
    return "การแก้ตะกร้าผ่านผู้ช่วยยังปิดในรอบนี้ (รอระบบ idempotency แบบทนทาน) — ใช้หน้าจอแทนได้ตามปกติ";
  }
  switch (code) {
    case "CONTEXT_UNAVAILABLE":
      return "ยังผูกตะกร้าไม่ได้ — แท็บหรืออุปกรณ์อื่นของบัญชีนี้อาจกำลังใช้ผู้ช่วยอยู่ ใช้แท็บเดิมหรือลองใหม่ภายหลัง";
    case "IDEMPOTENCY_CONFLICT":
      return "คำสั่งนี้ส่งมาแล้วด้วยเนื้อหาต่างกัน — ลองพิมพ์ใหม่";
    case "IDEMPOTENCY_PENDING":
      // PR3 — คำสั่งเดิม (คีย์เดียวกัน) ยังไม่ยืนยันผลในระบบ durable ห้ามทำซ้ำจนรู้ผล
      return "คำสั่งเดิมยังไม่ยืนยันผล — รอสักครู่แล้วลองใหม่อีกครั้ง";
    case "CAPACITY_EXCEEDED":
      return "คำสั่งแน่นเกินไปชั่วขณะ — พักแป๊บเดียวแล้วลองใหม่";
    case "PERMISSION_DENIED":
      return "บัญชีนี้ไม่มีสิทธิ์ใช้คำสั่งนี้";
    case "FEATURE_DISABLED":
      return "ผู้ช่วย AI ถูกปิดใช้งาน";
    case "RATE_LIMITED":
      return "ส่งคำสั่งถี่เกินไป — รอแป๊บเดียวแล้วลองใหม่";
    default:
      return "ยังทำคำสั่งนี้ไม่ได้ — ใช้หน้าจอแทนได้ตามปกติ";
  }
}

/** ข้อความของ clarification จาก resolver เดิม — ห้ามเดาแทนผู้ใช้ */
export function describeClarification(clarification: Extract<ParsedAssistantToolResult, { kind: "clarification" }>): string {
  switch (clarification.reason) {
    case "needs_quantity":
      return clarification.productName
        ? `${clarification.productName}: ระบุจำนวนด้วย เช่น “2 แก้ว”`
        : "ระบุจำนวนด้วย เช่น “ลาเต้ 2 แก้ว”";
    case "unavailable":
      return `${clarification.productName ?? "สินค้า"} ของหมด — เลือกจากหน้าจอได้`;
    case "not_found":
      return clarification.note ?? "ไม่พบสินค้านี้ในเมนู";
    case "unsupported":
      return clarification.note ?? "คำสั่งนี้ยังไม่รองรับในโหมดข้อความ";
    case "needs_option":
      return `${clarification.productName ?? "สินค้า"}: ${clarification.note ?? "ยังต้องเลือกตัวเลือกสินค้า"}`;
    case "ambiguous":
      return "หลายรายการตรงกัน — เลือกจากรายการด้านล่าง";
    default:
      return "ยังทำคำสั่งนี้ไม่ได้ — แก้บนหน้าจอได้";
  }
}

/**
 * ข้อความของความล้มเหลวระดับ route (reason เป็นตัวพิมพ์เล็กตามที่ route ส่ง)
 * ถ้า server ส่ง note มาด้วย ให้ใช้ note ของ server เสมอ — UI ห้ามแต่งข้อความทับเหตุผลจริง
 */
export function describeFailureReason(reason: string, note?: string | null): string {
  if (typeof note === "string" && note.length > 0) return note;
  switch (reason) {
    case "rate_limited":
      return "ส่งคำสั่งถี่เกินไป — รอแป๊บเดียวแล้วลองใหม่";
    case "assistant_disabled":
      return "ผู้ช่วย AI ยังปิดใช้งาน";
    case "ai_not_in_plan":
      return "แพ็กเกจนี้ยังไม่รวมผู้ช่วย AI — ใช้หน้าจอได้ตามปกติ";
    case "forbidden":
    case "unauthorized":
      return "บัญชีนี้ยังใช้ผู้ช่วยไม่ได้ — ใช้หน้าจอแทนได้ตามปกติ";
    case "network_error":
      return "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ — ลองใหม่อีกครั้ง";
    default:
      return "ยังทำคำสั่งนี้ไม่ได้ — ใช้หน้าจอแทนได้ตามปกติ";
  }
}

// ── แผนของ 1 คำสั่ง: outcomes จาก route → ขั้นตอนที่ UI เดินตามลำดับ ────────────────
// ขั้นตอนทั้งหมด "ไม่มี" การตัดสินใจเชิงธุรกิจในตัว — apply คือคำสั่งที่ server อนุมัติแล้ว
// และ client ต้องผลักเข้าตะกร้าผ่าน applyVoiceCartIntent เดิมเท่านั้น (ADR-009)

export type AssistantTurnStep =
  | { readonly kind: "apply"; readonly intent: Record<string, unknown>; readonly productName: string }
  | {
      readonly kind: "message";
      readonly level: "assistant" | "error";
      readonly message: string;
      readonly candidates?: readonly AssistantCandidate[];
    }
  | { readonly kind: "clear_search"; readonly note?: string }
  | { readonly kind: "open_product"; readonly productId: string }
  /** เปิดแผงรับชำระเดิมของ POS (ไม่มีการสร้าง payment/QR ที่นี่) */
  | { readonly kind: "open_checkout"; readonly message: string };

/** outcome 1 รายการจาก route — รูปทรงไม่ครบ = ข้อความ fail-closed ไม่ใช่การเดา */
function stepsForOutcome(rawOutcome: unknown): AssistantTurnStep[] {
  const outcome = asRecord(rawOutcome);
  if (!outcome) return [{ kind: "message", level: "error", message: UNKNOWN_RESULT_MESSAGE }];

  const kind = asString(outcome.kind) ?? "";
  const note = asString(outcome.note);

  if (kind === "client_action" && asString(outcome.action) === "clear_search") {
    return [{ kind: "clear_search", note }];
  }
  if (kind === "skipped") {
    return [{ kind: "message", level: "error", message: note ?? "คำสั่งนี้ยังไม่รองรับในโหมดข้อความ" }];
  }
  if (kind === "error") {
    return [{ kind: "message", level: "error", message: describeDenialCode(asString(outcome.code) ?? "") }];
  }
  if (kind !== "tool" && kind !== "clarification") {
    return [{ kind: "message", level: "error", message: UNKNOWN_RESULT_MESSAGE }];
  }

  const parsed = parseAssistantToolResult(outcome.result);
  if (!parsed) {
    return [{ kind: "message", level: "error", message: note ?? UNKNOWN_RESULT_MESSAGE }];
  }

  switch (parsed.kind) {
    case "apply":
      return [{ kind: "apply", intent: parsed.intent, productName: parsed.productName }];
    case "apply_batch":
      // เรียงตามลำดับที่ผู้ใช้พูดเสมอ — ห้ามสลับ
      return parsed.items.map((item) => ({ kind: "apply", intent: item.intent, productName: item.productName }));
    case "open_checkout":
      return [{ kind: "open_checkout", message: parsed.announcement }];
    case "clarification": {
      const candidates = parsed.candidates;
      const steps: AssistantTurnStep[] = [
        { kind: "message", level: "error", message: describeClarification(parsed), ...(candidates ? { candidates } : {}) },
      ];
      // สินค้าต้องเลือกตัวเลือก: ใช้ dialog เดิมของหน้าขาย (พฤติกรรมเดียวกับ Voice POS)
      if (parsed.reason === "needs_option" && parsed.productId) {
        steps.push({ kind: "open_product", productId: parsed.productId });
      }
      return steps;
    }
    case "matched": {
      const name = parsed.productName ?? "สินค้า";
      const price = typeof parsed.price === "number" ? ` — ราคา ${parsed.price} บาท` : "";
      const stock = parsed.outOfStock ? ` (${parsed.note ?? "ของหมดอยู่ในขณะนี้"})` : "";
      return [{ kind: "message", level: parsed.outOfStock ? "error" : "assistant", message: `พบ ${name}${price}${stock}` }];
    }
    case "ambiguous":
      return [{ kind: "message", level: "error", message: "หลายรายการตรงกัน — เลือกจากรายการด้านล่าง", candidates: parsed.candidates }];
    case "not_found":
      return [{ kind: "message", level: "error", message: parsed.note ?? "ไม่พบสินค้านี้ในเมนู" }];
    case "current_order":
      return [{ kind: "message", level: parsed.locked ? "error" : "assistant", message: parsed.announcement }];
    default:
      return [{ kind: "message", level: "error", message: UNKNOWN_RESULT_MESSAGE }];
  }
}

const UNKNOWN_RESULT_MESSAGE = "ผลลัพธ์จากผู้ช่วยไม่รู้จัก — ใช้หน้าจอแทนได้ตามปกติ";

/** outcomes ทั้งชุดของ 1 คำสั่ง → ขั้นตอนตามลำดับเดิม (ห้ามสลับลำดับคำสั่งของผู้ใช้) */
export function planAssistantTurn(outcomes: readonly unknown[]): readonly AssistantTurnStep[] {
  if (!Array.isArray(outcomes)) return [{ kind: "message", level: "error", message: UNKNOWN_RESULT_MESSAGE }];
  return outcomes.flatMap((outcome) => stepsForOutcome(outcome));
}

/** id ตะกร้าของ terminal นี้ — สร้างครั้งเดียวต่อ mount และต้องตรงรูปแบบที่ server ยอมรับ */
export function createAssistantCartId(): string {
  const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  return `cart-${random.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32)}`;
}

/** requestId ต่อครั้งที่ส่ง — ใช้เป็น seed ของ idempotency key ฝั่ง orchestrator */
export function createAssistantRequestId(sequence: number): string {
  const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const suffix = random.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 16);
  return `req-${sequence.toString(36)}${suffix}`.slice(0, 64);
}

/** fingerprint ของตะกร้า — เทียบว่า "ใบเดิมเป๊ะ" ก่อน undo กลับ (กันทับการแก้ด้วยมือ) */
export function cartFingerprint(cart: Cart): string {
  return JSON.stringify(cart);
}
