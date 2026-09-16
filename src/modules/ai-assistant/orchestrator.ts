// PR2 — orchestrator ของช่องทางข้อความ: ข้อความ → intent → tool ผ่าน dispatcher ของ PR1
//
// กติกาที่ล็อกไว้:
//   - deterministic parser ของเสียงมาก่อนเสมอ (คำสั่งที่ parser เข้าใจไม่เสียโควตา AI)
//   - AI เป็นทางสำรองเฉพาะ no_match และต้องผ่าน denylist เดิมก่อนใช้ (validateAiProposalAgainstAllowlist)
//   - ไฟล์นี้ pure: interpreter/dispatcher ถูกฉีดเข้ามา — ทดสอบได้โดยไม่มี network/DB
//   - idempotencyKey ต่อคำสั่ง = `${requestId}-${index}` — replay ของ request เดิมเจอ ledger เดิม

import { parseVoiceCommand } from "@/modules/voice-pos/parser";
import { validateAiProposalAgainstAllowlist } from "@/modules/voice-pos/hybrid-parser";
import { normalizeAiCommandQuantity, type AiVoiceCommand, type AiVoiceIntentEnvelope } from "@/modules/voice-pos/ai-intent-schema";
import type { VoiceIntent } from "@/modules/voice-pos/types";
import type { Result } from "./foundation";

export type TextFailureReason = "forbidden" | "empty" | "quota_denied" | "ai_disabled" | "ai_timeout" | "ai_error" | "ai_invalid_output";

export type TextIntentOutcome =
  | { readonly ok: true; readonly source: "deterministic" | "ai"; readonly commands: readonly AiVoiceCommand[]; readonly note?: string }
  | { readonly ok: false; readonly reason: TextFailureReason };

export interface TextInterpreterDeps {
  /** AI พร้อมใช้ไหม (env/kill switch) — false = deterministic เท่านั้น */
  readonly aiEnabled: () => boolean;
  /** เรียก provider — route ประกอบ quota reserve/settle ให้แล้ว; reason ตาม TextFailureReason (ฝั่ง ai_* และ quota) */
  readonly callProvider: (text: string) => Promise<{ ok: true; envelope: AiVoiceIntentEnvelope } | { ok: false; reason: TextFailureReason }>;
}

/** interpreter ประกอบเส้นทางเดียวกับเสียง: deterministic ก่อน → AI เฉพาะ no_match */
export function createTextInterpreter(deps: TextInterpreterDeps): (text: string) => Promise<TextIntentOutcome> {
  return async (text: string): Promise<TextIntentOutcome> => {
    const fast = parseVoiceCommand(text);
    if (fast.resultCode === "forbidden_command") return { ok: false, reason: "forbidden" };
    if (fast.resultCode === "empty_transcript") return { ok: false, reason: "empty" };
    if (fast.resultCode === "matched") {
      const command = voiceIntentToAiCommand(fast.intent);
      if (command) return { ok: true, source: "deterministic", commands: [command] };
    }
    if (fast.resultCode === "invalid_quantity") {
      return { ok: true, source: "deterministic", commands: [], note: "จำนวนไม่ถูกต้อง — ระบุจำนวน 1 ถึง 99" };
    }
    // no_match / low_confidence / matched-but-ไม่รองรับในโหมดข้อความ → ทางสำรอง AI
    if (!deps.aiEnabled()) return { ok: false, reason: "ai_disabled" };
    const provider = await deps.callProvider(text);
    if (!provider.ok) return { ok: false, reason: provider.reason };
    // ด่านหลังรับ: วลีที่โมเดลเสนอต้องผ่าน denylist เดียวกับคำพูดดิบ (AI ไม่มีสิทธิ์ override)
    const validated = validateAiProposalAgainstAllowlist(provider.envelope);
    if (validated.source === "blocked") return { ok: false, reason: "forbidden" };
    if (validated.source === "ai_no_command") return { ok: true, source: "ai", commands: [] };
    if (validated.source === "ai") return { ok: true, source: "ai", commands: validated.envelope.commands };
    return { ok: false, reason: "ai_error" };
  };
}

function voiceIntentToAiCommand(intent: VoiceIntent): AiVoiceCommand | null {
  switch (intent.type) {
    case "pos.add_item":
      return { intent: "pos.add_item", productPhrase: intent.productPhrase, quantity: intent.quantity, optionPhrases: [] };
    case "pos.set_quantity":
      return { intent: "pos.set_quantity", productPhrase: intent.productPhrase, quantity: intent.quantity, optionPhrases: [] };
    case "pos.increase_item":
      return { intent: "pos.increase_item", productPhrase: intent.productPhrase, quantity: intent.delta, optionPhrases: [] };
    case "pos.decrease_item":
      return { intent: "pos.decrease_item", productPhrase: intent.productPhrase, quantity: intent.delta, optionPhrases: [] };
    case "pos.remove_item":
      return { intent: "pos.remove_item", productPhrase: intent.productPhrase, quantity: null, optionPhrases: [] };
    case "pos.clear_search":
      return { intent: "pos.clear_search", productPhrase: null, quantity: null, optionPhrases: [] };
    default:
      // navigate / choose_option / confirm_selection / change_option / unknown — ไม่อยู่ในโหมดข้อความ MVP
      return null;
  }
}

export interface CartRequestContext {
  readonly activeCartId: string;
  readonly cartVersion: number;
}

export interface TextCommandDeps {
  readonly interpret: (text: string) => Promise<TextIntentOutcome>;
  readonly dispatch: (request: { tool: string; args: unknown; idempotencyKey: string }) => Promise<Result>;
  /** บริบทตะกร้าที่ client ยืนยันมา — server จะตรวจผ่าน resolveCartBinding อีกชั้น (ห้ามเชื่อเงียบ ๆ) */
  readonly cart: CartRequestContext | null;
  readonly requestId: string;
}

type PlannedCommand =
  | { readonly plan: "tool"; readonly tool: string; readonly args: unknown }
  | { readonly plan: "needs_quantity" }
  | { readonly plan: "unsupported" };

/** แผนคำสั่ง 1 รายการ → tool + args (id ทั้งหมดมาจาก resolver ที่ tool เรียก ไม่มาจากโมเดล) */
function planCartCommand(command: AiVoiceCommand, cart: CartRequestContext, quantity: number | null): PlannedCommand {
  const phrase = command.productPhrase ?? "";
  const cartRef = { activeCartId: cart.activeCartId, cartVersion: cart.cartVersion };
  switch (command.intent) {
    case "pos.add_item":
      if (quantity === null) return { plan: "needs_quantity" };
      return { plan: "tool", tool: "pos.add_item", args: { ...cartRef, productPhrase: phrase, quantity, optionPhrases: command.optionPhrases } };
    case "pos.set_quantity":
      if (quantity === null) return { plan: "needs_quantity" };
      return { plan: "tool", tool: "pos.change_quantity", args: { ...cartRef, productPhrase: phrase, mode: "set" as const, quantity } };
    case "pos.increase_item":
      return { plan: "tool", tool: "pos.change_quantity", args: { ...cartRef, productPhrase: phrase, mode: "increase" as const, quantity: quantity ?? 1 } };
    case "pos.decrease_item":
      return { plan: "tool", tool: "pos.change_quantity", args: { ...cartRef, productPhrase: phrase, mode: "decrease" as const, quantity: quantity ?? 1 } };
    case "pos.remove_item":
      return { plan: "tool", tool: "pos.remove_item", args: { ...cartRef, productPhrase: phrase } };
    default:
      return { plan: "unsupported" };
  }
}

export interface TextCommandOutcome {
  readonly source: "deterministic" | "ai" | "system";
  readonly intent: string;
  /** tool = ผลจาก dispatcher, clarification = ต้องถามต่อ, client_action = ให้ UI ทำผ่าน bridge, error = dispatcher ปฏิเสธ */
  readonly kind: "tool" | "clarification" | "client_action" | "skipped" | "error";
  readonly ok: boolean;
  readonly tool?: string;
  /** รหัสจาก dispatcher เช่น MUTATIONS_DISABLED / DURABLE_STORAGE_REQUIRED / CONTEXT_UNAVAILABLE */
  readonly code?: string;
  /** ผลลัพธ์ที่ผ่าน result schema ของ tool แล้ว (apply instruction / clarification / current order echo) */
  readonly result?: unknown;
  readonly action?: "clear_search";
  readonly note?: string;
}

export type TextCommandRunResult =
  | { readonly ok: true; readonly outcomes: readonly TextCommandOutcome[]; readonly note?: string }
  | { readonly ok: false; readonly reason: TextFailureReason };

/** ข้อความหนึ่งครั้ง → คำสั่งหลายรายการ (ตามลำดับที่พูด/พิมพ์) → dispatch ทีละคำสั่ง */
export async function runTextCommand(text: string, deps: TextCommandDeps): Promise<TextCommandRunResult> {
  const interpretation = await deps.interpret(text);
  if (!interpretation.ok) return { ok: false, reason: interpretation.reason };
  if (interpretation.commands.length === 0) return { ok: true, outcomes: [], note: interpretation.note };

  const outcomes: TextCommandOutcome[] = [];
  for (const [index, command] of interpretation.commands.entries()) {
    const source = interpretation.source;
    if (command.intent === "pos.clear_search") {
      outcomes.push({ source, intent: command.intent, kind: "client_action", ok: true, action: "clear_search", note: "ล้างช่องค้นหาบนหน้าขายแล้ว" });
      continue;
    }
    if (command.intent === "navigate") {
      outcomes.push({ source, intent: command.intent, kind: "skipped", ok: false, note: "การนำทางยังใช้ปุ่มเดิม — โหมดข้อความรองรับคำสั่งตะกร้า" });
      continue;
    }
    if (!deps.cart) {
      outcomes.push({ source, intent: command.intent, kind: "error", ok: false, code: "CONTEXT_UNAVAILABLE", note: "ยังไม่ผูกตะกร้า — เปิดหน้าขายก่อนสั่งงาน" });
      continue;
    }

    const quantity = normalizeAiCommandQuantity(command);
    const plan = planCartCommand(command, deps.cart, quantity);
    if (plan.plan === "unsupported") {
      outcomes.push({ source, intent: command.intent, kind: "skipped", ok: false, note: "คำสั่งนี้ยังไม่รองรับในโหมดข้อความ" });
      continue;
    }
    if (plan.plan === "needs_quantity") {
      outcomes.push({
        source,
        intent: command.intent,
        kind: "clarification",
        ok: false,
        result: { status: "clarification", reason: "needs_quantity" },
        note: "ระบุจำนวนด้วย เช่น “ลาเต้ 2 แก้ว”",
      });
      continue;
    }

    const result = await deps.dispatch({ tool: plan.tool, args: plan.args, idempotencyKey: `${deps.requestId}-${index}` });
    if (result.ok) {
      outcomes.push({ source, intent: command.intent, kind: "tool", ok: true, tool: plan.tool, result: result.data });
    } else {
      outcomes.push({ source, intent: command.intent, kind: "error", ok: false, tool: plan.tool, code: result.code });
    }
  }
  return { ok: true, outcomes };
}
