// P1 — ที่เก็บข้อเสนอรอยืนยันแบบ durable (ตาราง ai_assistant_proposals)
//
// ระหว่าง "เสนอ" กับ "ยืนยัน" มีคนละ request คั่นอยู่ และบน serverless อาจคนละ instance
// ข้อเสนอจึงอยู่ในหน่วยความจำไม่ได้ — ผู้ใช้จะกดยืนยันแล้วเจอ "ไม่พบข้อเสนอ" เป็นระยะ
// โดยไม่มีรูปแบบที่อธิบายได้

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/server/integrations/supabase/database.types";
import type { ProposalRecord, ProposalStore } from "./proposal";

export class DurableProposalStore implements ProposalStore {
  constructor(private readonly client: SupabaseClient<Database>) {}

  async save(record: ProposalRecord): Promise<void> {
    const { error } = await this.client.from("ai_assistant_proposals").insert({
      id: record.id,
      organization_id: record.organizationId,
      store_id: record.storeId,
      user_id: record.userId,
      session_id: record.sessionId,
      tool: record.tool,
      args: (record.args ?? null) as Json,
      draft_fingerprint: record.draftFingerprint,
      expires_at: new Date(record.expiresAt).toISOString(),
    });
    // เก็บไม่ได้ = ห้ามคืนการ์ดให้ผู้ใช้ เพราะกดยืนยันแล้วจะหาข้อเสนอไม่เจอ
    if (error) throw new Error("Assistant proposal save failed");
  }

  async load(id: string): Promise<ProposalRecord | null> {
    const { data, error } = await this.client
      .from("ai_assistant_proposals")
      .select("*")
      .eq("id", id)
      // ใช้ไปแล้วถือว่าไม่มี — ผู้เรียกจัดการเหมือนกันหมด (เสนอใหม่)
      .is("consumed_at", null)
      .maybeSingle();
    if (error) throw new Error("Assistant proposal lookup failed");
    if (!data) return null;
    return {
      id: data.id,
      organizationId: data.organization_id,
      storeId: data.store_id,
      userId: data.user_id,
      sessionId: data.session_id,
      tool: data.tool,
      args: data.args,
      draftFingerprint: data.draft_fingerprint,
      expiresAt: Date.parse(data.expires_at),
    };
  }

  /**
   * ทำเครื่องหมายว่าใช้แล้ว แบบมีเงื่อนไข `consumed_at is null` ในคำสั่งเดียว
   *
   * ได้ 0 แถว = มีคนกดยืนยันชนะเราไปแล้ว (กดรัว/สองแท็บ) ⇒ คืน false และผู้เรียกจะไม่
   * execute — ไม่มีช่องว่างระหว่าง "ตรวจว่ายังไม่ถูกใช้" กับ "ทำเครื่องหมายว่าใช้แล้ว"
   */
  async consume(id: string): Promise<boolean> {
    const { data, error } = await this.client
      .from("ai_assistant_proposals")
      .update({ consumed_at: new Date().toISOString() })
      .eq("id", id)
      .is("consumed_at", null)
      .select("id")
      .maybeSingle();
    if (error) return false;
    return Boolean(data);
  }
}
