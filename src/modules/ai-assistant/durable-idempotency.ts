// PR3 — DurableIdempotencyStore: idempotency ที่อยู่รอดการ restart และปลอดภัยข้าม process
// โดยใช้ตาราง ai_assistant_actions (migration 20260916000000) เป็น ledger กลาง
//
// หลักการเดียวกับ MemoryIdempotencyStore แต่ atomic claim อาศัย UNIQUE (organization_id,
// idempotency_key) ของ DB แทนการจองใน Map:
//   1. insert แถว pending ก่อนแตะ execute เสมอ — สำเร็จ = เราเป็นเจ้าของคีย์นี้,
//      ชน unique = มีคนกำลังทำ/เคยทำแล้ว (ไม่มีช่องว่าง check-then-insert)
//   2. replay: แถวเดิม completed/failed + fingerprint เดิม + identity เดิม (store/user/session)
//      → คืนผลที่เก็บไว้; ต่าง fingerprint หรือต่าง identity → IDEMPOTENCY_CONFLICT
//      (fail-closed ไม่ execute ซ้ำ และไม่คายผลของ session อื่นให้ผู้เรียก)
//   3. pending ที่ยังไม่หมดอายุ → IDEMPOTENCY_PENDING เสมอ (in-flight ข้าม process หรือ
//      handler ตายกลางทาง) ห้ามเดาผลจนกว่า expires_at แล้วจึง reclaim ได้
//   4. reclaim: แถว pending ที่ expires_at ผ่านแล้ว = ต้นทางหมดอายุจริง (dispatcher ปฏิเสธ
//      context หมดอายุก่อนถึง store เสมอ และ session id ไม่ต่ออายุ) จึงลบแบบมีเงื่อนไข
//      (id + status=pending + expires_at เดิม) แล้วจองคีย์ใหม่ — ลบได้เฉพาะแถวที่ยืนยันว่า
//      หมดอายุ ณ ตอนลบ กันลบแถวใหม่ที่คนอื่นเพิ่งจอง
//   5. กวาดของหมดอายุแบบ opportunistic (sweepExpired) — retention = expiresAt ของ session
//      + retentionGraceMs (default 24 ชม.)
//
// ข้อต่างจาก memory store ที่ยอมรับได้: claim คีย์เดียวกันพร้อมกันข้าม process — ตัวแพ้ชน
// unique ได้ IDEMPOTENCY_PENDING แทนการรอผลของตัวชนะ (ใน process เดียว memory store รอได้)
// ยังเป็น fail-closed และ client ที่ส่งซ้ำภายหลังจะได้ replay
//
// recovery story เมื่อ handler ตายกลางทาง: แถวค้าง pending จน expires_at (มีเพดานชัดเจน
// เพราะ session ไม่ต่ออายุ) — replay ทุกเส้นทางได้ IDEMPOTENCY_PENDING ไม่ execute ซ้ำ
// หลังจากนั้น reclaim/sweep ทำความสะอาดเองโดยไม่ต้องมี cron (cron เรียก sweepExpired ได้ถ้าต้องการ)

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/server/integrations/supabase/database.types";
import { fail, type ErrorCode, type IdempotencyClaimMeta, type IdempotencyStore, type Result } from "./foundation";

type ActionRow = Database["public"]["Tables"]["ai_assistant_actions"]["Row"];
type ActionInsert = Database["public"]["Tables"]["ai_assistant_actions"]["Insert"];

/** Postgres unique_violation — สัญญาณว่าคีย์นี้ถูกเคลมอยู่หรือเคยเคลมแล้ว */
const UNIQUE_VIOLATION = "23505";
const DEFAULT_RETENTION_GRACE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;
const DEFAULT_SWEEP_BATCH_SIZE = 100;
/** เพดานรอบตัดสิน claim — reclaim/race ที่เป็นไปได้จริงจบใน 2-3 รอบ */
const MAX_RESOLVE_ATTEMPTS = 4;

export interface DurableIdempotencyStoreOptions {
  /** เก็บแถวต่อจากหมดอายุ session อีกเท่าไร (ms) — default 24 ชม. */
  retentionGraceMs?: number;
  /** ช่วงห่างขั้นต่ำระหว่างการกวาด opportunistic บน instance นี้ (ms) — default 60 วินาที */
  sweepIntervalMs?: number;
  /** จำนวนแถวสูงสุดต่อรอบกวาด — default 100 */
  sweepBatchSize?: number;
}

interface ClaimIdentity {
  readonly organizationId: string;
  readonly storeId: string;
  readonly userId: string;
  readonly sessionId: string;
}

function isIdentityPart(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function isClaimIdentity(value: unknown): value is ClaimIdentity {
  if (!value || typeof value !== "object") return false;
  const identity = value as Partial<Record<keyof ClaimIdentity, unknown>>;
  return isIdentityPart(identity.organizationId) && isIdentityPart(identity.storeId)
    && isIdentityPart(identity.userId) && isIdentityPart(identity.sessionId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** แปลง jsonb ที่เก็บไว้กลับเป็น Result — รูปทรงไม่ตรง = ข้อมูลเสียหาย ให้ throw (fail-closed)
 * คืนสำเนาใหม่ทุกครั้งเหมือน memory store เพื่อไม่ให้ผู้เรียกแก้ข้อมูลที่เก็บไว้ */
function parseStoredResult(value: unknown): Result {
  if (isRecord(value) && typeof value.ok === "boolean") {
    if (value.ok) return { ok: true, data: structuredClone(value.data ?? null) };
    if (typeof value.code === "string") return fail(value.code as ErrorCode);
  }
  throw Error("Corrupt stored idempotency result");
}

export class DurableIdempotencyStore implements IdempotencyStore {
  readonly durability = "supabase" as const;
  private readonly retentionGraceMs: number;
  private readonly sweepIntervalMs: number;
  private readonly sweepBatchSize: number;
  private lastSweepAt = 0;

  constructor(private readonly client: SupabaseClient<Database>, options: DurableIdempotencyStoreOptions = {}) {
    this.retentionGraceMs = options.retentionGraceMs ?? DEFAULT_RETENTION_GRACE_MS;
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.sweepBatchSize = options.sweepBatchSize ?? DEFAULT_SWEEP_BATCH_SIZE;
    if (!Number.isSafeInteger(this.retentionGraceMs) || this.retentionGraceMs < 0) throw Error("Invalid retention grace");
    if (!Number.isSafeInteger(this.sweepIntervalMs) || this.sweepIntervalMs < 0) throw Error("Invalid sweep interval");
    if (!Number.isSafeInteger(this.sweepBatchSize) || this.sweepBatchSize < 1) throw Error("Invalid sweep batch size");
  }

  async claim(key: string, fingerprint: string, meta: IdempotencyClaimMeta, execute: () => Promise<Result>): Promise<Result> {
    // ตรวจ meta เข้มเท่า memory store และ durable ต้องรู้ identity ครบจึงเทียบ replay ได้
    if (typeof meta?.scope !== "string" || meta.scope.length === 0 || !Number.isFinite(meta.expiresAt)) throw Error("Invalid idempotency claim");
    if (!isClaimIdentity(meta.identity)) throw Error("Durable idempotency claim requires identity");
    if (typeof key !== "string" || key.length === 0 || key.length > 128) throw Error("Invalid idempotency key");
    if (typeof fingerprint !== "string" || fingerprint.length === 0) throw Error("Invalid idempotency fingerprint");
    const identity = meta.identity;
    const newAction: ActionInsert = {
      id: randomUUID(),
      organization_id: identity.organizationId,
      store_id: identity.storeId,
      user_id: identity.userId,
      session_id: identity.sessionId,
      idempotency_key: key,
      tool: meta.tool ?? "unknown",
      fingerprint,
      status: "pending",
      result: null,
      expires_at: new Date(meta.expiresAt + this.retentionGraceMs).toISOString(),
    };
    await this.sweepExpiredOpportunistically();

    // ── atomic claim: insert pending ก่อน execute เสมอ ──
    if (await this.insertPendingAction(newAction)) return this.runOwnedClaim(newAction, execute);
    let existing = await this.findAction(identity.organizationId, key);
    if (!existing) {
      // แถวถูกกวาด/reclaim ระหว่าง insert ชนกับตอนอ่าน — ลองจองซ้ำได้อีกครั้งเดียว
      if (await this.insertPendingAction(newAction)) return this.runOwnedClaim(newAction, execute);
      existing = await this.findAction(identity.organizationId, key);
      if (!existing) throw Error("ai_assistant_actions row vanished during claim");
    }
    return this.resolveExistingClaim(existing, fingerprint, identity, newAction, execute);
  }

  /** กวาดแถวหมดอายุทั้งหมด (pending ค้าง, completed/failed ที่เก่ากว่า retention) — เรียกจาก cron ได้ */
  async sweepExpired(): Promise<number> {
    const cutoff = new Date().toISOString();
    const { data: expired, error } = await this.client
      .from("ai_assistant_actions")
      .select("id")
      .lte("expires_at", cutoff)
      .limit(this.sweepBatchSize);
    if (error) throw error;
    const ids = (expired ?? []).map(row => row.id);
    if (ids.length === 0) return 0;
    // ลบซ้ำด้วยเงื่อนไข expires_at เดิม — กันลบแถวที่เพิ่งถูก reclaim (expires_at ใหม่) ไปแล้ว
    const { data: deleted, error: deleteError } = await this.client
      .from("ai_assistant_actions")
      .delete()
      .in("id", ids)
      .lte("expires_at", cutoff)
      .select("id");
    if (deleteError) throw deleteError;
    return (deleted ?? []).length;
  }

  private async runOwnedClaim(action: ActionInsert, execute: () => Promise<Result>): Promise<Result> {
    let result: Result;
    try {
      result = await execute();
    } catch {
      result = fail("EXECUTION_FAILED");
    }
    try {
      const { error } = await this.client
        .from("ai_assistant_actions")
        .update({
          status: result.ok ? "completed" : "failed",
          // เก็บสำเนาแยกจาก object ที่คืนให้ผู้เรียก — ผู้เรียกแก้ผลหลังรับไม่กระทบของที่เก็บ
          // proposal (kind: "proposal") ไม่มีวันมาถึงที่นี่ — dispatcher คืนการ์ดก่อนถึงชั้น claim
          // ถ้าวันหนึ่งมันมาถึงจริง แปลว่าลำดับใน dispatcher เปลี่ยน จึงเก็บเป็น failed ไว้ก่อน
          // (fail-closed) ดีกว่าเก็บแถว completed ที่ไม่มีผลลัพธ์จริงให้ replay หยิบไปใช้
          result: (result.ok && !("kind" in result)
            ? { ok: true, data: structuredClone(result.data) }
            : { ok: false, code: result.ok ? "EXECUTION_FAILED" : result.code }) as Json,
        })
        .eq("id", action.id as string)
        .eq("status", "pending");
      if (error) throw error;
    } catch {
      // บันทึกผลไม่สำเร็จ (DB สะดุดหลัง execute) — คืนผลจริงให้ผู้เรียก แต่แถวค้าง pending:
      // replay ทุกเส้นทางจะได้ IDEMPOTENCY_PENDING (fail-closed ไม่ execute ซ้ำ) จนกว่ารอบกวาดจะเก็บ
      // ข้อแลกเปลี่ยนที่ตั้งใจ: ไม่ลบแถวทิ้งหลัง execute ผ่านไปแล้ว เพื่อไม่เปิดช่อง execute ซ้ำ
    }
    return result;
  }

  private async resolveExistingClaim(
    initial: ActionRow,
    fingerprint: string,
    identity: ClaimIdentity,
    newAction: ActionInsert,
    execute: () => Promise<Result>,
  ): Promise<Result> {
    const key = newAction.idempotency_key as string;
    let existing = initial;
    for (let attempt = 0; attempt < MAX_RESOLVE_ATTEMPTS; attempt += 1) {
      // ── completed/failed: replay ได้เฉพาะ fingerprint เดิม + identity เดิมของ session นี้ ──
      if (existing.status !== "pending") {
        if (existing.fingerprint !== fingerprint || existing.store_id !== identity.storeId
          || existing.user_id !== identity.userId || existing.session_id !== identity.sessionId) {
          return fail("IDEMPOTENCY_CONFLICT");
        }
        return parseStoredResult(existing.result);
      }
      if (Date.parse(existing.expires_at) > Date.now()) return fail("IDEMPOTENCY_PENDING");
      // ── reclaim: แถว pending ที่หมดอายุแล้ว = ต้นทางหมดอายุจริง (gate ปฏิเสธ context
      // หมดอายุเสมอ และ session id ไม่ต่ออายุ) จึงลบแบบมีเงื่อนไขแล้วจองคีย์ใหม่ได้
      if (await this.deleteExpiredPendingAction(existing.id) && await this.insertPendingAction(newAction)) {
        return this.runOwnedClaim(newAction, execute);
      }
      // แพ้ race การ reclaim/re-claim → อ่านแถวผู้ชนะมาตัดสินใหม่ (แถวใหม่ pending ล่วงหน้า
      // หรือ completed/failed เสมอ เพราะผู้ชนะเพิ่งจองด้วย expires_at อนาคต)
      const winner = await this.findAction(identity.organizationId, key);
      if (winner) {
        existing = winner;
        continue;
      }
      // แถวหายไปจริง (ถูกกวาดระหว่างทาง) — จองใหม่ได้
      if (await this.insertPendingAction(newAction)) return this.runOwnedClaim(newAction, execute);
      existing = await this.findAction(identity.organizationId, key) as ActionRow;
      if (!existing) throw Error("ai_assistant_actions row vanished during reclaim");
    }
    throw Error("ai_assistant_actions claim did not settle");
  }

  private async insertPendingAction(action: ActionInsert): Promise<boolean> {
    const { error } = await this.client.from("ai_assistant_actions").insert(action);
    if (!error) return true;
    if (error.code === UNIQUE_VIOLATION) return false;
    throw error;
  }

  private async findAction(organizationId: string, key: string): Promise<ActionRow | null> {
    const { data, error } = await this.client
      .from("ai_assistant_actions")
      .select("*")
      .eq("organization_id", organizationId)
      .eq("idempotency_key", key)
      .maybeSingle();
    if (error) throw error;
    return (data as ActionRow | null) ?? null;
  }

  private async deleteExpiredPendingAction(id: string): Promise<boolean> {
    const { data, error } = await this.client
      .from("ai_assistant_actions")
      .delete()
      .eq("id", id)
      .eq("status", "pending")
      .lte("expires_at", new Date().toISOString())
      .select("id");
    if (error) throw error;
    return (data ?? []).length > 0;
  }

  private async sweepExpiredOpportunistically(): Promise<void> {
    const now = Date.now();
    if (now - this.lastSweepAt < this.sweepIntervalMs) return;
    this.lastSweepAt = now;
    try {
      await this.sweepExpired();
    } catch {
      // กวาดไม่สำเร็จ = แถวเก่าอยู่ต่อ ไม่กระทบความถูกต้องของ claim (atomicity มาจาก unique constraint)
    }
  }
}
