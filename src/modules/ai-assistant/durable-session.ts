// P0 — DurableAssistantSessionStore: session/terminal registry ที่อยู่รอดข้าม instance
// โดยใช้ตาราง ai_assistant_sessions (migration 20260922000000)
//
// ต่างจาก createAssistantSessionStore (หน่วยความจำ) สองเรื่องที่เป็นเหตุผลของไฟล์นี้:
//
//   1. **อยู่รอดข้าม process** — serverless สร้าง instance ใหม่บ่อย ของเดิมจึงคืน session ใหม่
//      ให้คนเดิมเรื่อย ๆ ทำให้ replay โดน IDEMPOTENCY_CONFLICT และ cart binding หาย
//   2. **แยกตาม device** — คีย์คือ (org, store, user, device) ไม่ใช่ (org, store, user)
//      หลายแท็บ/หลายเครื่องของคนเดียวกันจึงมี session และ cart binding ของตัวเอง
//      (ของเดิมหนึ่ง user = หนึ่ง session ⇒ แท็บที่สองผูกตะกร้าไม่ได้ = CONTEXT_UNAVAILABLE)
//
// กติกาของ cart binding ไม่เปลี่ยนเลย (ผูกใบเดียวตลอดอายุ, version ห้ามย้อนหลัง) แต่ย้าย
// การบังคับไปอยู่ใน UPDATE แบบมีเงื่อนไขคำสั่งเดียว จึง atomic ข้าม process — ของเดิมเป็น
// check-then-set ซึ่งถูกต้องเฉพาะตอนมี process เดียว
//
// ทุกเส้นทางที่ตัดสินไม่ได้ = ปฏิเสธ (คืน null → dispatcher ตอบ CONTEXT_UNAVAILABLE)
// ไม่มีเส้นทางไหนที่ "เดาแล้วปล่อยผ่าน" เพราะปลายทางคือคำสั่งที่เขียนข้อมูลจริงของร้าน

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/server/integrations/supabase/database.types";
import type { CartBinding } from "./foundation";
import type { AssistantIdentity, AssistantServerSession } from "./server";
import type { AssistantSessionContext, AssistantSessionStore } from "./session";

type SessionRow = Database["public"]["Tables"]["ai_assistant_sessions"]["Row"];

/** Postgres unique_violation — แปลว่ามีคนสร้าง session ของเครื่องนี้ไปแล้วระหว่างที่เรากำลังสร้าง */
const UNIQUE_VIOLATION = "23505";
const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;
const DEFAULT_SWEEP_BATCH_SIZE = 100;
/** รูปแบบเดียวกับ ACTIVE_CART_ID_PATTERN และ CHECK ใน migration — ตรวจให้ตรงกันทั้งสองฝั่ง */
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const MAX_IDENTITY_PART = 128;
/** เพดานรอบตัดสินตอนสร้าง session — แข่งกันสร้างจริงจบใน 2 รอบ */
const MAX_RESOLVE_ATTEMPTS = 3;

export interface DurableAssistantSessionStoreOptions {
  readonly sessionTtlMs?: number;
  readonly allowedTools?: readonly string[];
  readonly sweepIntervalMs?: number;
  readonly sweepBatchSize?: number;
  readonly clock?: () => number;
}

function isValidIdentityPart(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_IDENTITY_PART;
}

/**
 * เครื่องที่ไม่ได้ส่ง device id มา ใช้ค่าประจำตัวผู้ใช้แทน
 *
 * ทำให้ client เก่าที่ยังไม่ส่ง header ทำงานเหมือนเดิมทุกประการ (หนึ่ง user = หนึ่ง session)
 * แทนที่จะพังทั้งหมด
 *
 * client ที่จงใจส่งค่านี้มาเองจะไปใช้ session ร่วมกับ client เก่าของผู้ใช้คนเดียวกัน
 * ซึ่งแย่ที่สุดเท่ากับพฤติกรรมเดิมก่อนมี registry — ไม่ข้ามเขตไปหาผู้ใช้อื่นเพราะคีย์ยัง
 * มี (org, store, user) ครบ จึงไม่ต้องกันด้วยคำนำหน้าพิเศษให้ซับซ้อนกว่าที่จำเป็น
 */
export const LEGACY_DEVICE_ID = "legacy-single-terminal";

export function normalizeDeviceId(value: unknown): string {
  return typeof value === "string" && OPAQUE_ID_PATTERN.test(value) ? value : LEGACY_DEVICE_ID;
}

function toSession(row: SessionRow, allowedTools: readonly string[]): AssistantServerSession {
  return Object.freeze({
    organizationId: row.organization_id,
    storeId: row.store_id,
    userId: row.user_id,
    id: row.session_id,
    expiresAt: Date.parse(row.expires_at),
    allowedTools,
  });
}

export class DurableAssistantSessionStore implements AssistantSessionStore {
  private readonly ttlMs: number;
  private readonly allowedTools: readonly string[];
  private readonly sweepIntervalMs: number;
  private readonly sweepBatchSize: number;
  private readonly clock: () => number;
  private lastSweepAt = 0;

  constructor(
    private readonly client: SupabaseClient<Database>,
    options: DurableAssistantSessionStoreOptions = {},
  ) {
    this.ttlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.allowedTools = Object.freeze([...(options.allowedTools ?? [])]);
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.sweepBatchSize = options.sweepBatchSize ?? DEFAULT_SWEEP_BATCH_SIZE;
    this.clock = options.clock ?? (() => Date.now());
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1) throw new Error("Invalid session TTL");
  }

  /**
   * คืน session ของเครื่องนี้ — มีอยู่และยังไม่หมดอายุก็ใช้ตัวเดิม ไม่งั้นสร้างใหม่
   *
   * **ไม่ต่ออายุ session เดิม** โดยตั้งใจ ตาม contract ที่มีมาตั้งแต่ PR1: อายุคงที่ทำให้
   * idempotency ledger มีเพดานเวลาที่คำนวณได้ และ pending ที่ค้างมีวันหมดอายุแน่นอน
   */
  async resolve(identity: AssistantIdentity): Promise<AssistantServerSession> {
    if (!isValidIdentityPart(identity?.organizationId) || !isValidIdentityPart(identity?.storeId)
      || !isValidIdentityPart(identity?.userId)) throw new Error("Invalid assistant identity");
    const deviceId = normalizeDeviceId(identity.deviceId);

    for (let attempt = 0; attempt < MAX_RESOLVE_ATTEMPTS; attempt += 1) {
      const { data: existing, error: readError } = await this.client
        .from("ai_assistant_sessions")
        .select("*")
        .eq("organization_id", identity.organizationId)
        .eq("store_id", identity.storeId)
        .eq("user_id", identity.userId)
        .eq("device_id", deviceId)
        .maybeSingle();
      if (readError) throw new Error("Assistant session lookup failed");
      if (existing && Date.parse(existing.expires_at) > this.clock()) {
        void this.sweepExpired();
        return toSession(existing, this.allowedTools);
      }

      // หมดอายุแล้ว: ลบแบบมีเงื่อนไข (id + expires_at เดิม) แล้วค่อยสร้างใหม่ —
      // เงื่อนไข expires_at กันลบ session ใหม่ที่เครื่องอื่นเพิ่งสร้างแทนที่แถวเดิมไปแล้ว
      if (existing) {
        await this.client
          .from("ai_assistant_sessions")
          .delete()
          .eq("id", existing.id)
          .eq("expires_at", existing.expires_at);
      }

      const { data: created, error: insertError } = await this.client
        .from("ai_assistant_sessions")
        .insert({
          organization_id: identity.organizationId,
          store_id: identity.storeId,
          user_id: identity.userId,
          device_id: deviceId,
          session_id: randomUUID(),
          expires_at: new Date(this.clock() + this.ttlMs).toISOString(),
        })
        .select("*")
        .single();
      if (!insertError && created) {
        void this.sweepExpired();
        return toSession(created, this.allowedTools);
      }
      // มีคนสร้าง session ของเครื่องนี้ชนะเราไประหว่างทาง — วนไปอ่านของเขามาใช้
      if ((insertError as { code?: string } | null)?.code !== UNIQUE_VIOLATION) {
        throw new Error("Assistant session create failed");
      }
    }
    throw new Error("Assistant session unavailable");
  }

  /**
   * ผูก/ยืนยันตะกร้าของ session นี้ด้วย UPDATE แบบมีเงื่อนไขคำสั่งเดียว
   *
   * เงื่อนไขทั้งหมดอยู่ใน WHERE จึงตัดสินที่ฐานข้อมูลครั้งเดียว ไม่มีช่องว่างระหว่าง
   * "ตรวจ" กับ "เขียน" ให้ request อื่นแทรก — ได้ 0 แถว = ปฏิเสธ ไม่ต้องแยกแยะว่าแพ้
   * เงื่อนไขข้อไหน เพราะทุกข้อจบที่การปฏิเสธเหมือนกัน
   *
   * `.is("bound_cart_id", null)` ต้องแยกเป็น query ที่สองเพราะ PostgREST เขียน
   * "null หรือเท่ากับค่านี้" ในคำสั่งเดียวไม่ได้ — ลำดับคือลองผูกใบเดิมก่อน (เส้นทางปกติ)
   * แล้วค่อยลองผูกใบแรก ทั้งสองคำสั่งยังเป็น conditional update เดี่ยว ๆ จึงยัง atomic
   */
  async bindCart(
    context: AssistantSessionContext,
    activeCartId: unknown,
    cartVersion: unknown,
  ): Promise<CartBinding | null> {
    if (!context || !isValidIdentityPart(context.sessionId)) return null;
    if (typeof activeCartId !== "string" || !OPAQUE_ID_PATTERN.test(activeCartId)) return null;
    if (typeof cartVersion !== "number" || !Number.isSafeInteger(cartVersion) || cartVersion < 0) return null;

    const nowIso = new Date(this.clock()).toISOString();
    const patch = { bound_cart_id: activeCartId, last_cart_version: cartVersion };
    const scope = () =>
      this.client
        .from("ai_assistant_sessions")
        .update(patch)
        .eq("session_id", context.sessionId)
        // session ต้องเป็นของ identity เดียวกับ context เสมอ — กัน session id ของคนอื่นถูกยื่นเข้ามา
        .eq("organization_id", context.organizationId)
        .eq("store_id", context.storeId)
        .eq("user_id", context.userId)
        .gt("expires_at", nowIso)
        // version ย้อนหลัง = คำสั่งค้างเก่าจากสถานะก่อนหน้าของตะกร้า
        .lte("last_cart_version", cartVersion);

    // เส้นทางปกติ: ตะกร้าใบเดิมของ session นี้
    const bound = await scope().eq("bound_cart_id", activeCartId).select("session_id").maybeSingle();
    if (bound.error) return null;
    if (bound.data) return { activeCartId, cartVersion };

    // ครั้งแรกของ session: ยังไม่เคยผูกใบไหน
    const first = await scope().is("bound_cart_id", null).select("session_id").maybeSingle();
    if (first.error || !first.data) return null;
    return { activeCartId, cartVersion };
  }

  /**
   * กวาด session ที่หมดอายุแบบ opportunistic — ล้มเหลวเงียบเสมอ
   *
   * ความถูกต้องไม่ได้พึ่งการกวาด (ทุกเส้นทางเทียบ expires_at อยู่แล้ว) นี่เป็นแค่การ
   * ไม่ปล่อยให้ตารางโต จึงห้ามทำให้ request ของผู้ใช้ล้มเด็ดขาด
   */
  private async sweepExpired(): Promise<void> {
    const now = this.clock();
    if (now - this.lastSweepAt < this.sweepIntervalMs) return;
    this.lastSweepAt = now;
    try {
      const { data } = await this.client
        .from("ai_assistant_sessions")
        .select("id")
        .lt("expires_at", new Date(now).toISOString())
        .limit(this.sweepBatchSize);
      const ids = (data ?? []).map((row) => row.id);
      if (ids.length > 0) await this.client.from("ai_assistant_sessions").delete().in("id", ids);
    } catch {
      // infra outage — ไม่กระทบผลลัพธ์ของ request
    }
  }
}
