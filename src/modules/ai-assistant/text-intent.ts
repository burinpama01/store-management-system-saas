// PR2 — text→intent adapter สำหรับช่องทางข้อความ (server-only pattern เดียวกับ voice-intent)
//
// ทำไม reuse ทั้งก้อน: interpretVoiceIntent มีสิ่งที่ PR2 ต้องการครบอยู่แล้ว —
// payload allowlist (ส่งเฉพาะข้อความ+locale+intent list ไม่มีบริบทร้าน/ตะกร้า/ผู้ใช้),
// model allowlist ผ่าน route, store:false, hard timeout, parse fail-closed ด้วย schema เดิม
// ข้อความที่พิมพ์กับคำพูดที่ถอดมาอยู่ในคลาสความเสี่ยงเดียวกัน จึงใช้ system prompt เดียวกัน

import type { AiVoiceIntentEnvelope } from "@/modules/voice-pos/ai-intent-schema";
import { VOICE_INTENT_LOCALES, interpretVoiceIntent, type VoiceIntentLocale } from "@/modules/ai/voice-intent";

export type { VoiceIntentLocale };
export const TEXT_INTENT_LOCALES = VOICE_INTENT_LOCALES;

export type TextIntentFailureReason =
  | "ai_disabled"
  | "ai_timeout"
  | "ai_invalid_output"
  | "ai_error";

export type TextIntentResult =
  | { readonly ok: true; readonly envelope: AiVoiceIntentEnvelope; readonly tokens: number }
  | { readonly ok: false; readonly reason: TextIntentFailureReason };

/** เรียกผู้ให้บริการ AI 1 ครั้ง — route ต้องจอง quota ก่อนเรียกเสมอ (เหมือนเส้นทางเสียง) */
export async function interpretTextIntent(input: {
  readonly text: string;
  readonly locale: VoiceIntentLocale;
  readonly approvedModelId: string;
  readonly signal?: AbortSignal;
}): Promise<TextIntentResult> {
  return interpretVoiceIntent({
    utterance: input.text,
    locale: input.locale,
    approvedModelId: input.approvedModelId,
    signal: input.signal,
  });
}
