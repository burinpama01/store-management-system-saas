// P5 (v0.44.4) — ตัวเรียก /api/ai/voice-intent จากเบราว์เซอร์
//
// หน้าที่เดียว: ยิง request หนึ่งครั้งต่อการพูดหนึ่งรอบ แล้วคืนผลแบบ typed
//   - requestId ต่อ 1 speech session → final ซ้ำของการกดเดียวกันไม่ยิงซ้ำ
//   - คำตอบที่มาถึงหลังยกเลิก/unmount ต้องถูกทิ้ง (ผู้เรียกส่ง AbortSignal มา)
//   - ไม่เก็บ transcript ไว้ที่ไหนเลย: ใช้ในรอบเดียวแล้วปล่อย

import {
  parseAiVoiceEnvelope,
  type AiVoiceIntentEnvelope,
} from "./ai-intent-schema";

export type VoiceIntentClientResult =
  | { readonly ok: true; readonly envelope: AiVoiceIntentEnvelope }
  | { readonly ok: false; readonly reason: string };

export const VOICE_INTENT_ENDPOINT = "/api/ai/voice-intent";

/** id ต่อหนึ่งรอบพูด — ใช้เป็นทั้ง idempotency key และ request hash ฝั่ง server */
export function createVoiceRequestId(): string {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `voice-${random}`.slice(0, 64);
}

export interface RequestAiVoiceIntentInput {
  readonly transcript: string;
  readonly requestId: string;
  readonly locale?: "th-TH" | "en-US";
  readonly signal?: AbortSignal;
  /** ฉีดได้เพื่อทดสอบ — ปกติใช้ fetch ของเบราว์เซอร์ */
  readonly fetchImpl?: typeof fetch;
}

export async function requestAiVoiceIntent(
  input: RequestAiVoiceIntentInput,
): Promise<VoiceIntentClientResult> {
  const doFetch = input.fetchImpl ?? globalThis.fetch;
  if (!doFetch) return { ok: false, reason: "ai_unavailable" };

  let response: Response;
  try {
    response = await doFetch(VOICE_INTENT_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      signal: input.signal,
      body: JSON.stringify({
        requestId: input.requestId,
        utterance: input.transcript,
        locale: input.locale ?? "th-TH",
        origin: "push_to_talk",
      }),
    });
  } catch (error) {
    // ยกเลิกเอง (เปลี่ยนหน้า/กดยกเลิก) ไม่ใช่ความผิดพลาดที่ต้องแจ้งผู้ใช้
    const aborted = error instanceof Error && error.name === "AbortError";
    return { ok: false, reason: aborted ? "aborted" : "network" };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, reason: "invalid_response" };
  }

  if (!response.ok) {
    const reason =
      payload && typeof payload === "object" && typeof (payload as { reason?: unknown }).reason === "string"
        ? (payload as { reason: string }).reason
        : "ai_unavailable";
    return { ok: false, reason };
  }

  const intent = (payload as { intent?: unknown } | null)?.intent;
  const parsed = parseAiVoiceEnvelope(intent);
  // ฝั่ง client ตรวจ schema ซ้ำอีกชั้น: ไม่ไว้ใจแม้แต่คำตอบจาก API ของตัวเอง
  if (!parsed.ok) return { ok: false, reason: "invalid_response" };
  return { ok: true, envelope: parsed.envelope };
}
