// PR3-Live (M3/M4) — เซสชันเสียงสดฝั่ง server + HMAC session token
//
// หน้าที่:
//   - คุม concurrent cap ต่อร้าน (จำกัดจำนวนเซสชัน Live ที่เปิดพร้อมกันต่อ org|store)
//   - คุม tool call cap ต่อเซสชัน (นับ "ความพยายามเรียก tool" รวมที่ถูกปฏิเสธ — กัน loop)
//   - จด startedAt/expiresAt เพื่อ metering (วินาทีเซสชัน) และปิดเองเมื่อหมดอายุ
//   - session token (HMAC) ให้ browser ใช้ยืนยันต่อ route relay ได้โดยไม่ต้องเก็บคุกกี้อื่น
//     token ออกจาก server เท่านั้น ตรวจด้วย timing-safe compare และผูก session id ตายตัว
//
// ข้อจำกัด MVP (บันทึกใน checkpoint): เก็บในหน่วยความจำของ process เดียว เหมือน assistant
// session store เดิม — restart/instance ใหม่ = เซสชัน Live หาย (browser จะได้ session ใหม่ตอนกดปุ่มซ้ำ)

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

const ACTIVE_CART_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const MAX_IDENTITY_PART = 128;
const TOKEN_INFO = "ai-assistant-live-v1";

export interface LiveSessionIdentity {
  readonly organizationId: string;
  readonly storeId: string;
  readonly userId: string;
}

/** snapshot แบบอ่านอย่างเดียว — ตัวนับ tool call อยู่ใน store เสมอ ห้ามให้ผู้เรียกแก้ */
export interface LiveSession {
  readonly id: string;
  readonly organizationId: string;
  readonly storeId: string;
  readonly userId: string;
  /** ตะกร้าที่ผูกตอนเปิดเซสชัน (1 ใบตลอดอายุ — รูปแบบเดียวกับ cart binding ของโหมดข้อความ) */
  readonly activeCartId: string;
  readonly allowedTools: readonly string[];
  readonly startedAt: number;
  readonly expiresAt: number;
  readonly maxToolCalls: number;
}

export interface LiveSessionEndSummary {
  readonly session: LiveSession;
  readonly toolCallsUsed: number;
  /** วินาทีที่เซสชันมีชีวิต (ปัดเศษขึ้น) ใช้เป็น metering ตอนจบ */
  readonly sessionSeconds: number;
}

export interface LiveSessionStoreOptions {
  readonly maxConcurrentPerStore: number;
  readonly maxToolCallsPerSession: number;
  readonly clock?: () => number;
}

export interface LiveSessionStore {
  readonly create: (
    identity: LiveSessionIdentity,
    options: { ttlMs: number; activeCartId: string; allowedTools: readonly string[] },
  ) => { ok: true; session: LiveSession } | { ok: false; reason: "invalid_identity" | "invalid_cart" | "invalid_options" | "store_busy" };
  /** หมดอายุแล้ว = drop ทิ้งแล้วคืน null (ผู้เรียกตอบ typed error ไม่ต่ออายุเด็ดขาด) */
  readonly get: (sessionId: string) => LiveSession | null;
  readonly consumeToolCall: (sessionId: string) => { ok: true; used: number } | { ok: false; reason: "unknown_session" | "cap_reached" };
  readonly end: (sessionId: string) => LiveSessionEndSummary | null;
  readonly size: () => number;
}

function isValidIdentityPart(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_IDENTITY_PART;
}

function storeKey(identity: LiveSessionIdentity): string {
  return JSON.stringify([identity.organizationId, identity.storeId]);
}

export function createLiveSessionStore(options: LiveSessionStoreOptions): LiveSessionStore {
  const clock = options.clock ?? (() => Date.now());
  if (!Number.isSafeInteger(options.maxConcurrentPerStore) || options.maxConcurrentPerStore < 1) throw new Error("Invalid concurrent cap");
  if (!Number.isSafeInteger(options.maxToolCallsPerSession) || options.maxToolCallsPerSession < 1) throw new Error("Invalid tool call cap");

  const sessions = new Map<string, { session: LiveSession; toolCallsUsed: number }>();
  const perStore = new Map<string, Set<string>>();

  function evictExpired(now: number): void {
    for (const [id, record] of sessions) {
      if (record.session.expiresAt > now) continue;
      sessions.delete(id);
      perStore.get(storeKey(record.session))?.delete(id);
    }
  }

  function drop(sessionId: string): void {
    const record = sessions.get(sessionId);
    if (!record) return;
    sessions.delete(sessionId);
    perStore.get(storeKey(record.session))?.delete(sessionId);
  }

  return {
    create(identity, createOptions) {
      if (!identity || !isValidIdentityPart(identity.organizationId) || !isValidIdentityPart(identity.storeId)
        || !isValidIdentityPart(identity.userId)) return { ok: false, reason: "invalid_identity" };
      if (typeof createOptions.activeCartId !== "string" || !ACTIVE_CART_ID_PATTERN.test(createOptions.activeCartId)) {
        return { ok: false, reason: "invalid_cart" };
      }
      const { ttlMs, allowedTools } = createOptions;
      if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || !Array.isArray(allowedTools) || allowedTools.some((tool) => typeof tool !== "string" || tool.length === 0)) {
        return { ok: false, reason: "invalid_options" };
      }
      const now = clock();
      evictExpired(now);
      const key = storeKey(identity);
      const active = perStore.get(key);
      if (active && active.size >= options.maxConcurrentPerStore) return { ok: false, reason: "store_busy" };

      const session: LiveSession = Object.freeze({
        id: randomUUID(),
        organizationId: identity.organizationId,
        storeId: identity.storeId,
        userId: identity.userId,
        activeCartId: createOptions.activeCartId,
        allowedTools: Object.freeze([...allowedTools]),
        startedAt: now,
        expiresAt: now + ttlMs,
        maxToolCalls: options.maxToolCallsPerSession,
      });
      sessions.set(session.id, { session, toolCallsUsed: 0 });
      const set = perStore.get(key) ?? new Set<string>();
      set.add(session.id);
      perStore.set(key, set);
      return { ok: true, session };
    },
    get(sessionId) {
      const record = sessions.get(sessionId);
      if (!record) return null;
      if (record.session.expiresAt <= clock()) {
        drop(sessionId);
        return null;
      }
      return record.session;
    },
    consumeToolCall(sessionId) {
      const record = sessions.get(sessionId);
      if (!record) return { ok: false, reason: "unknown_session" };
      if (record.session.expiresAt <= clock()) {
        drop(sessionId);
        return { ok: false, reason: "unknown_session" };
      }
      if (record.toolCallsUsed >= record.session.maxToolCalls) return { ok: false, reason: "cap_reached" };
      record.toolCallsUsed += 1;
      return { ok: true, used: record.toolCallsUsed };
    },
    end(sessionId) {
      const record = sessions.get(sessionId);
      if (!record) return null;
      drop(sessionId);
      const now = clock();
      const seconds = Math.max(1, Math.ceil((Math.min(now, record.session.expiresAt) - record.session.startedAt) / 1000));
      return { session: record.session, toolCallsUsed: record.toolCallsUsed, sessionSeconds: seconds };
    },
    size: () => sessions.size,
  };
}

// ── session token (HMAC) ─────────────────────────────────────────────────────

/**
 * ความลับของ session token — server เท่านั้น
 * ใช้ AI_ASSISTANT_LIVE_TOKEN_SECRET ถ้าตั้งไว้ (แนะนำสำหรับ production เพื่อไม่ผูกกับ provider key)
 * ไม่งั้นถอยไปใช้ OPENAI_API_KEY ซึ่งเป็น server-only ตามข้อบังคับของ Live อยู่แล้ว
 * ไม่มีทั้งสองค่า = คืน null (route ตอบ typed error fail-closed)
 */
export function resolveLiveTokenSecret(env: Readonly<Record<string, string | undefined>>): string | null {
  const explicit = env.AI_ASSISTANT_LIVE_TOKEN_SECRET;
  if (typeof explicit === "string" && explicit.length >= 16) return explicit;
  const providerKey = env.OPENAI_API_KEY;
  if (typeof providerKey === "string" && providerKey.length >= 16) return `openai-fallback:${providerKey}`;
  return null;
}

function sign(sessionId: string, expiresAtMs: number, secret: string): string {
  return createHmac("sha256", secret).update(`${TOKEN_INFO}:${sessionId}:${expiresAtMs}`).digest("hex");
}

/** token รูปแบบ "<expiresAtMs>.<hmac hex>" — ผูกกับ session id ตายตัว ไม่มีข้อมูลผู้ใช้อื่น */
export function createLiveSessionToken(sessionId: string, expiresAtMs: number, secret: string): string {
  if (!sessionId || !Number.isSafeInteger(expiresAtMs) || !secret) throw new Error("Invalid live session token input");
  return `${expiresAtMs}.${sign(sessionId, expiresAtMs, secret)}`;
}

export function verifyLiveSessionToken(token: string, sessionId: string, secret: string): boolean {
  if (typeof token !== "string" || token.length === 0 || !sessionId || !secret) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const expiresAtMs = Number(token.slice(0, dot));
  const given = token.slice(dot + 1);
  if (!Number.isSafeInteger(expiresAtMs) || !/^[0-9a-f]{64}$/.test(given)) return false;
  const expected = Buffer.from(sign(sessionId, expiresAtMs, secret), "hex");
  const actual = Buffer.from(given, "hex");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
