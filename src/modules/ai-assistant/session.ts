// PR2 — assistant session + cart binding ฝั่ง server (ไม่แตะ DB, additive)
//
// ทำไมต้องมีไฟล์นี้:
//   - ยังไม่มี device/terminal registry ที่เชื่อถือได้ (ดู docs/ai-assistant/repo-audit.md ข้อ 13)
//     MVP จึงรับ activeCartId จาก UI แล้ว "server ตรวจว่าอยู่ใน scope ของ session นี้จริง"
//     ไม่ใช่เชื่อค่าที่ client ส่งมาตรง ๆ (plan v2 §9)
//   - ตะกร้าจริงเป็น state ในเครื่องของหน้าขาย (voice-cart-bridge) ไฟล์นี้ไม่ได้ถือ cart
//     ทำหน้าที่แค่ "ผูก session ↔ ตะกร้าใบเดียว" และกัน replay เก่าด้วย cart version
//
// ข้อจำกัดที่ยอมรับใน MVP (บันทึกใน checkpoint):
//   - เก็บในหน่วยความจำของ process เดียว: restart/หลาย instance = session ใหม่ (session id ต่อ process —
//     idempotency ledger เป็น durable (supabase) แล้ว แต่ replay ข้าม instance/restart จะโดน
//     IDEMPOTENCY_CONFLICT เพราะ session_id ไม่ตรง — fail-closed กัน execute ซ้ำ แก้จริงด้วย device/terminal registry)
//   - TTL คงที่ ไม่ต่ออายุด้วย session id เดิม (ตาม contract ที่ค้างจาก PR1) — หมดอายุแล้วได้ session id ใหม่
//     ซึ่งหมายถึง idempotency scope ใหม่; client จึงต้องกันการ apply ซ้ำที่ชั้น UI ด้วย cart version/การเทียบตะกร้า

import { randomUUID } from "node:crypto";
import type { CartBinding } from "./foundation";
import type { AssistantIdentity, AssistantServerSession } from "./server";

/** รูปแบบ id ตะกร้าที่รับได้ — client เป็นคนสร้าง แต่ต้องเป็น opaque id ที่ไม่ใช่ค่าที่มีความหมายอื่น */
const ACTIVE_CART_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 500;
const MAX_IDENTITY_PART = 128;

export interface AssistantSessionContext {
  readonly organizationId: string;
  readonly storeId: string;
  readonly userId: string;
  readonly sessionId: string;
}

export interface AssistantSessionStoreOptions {
  /** อายุ session คงที่ต่อ session (ไม่ต่ออายุ) */
  readonly sessionTtlMs?: number;
  /** เพดานจำนวน session ในหน่วยความจำ — เกินแล้ว evict ตัวที่จะหมดอายุเร็วสุด ถ้ายังเต็มก็ fail closed */
  readonly maxSessions?: number;
  /** tool allowlist ที่ผูกตอนสร้าง session */
  readonly allowedTools?: readonly string[];
  readonly clock?: () => number;
}

interface SessionRecord {
  readonly session: AssistantServerSession;
  /** ตะกร้าที่ session นี้ผูกไว้ (ผูกได้ใบเดียวตลอดอายุ session) */
  boundCartId: string | null;
  /** version ล่าสุดที่เคยผ่านการตรวจ — กัน replay ที่เก่ากว่าที่เคยเห็น */
  lastCartVersion: number;
}

function isValidIdentityPart(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_IDENTITY_PART;
}

function identityKey(identity: AssistantIdentity): string {
  return JSON.stringify([identity.organizationId, identity.storeId, identity.userId]);
}

export interface AssistantSessionStore {
  /** resolver ที่ส่งให้ createServerAssistantDispatcher ได้ตรง ๆ — identity มาจาก auth ฝั่ง server เท่านั้น */
  readonly resolve: (identity: AssistantIdentity) => Promise<AssistantServerSession>;
  /**
   * ตรวจ binding ของตะกร้า: session ต้องมีจริง ยังไม่หมดอายุ เป็นของ identity ใน context และ
   * activeCartId ต้องตรงใบที่ผูกไว้ (ใบแรกผูกเลย ใบอื่นปฏิเสธ) + version ต้องไม่ย้อนหลัง
   * คืน null = ปฏิเสธ (dispatcher จะตอบ CONTEXT_UNAVAILABLE)
   */
  readonly bindCart: (
    context: AssistantSessionContext,
    activeCartId: unknown,
    cartVersion: unknown,
  ) => CartBinding | null;
  readonly size: () => number;
}

export function createAssistantSessionStore(
  options: AssistantSessionStoreOptions = {},
): AssistantSessionStore {
  const ttlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const allowedTools = Object.freeze([...(options.allowedTools ?? [])]);
  const clock = options.clock ?? (() => Date.now());
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new Error("Invalid session TTL");
  if (!Number.isSafeInteger(maxSessions) || maxSessions < 1) throw new Error("Invalid session capacity");
  for (const tool of allowedTools) if (typeof tool !== "string" || tool.length === 0) throw new Error("Invalid allowed tool");

  const byIdentity = new Map<string, SessionRecord>();
  const bySessionId = new Map<string, SessionRecord>();

  function drop(record: SessionRecord): void {
    bySessionId.delete(record.session.id);
    for (const [key, candidate] of byIdentity) {
      if (candidate === record) byIdentity.delete(key);
    }
  }

  function evictExpired(now: number): void {
    for (const record of [...byIdentity.values()]) {
      if (record.session.expiresAt <= now) drop(record);
    }
  }

  function resolve(identity: AssistantIdentity): AssistantServerSession {
    if (!isValidIdentityPart(identity?.organizationId) || !isValidIdentityPart(identity?.storeId)
      || !isValidIdentityPart(identity?.userId)) throw new Error("Invalid assistant identity");
    const now = clock();
    evictExpired(now);

    const key = identityKey(identity);
    const existing = byIdentity.get(key);
    if (existing) return existing.session;

    if (byIdentity.size >= maxSessions) {
      // เต็มจริงด้วย live session = fail closed (เหมือน MemoryIdempotencyStore ที่ปฏิเสธแทน evict ของมีชีวิต)
      // session ที่หมดอายุถูก evict ไปแล้วใน evictExpired ก่อนถึงจุดนี้
      throw new Error("Assistant session capacity exceeded");
    }

    const record: SessionRecord = {
      session: Object.freeze({
        organizationId: identity.organizationId,
        storeId: identity.storeId,
        userId: identity.userId,
        id: randomUUID(),
        expiresAt: now + ttlMs,
        allowedTools,
      }),
      boundCartId: null,
      lastCartVersion: 0,
    };
    byIdentity.set(key, record);
    bySessionId.set(record.session.id, record);
    return record.session;
  }

  function bindCart(
    context: AssistantSessionContext,
    activeCartId: unknown,
    cartVersion: unknown,
  ): CartBinding | null {
    if (!context || !isValidIdentityPart(context.sessionId)) return null;
    const record = bySessionId.get(context.sessionId);
    if (!record) return null;
    if (record.session.expiresAt <= clock()) {
      drop(record);
      return null;
    }
    // session ต้องเป็นของ identity เดียวกับ context เสมอ — กัน sessionId ของคนอื่นถูกยื่นเข้ามา
    if (record.session.organizationId !== context.organizationId
      || record.session.storeId !== context.storeId
      || record.session.userId !== context.userId) return null;

    if (typeof activeCartId !== "string" || !ACTIVE_CART_ID_PATTERN.test(activeCartId)) return null;
    if (typeof cartVersion !== "number" || !Number.isSafeInteger(cartVersion) || cartVersion < 0) return null;
    // ตะกร้าหนึ่ง session ผูกได้ใบเดียว: เปลี่ยนใบกลาง session = คำสั่งตกค้างชี้ผิดตะกร้า
    if (record.boundCartId !== null && record.boundCartId !== activeCartId) return null;
    // version ย้อนหลัง = คำสั่งที่ค้างเก่าจากตะกร้าสถานะก่อนหน้า
    if (cartVersion < record.lastCartVersion) return null;

    record.boundCartId = activeCartId;
    record.lastCartVersion = cartVersion;
    return { activeCartId, cartVersion };
  }

  return { resolve: async (identity) => resolve(identity), bindCart, size: () => byIdentity.size };
}
