// AI Live — บันทึกบทสนทนาลง ai_live_conversation_turns (เปิดเฉพาะช่วงทดสอบ)
//
// ใครเขียน:
//   - role user/assistant: browser ส่งข้อความถอดเสียงจาก provider มาที่ POST /live/transcript
//   - role tool: route relay (/live/tool) บันทึกเองจากข้อมูลฝั่ง server (args ที่ model ส่ง + ผลลัพธ์)
// ทั้งคู่ผ่าน recordLiveTranscriptTurns ตัวเดียว — ล้มเหลวต้องไม่กระทบบทสนทนา (ผู้เรียกกลืน error)
//
// ห้ามเก็บ: token/secret, activeCartId/cartVersion/summary ที่ server ฉีด (ไม่ใช่สิ่งที่ model พูด)

import type { SupabaseClient } from "@supabase/supabase-js";

export type LiveTranscriptRole = "user" | "assistant" | "tool";

export interface LiveTranscriptIdentity {
  readonly organizationId: string;
  readonly storeId: string;
  readonly userId: string;
  readonly sessionId: string;
}

export interface LiveTranscriptTurn {
  readonly role: LiveTranscriptRole;
  readonly content: string;
  readonly clientSeq?: number | null;
  readonly tool?: string | null;
  readonly providerItemId?: string | null;
  readonly metadata?: Record<string, unknown> | null;
}

export const LIVE_TRANSCRIPT_MAX_CONTENT = 4000;
const TABLE = "ai_live_conversation_turns";
/** โอกาสกวาดแถวหมดอายุต่อหนึ่งครั้งที่เขียน — ไม่มี cron ว่าง (Vercel Hobby เต็ม) จึงกวาดแบบฉวยโอกาส */
const SWEEP_PROBABILITY = 0.05;

export function truncateTranscript(text: string, max = LIVE_TRANSCRIPT_MAX_CONTENT): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** ข้อความสั้นอ่านง่ายของผลลัพธ์ tool — เก็บเต็มไว้ใน metadata อยู่แล้ว */
export function stringifyForTranscript(value: unknown, max = LIVE_TRANSCRIPT_MAX_CONTENT): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? "";
  } catch {
    text = "";
  }
  return truncateTranscript(text, max);
}

export interface LiveTranscriptRow {
  organization_id: string;
  store_id: string;
  user_id: string;
  session_id: string;
  role: LiveTranscriptRole;
  client_seq: number | null;
  content: string;
  tool: string | null;
  provider_item_id: string | null;
  metadata: Record<string, unknown> | null;
  expires_at: string;
}

export function buildLiveTranscriptRows(
  identity: LiveTranscriptIdentity,
  turns: readonly LiveTranscriptTurn[],
  options: { readonly retentionDays: number; readonly now?: number },
): LiveTranscriptRow[] {
  const expiresAt = new Date((options.now ?? Date.now()) + options.retentionDays * 24 * 60 * 60 * 1000).toISOString();
  return turns
    .map((turn) => ({ ...turn, content: truncateTranscript(turn.content) }))
    .filter((turn) => turn.content.length > 0)
    .map((turn) => ({
      organization_id: identity.organizationId,
      store_id: identity.storeId,
      user_id: identity.userId,
      session_id: identity.sessionId,
      role: turn.role,
      client_seq: typeof turn.clientSeq === "number" && Number.isSafeInteger(turn.clientSeq) && turn.clientSeq >= 0 ? turn.clientSeq : null,
      content: turn.content,
      tool: turn.tool ?? null,
      provider_item_id: turn.providerItemId ?? null,
      metadata: turn.metadata ?? null,
      expires_at: expiresAt,
    }));
}

/**
 * เขียนทีละแถว: แถวที่ชน unique (browser ส่งซ้ำ) ต้องไม่ทำให้แถวอื่นในชุดหายไปด้วย
 * คืนจำนวนแถวที่บันทึกใหม่จริง
 */
export async function recordLiveTranscriptTurns(
  client: SupabaseClient,
  identity: LiveTranscriptIdentity,
  turns: readonly LiveTranscriptTurn[],
  options: { readonly retentionDays: number; readonly now?: number; readonly random?: () => number },
): Promise<number> {
  const rows = buildLiveTranscriptRows(identity, turns, options);
  let stored = 0;
  for (const row of rows) {
    const { error } = await client.from(TABLE).insert(row);
    if (!error) {
      stored += 1;
      continue;
    }
    if (error.code === "23505") continue; // ส่งซ้ำ — มีแถวนี้อยู่แล้ว
    throw new Error("live transcript insert failed");
  }
  if ((options.random ?? Math.random)() < SWEEP_PROBABILITY) {
    await client.from(TABLE).delete().lt("expires_at", new Date(options.now ?? Date.now()).toISOString());
  }
  return stored;
}
