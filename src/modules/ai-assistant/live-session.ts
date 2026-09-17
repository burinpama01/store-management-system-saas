// PR3-Live (M3/M4) — เซสชันเสียงสดฝั่ง server + HMAC session token
//
// หน้าที่:
//   - คุม concurrent cap ต่อร้าน (จำกัดจำนวนเซสชัน Live ที่เปิดพร้อมกันต่อ org|store)
//   - คุม tool call cap ต่อเซสชัน (นับ "ความพยายามเรียก tool" รวมที่ถูกปฏิเสธ — กัน loop)
//   - จด startedAt/expiresAt เพื่อ metering (วินาทีเซสชัน) และปิดเองเมื่อหมดอายุ
//   - session token (HMAC) ให้ browser ใช้ยืนยันต่อ route relay ได้โดยไม่ต้องเก็บคุกกี้อื่น
//     token ออกจาก server เท่านั้น ตรวจด้วย timing-safe compare และผูก session id ตายตัว
//
// ความถูกต้องของเซสชัน "ไม่" ขึ้นกับหน่วยความจำของ instance (แก้ตามรีวิว PR #47):
// ตัวตนของเซสชันทั้งหมด (org/store/user/ตะกร้า/อายุ/เพดาน tool) อยู่ใน session token ที่ server
// เซ็นด้วย HMAC แล้ว — request ที่ตกคนละ instance จึงยังคุยต่อได้ ไม่หลุดกลางบทสนทนา
//
// ส่วนที่ยัง "ประมาณ" ต่อ instance คือ *เพดานการใช้งาน* เท่านั้น (จำนวนเซสชันพร้อมกันต่อร้าน และ
// จำนวน tool call ต่อเซสชัน) — รูปแบบเดียวกับ rate limiter ที่ route layer ที่ใช้อยู่แล้ว
// worst case คือเพดานถูกนับแยกตามจำนวน instance ที่รับ request; ถ้าต้องการเพดานแม่นยำ
// (เช่นตอนเริ่มคิดเงินตามนาที) ต้องย้ายตัวนับไปตารางกลางบน Supabase — บันทึกไว้ใน checkpoint

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
  /**
   * รับเซสชันที่ instance อื่นเป็นคนสร้างเข้ามานับต่อ (ข้อมูลมาจาก session token ที่ตรวจลายเซ็นแล้ว)
   * ไม่ตรวจ concurrent cap เพราะ slot ถูกให้ไปตั้งแต่ตอนสร้างแล้ว — ที่นี่แค่เปิดตัวนับ tool call
   * ของ instance นี้ให้มีที่ลง (ไม่มี = เพดานต่อเซสชันจะไม่ถูกบังคับเลยบน instance นั้น)
   */
  readonly adopt: (session: LiveSession) => LiveSession;
  /** หมดอายุแล้ว = drop ทิ้งแล้วคืน null (ผู้เรียกตอบ typed error ไม่ต่ออายุเด็ดขาด) */
  readonly get: (sessionId: string) => LiveSession | null;
  readonly consumeToolCall: (sessionId: string) => { ok: true; used: number } | { ok: false; reason: "unknown_session" | "cap_reached" };
  readonly end: (sessionId: string) => LiveSessionEndSummary | null;
  /**
   * จดว่าเซสชันนี้ถูกปิดแล้ว เพื่อไม่ให้ token ที่ยังไม่หมดอายุถูกใช้สั่งงานต่อ
   *
   * เป็นการเพิกถอนแบบ best-effort ต่อ instance (เหมือนเพดานอื่น ๆ ของช่องทางนี้): instance
   * ที่ไม่เคยเห็นการปิดจะยังรับคำสั่งจนกว่า token จะหมดอายุตามเวลาในตัวมันเอง
   * ถ้าต้องการเพิกถอนทันทีทั้งระบบ ต้องมีตารางกลาง — บันทึกไว้ใน checkpoint
   */
  readonly revoke: (sessionId: string, expiresAt: number) => void;
  readonly isRevoked: (sessionId: string) => boolean;
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
  /** sessionId → เวลาที่ token หมดอายุ (หลังจากนั้นไม่ต้องจำแล้ว เพราะ token ตายเอง) */
  const revoked = new Map<string, number>();

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
    adopt(session) {
      const existing = sessions.get(session.id);
      if (existing) return existing.session;
      const frozen: LiveSession = Object.freeze({ ...session, allowedTools: Object.freeze([...session.allowedTools]) });
      sessions.set(frozen.id, { session: frozen, toolCallsUsed: 0 });
      const key = storeKey(frozen);
      const set = perStore.get(key) ?? new Set<string>();
      set.add(frozen.id);
      perStore.set(key, set);
      return frozen;
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
    revoke(sessionId, expiresAt) {
      if (typeof sessionId !== "string" || sessionId.length === 0) return;
      const now = clock();
      for (const [id, until] of revoked) if (until <= now) revoked.delete(id);
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return;
      revoked.set(sessionId, expiresAt);
    },
    isRevoked(sessionId) {
      const until = revoked.get(sessionId);
      if (until === undefined) return false;
      if (until <= clock()) {
        revoked.delete(sessionId);
        return false;
      }
      return true;
    },
    size: () => sessions.size,
  };
}

// ── session token (HMAC, stateless) ───────────────────────────────────────────

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

/**
 * ข้อมูลของเซสชันที่อยู่ใน token — "ทุกอย่างที่ relay ต้องใช้" เพื่อไม่ต้องพึ่ง state ร่วม
 *
 * ห้ามใส่อะไรที่เป็นความลับหรือเป็นข้อความของผู้ใช้: payload อ่านได้จากฝั่ง browser
 * (เซ็นเพื่อกันการแก้ ไม่ได้เข้ารหัสเพื่อกันการอ่าน) — ค่าที่อยู่ในนี้คือสิ่งที่ browser รู้อยู่แล้ว
 */
export interface LiveSessionClaims {
  readonly sessionId: string;
  readonly organizationId: string;
  readonly storeId: string;
  readonly userId: string;
  readonly activeCartId: string;
  /** tool ที่เซสชันนี้เรียกได้ — อยู่ใน token เพื่อให้จำกัดต่อเซสชัน/ต่อร้านได้โดยไม่ต้องมี state ร่วม */
  readonly allowedTools: readonly string[];
  readonly maxToolCalls: number;
  readonly expiresAt: number;
}

interface TokenPayload {
  readonly sid: string;
  readonly org: string;
  readonly st: string;
  readonly uid: string;
  readonly cart: string;
  readonly tl: readonly string[];
  readonly cap: number;
  readonly exp: number;
}

const MAX_ALLOWED_TOOLS = 32;
const MAX_TOOL_NAME = 80;

function isToolList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= MAX_ALLOWED_TOOLS
    && value.every((tool) => typeof tool === "string" && tool.length > 0 && tool.length <= MAX_TOOL_NAME);
}

function sign(payloadB64: string, secret: string): string {
  return createHmac("sha256", secret).update(`${TOKEN_INFO}:${payloadB64}`).digest("hex");
}

/**
 * token รูปแบบ "v1.<payload base64url>.<hmac hex>"
 * payload ถูกเซ็นทั้งก้อน — แก้ org/store/user/ตะกร้า/อายุ/เพดานแม้แต่ตัวเดียว ลายเซ็นจะไม่ผ่าน
 */
export function createLiveSessionToken(claims: LiveSessionClaims, secret: string): string {
  if (!secret) throw new Error("Invalid live session token secret");
  if (!isValidIdentityPart(claims.sessionId) || !isValidIdentityPart(claims.organizationId)
    || !isValidIdentityPart(claims.storeId) || !isValidIdentityPart(claims.userId)
    || !ACTIVE_CART_ID_PATTERN.test(claims.activeCartId) || !isToolList(claims.allowedTools)
    || !Number.isSafeInteger(claims.maxToolCalls) || claims.maxToolCalls < 1
    || !Number.isSafeInteger(claims.expiresAt)) {
    throw new Error("Invalid live session token input");
  }
  const payload: TokenPayload = {
    sid: claims.sessionId,
    org: claims.organizationId,
    st: claims.storeId,
    uid: claims.userId,
    cart: claims.activeCartId,
    tl: [...claims.allowedTools],
    cap: claims.maxToolCalls,
    exp: claims.expiresAt,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `v1.${payloadB64}.${sign(payloadB64, secret)}`;
}

/**
 * ตรวจ token แล้วคืนตัวตนของเซสชัน — ไม่ผ่านด้วยเหตุผลใดก็ตาม = null (ผู้เรียก fail closed)
 *
 * ลำดับตรวจ: รูปทรง → ลายเซ็น (timing-safe) → รูปทรงของ payload → หมดอายุ
 * ตรวจลายเซ็นก่อนแตะเนื้อข้างในเสมอ เพราะ payload มาจากฝั่ง browser
 */
export function verifyLiveSessionToken(token: string, secret: string, nowMs: number = Date.now()): LiveSessionClaims | null {
  if (typeof token !== "string" || token.length === 0 || !secret) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const [, payloadB64, given] = parts;
  if (!/^[A-Za-z0-9_-]{8,2048}$/.test(payloadB64) || !/^[0-9a-f]{64}$/.test(given)) return null;

  const expected = Buffer.from(sign(payloadB64, secret), "hex");
  const actual = Buffer.from(given, "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  const value = payload as Partial<TokenPayload>;
  if (!isValidIdentityPart(value.sid) || !isValidIdentityPart(value.org) || !isValidIdentityPart(value.st)
    || !isValidIdentityPart(value.uid) || typeof value.cart !== "string" || !ACTIVE_CART_ID_PATTERN.test(value.cart)
    || !isToolList(value.tl)
    || !Number.isSafeInteger(value.cap) || (value.cap as number) < 1
    || !Number.isSafeInteger(value.exp)) {
    return null;
  }
  // หมดอายุแล้ว = ใช้ไม่ได้เด็ดขาด (ไม่มีการต่ออายุจากฝั่ง client)
  if ((value.exp as number) <= nowMs) return null;

  return {
    sessionId: value.sid as string,
    organizationId: value.org as string,
    storeId: value.st as string,
    userId: value.uid as string,
    activeCartId: value.cart,
    allowedTools: Object.freeze([...(value.tl as string[])]),
    maxToolCalls: value.cap as number,
    expiresAt: value.exp as number,
  };
}
