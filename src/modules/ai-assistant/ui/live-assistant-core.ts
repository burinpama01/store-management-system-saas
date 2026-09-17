// PR3-Live (M5) — ตัวควบคุมของโหมดเสียงสด "AI Live" (ไม่มี React/WebRTC ในไฟล์นี้ — ทดสอบได้ระดับ module)
//
// หน้าที่เดียว: จัด lifecycle ของเซสชันเสียงสดต่อแท็บ
//   แตะปุ่ม → claim ไมค์ (ADR-008) → POST /live/session → ต่อเสียง (dep `connect` = WebRTC จริง
//   ที่ฉีดจาก overlay) → data channel จับ function_call → relay ผ่าน POST /live/tool (dispatcher
//   เดิมบน server — browser ห้าม execute tool เอง) → function_call_output กลับให้ model →
//   ผลที่อนุมัติถูกผลักเข้าตะกร้าผ่าน bridge เดิม (applyVoiceCartIntent) เหมือนโหมดข้อความ
//   จบเซสชันทุกทาง (แตะซ้ำ / idle / หมดเวลา / หมด cap / error / ปิดแท็บ) = ปิดไมค์ทุกท่อน
//   (WebRTC tracks) + release ไมค์ + DELETE เซสชันแบบ best-effort
//
// ขอบเขตที่ล็กไว้:
//   - ไม่เก็บเสียง ไม่มี transcript อยู่ใน state/log ของแผง — entry เป็น "ผลลัพธ์/สถานะ" เท่านั้น
//   - cartVersion ของโหมด Live นับเองจาก 0 (server store ของช่องทาง Live แยกจากโหมดข้อความ)
//     ไต่ขึ้นเฉพาะเมื่อ Live แก้ตะกร้าสำเร็จ — สลับกับการพิมพ์ไม่ได้ระหว่างเปิด Live (overlay ล็กให้)
//   - ทุกความล้มเหลว fail closed เป็นข้อความไทย ไม่ปล่อยไมค์ค้าง ไม่ throw ออกนอก core

import { applyVoiceCartIntent, type VoiceProductAlias } from "@/modules/voice-pos/cart";
import { emitPosCommand } from "@/modules/pos/section-bus";
import { claimMicOwnership, releaseMicOwnership } from "@/modules/voice-pos/mic-ownership";
import { emitLiveTelemetry, noopLiveTelemetry, type LiveTelemetry } from "./live-telemetry";
import type { LiveStopReason } from "../live-telemetry-events";
import { fromOpenAiToolName } from "../live-openai-tools";
import type { AssistantCartBridge } from "./text-assistant-core";
import {
  ASSISTANT_CART_ID_PATTERN,
  planAssistantTurn,
  type AssistantTurnStep,
} from "./text-assistant-ui";

// ── รูปทรงของช่องทางเชื่อมต่อ (ฉีดทั้งหมด — WebRTC จริงอยู่ที่ live-webrtc.ts) ─────────

export interface LiveConnectionHandlers {
  readonly onOpen: () => void;
  readonly onUserSpeechStarted: () => void;
  /** call จาก model — argsText คือ JSON string ดิบจาก data channel (parse ที่ core เท่านั้น) */
  readonly onFunctionCall: (call: { readonly callId: string; readonly tool: string; readonly argsText: string }) => void;
  readonly onAssistantResponseDone: () => void;
  readonly onError: (message: string) => void;
  readonly onClosed: () => void;
}

export interface LiveConnectOptions {
  readonly ephemeralToken: string;
  readonly model: string;
  readonly handlers: LiveConnectionHandlers;
  /** ผูก event วินิจฉัยของ WebRTC เข้ากับเซสชันเดียวกัน (ไม่ใช่ความลับ — เป็น id ที่ server ออกให้) */
  readonly sessionId?: string;
}

export interface LiveConnectionHandle {
  /** ส่ง function_call_output กลับ + ขอ response ต่อ (รวมทั้งสองอย่างในคำเดียว) */
  readonly sendFunctionCallOutput: (callId: string, outputJson: string) => void;
  /** ปิดทุกท่อน: data channel, peer connection และหยุด track ไมค์ที่จับไว้ */
  readonly close: () => void;
}

// ── รูปทรงของช่องทาง HTTP (route จริงที่ M3/M4 นิยาม) ─────────────────────────────

/** ผลตอบของ POST /api/ai-assistant/live/session — parse แบบทนทานที่ core เสมอ */
export type LiveSessionResponse =
  | {
    readonly ok: true;
    readonly sessionId: string;
    readonly sessionToken: string;
    readonly ephemeralToken: string;
    readonly model: string;
    readonly expiresAt: number;
    readonly caps: { readonly toolCallsPerSession: number };
  }
  | { readonly ok: false; readonly reason?: string; readonly manualPath?: string };

/** body ของ POST /api/ai-assistant/live/tool */
export interface LiveToolRequestBody {
  readonly sessionId: string;
  readonly sessionToken: string;
  readonly callId: string;
  readonly tool: string;
  readonly args: unknown;
  readonly idempotencyKey: string;
  readonly cartVersion: number;
  readonly summary?: { readonly itemCount: number; readonly total: number; readonly locked: boolean };
}

/** ผลตอบของ POST /api/ai-assistant/live/tool — outcome คือ Result ของ dispatcher ตรง ๆ */
export type LiveToolRelayResponse =
  | {
    readonly ok: true;
    readonly callId: string;
    readonly tool: string;
    readonly outcome: { readonly ok: true; readonly data: unknown } | { readonly ok: false; readonly code: string };
    readonly toolCallsUsed?: number;
    readonly toolCallsCap?: number;
  }
  | { readonly ok: false; readonly reason?: string; readonly manualPath?: string };

// ── state ของ UI ────────────────────────────────────────────────────────────────

export type LiveAssistantPhase = "idle" | "connecting" | "active";
export type LiveAssistantStatus = "listening" | "working" | "speaking";

export interface LiveAssistantUiEntry {
  readonly id: number;
  readonly level: "assistant" | "error";
  readonly message: string;
}

export interface LiveAssistantState {
  readonly phase: LiveAssistantPhase;
  /** null = กำลังเปิดช่องเสียง (connect สำเร็จแต่ data channel ยังไม่ open) */
  readonly status: LiveAssistantStatus | null;
  readonly entries: readonly LiveAssistantUiEntry[];
  readonly toolCallsUsed: number;
  readonly toolCallsCap: number | null;
}

export interface LiveAssistantCoreDeps {
  /** id ตะกร้าของแท็บนี้ (จาก core โหมดข้อความ — ตะกร้าใบเดียวกัน) */
  readonly cartId: string;
  readonly getCartApi: () => AssistantCartBridge | null;
  readonly getProductAliases?: () => readonly VoiceProductAlias[];
  readonly onFocusSell?: () => void;
  readonly createSession: (body: { readonly activeCartId: string }) => Promise<LiveSessionResponse>;
  readonly relayTool: (body: LiveToolRequestBody) => Promise<LiveToolRelayResponse>;
  /** best-effort — core ไม่รอผลและไม่ให้ความล้มเหลวของการปิดบน server กระทบ UI */
  readonly endSession: (body: { readonly sessionId: string; readonly sessionToken: string }) => Promise<unknown>;
  readonly connect: (options: LiveConnectOptions) => Promise<LiveConnectionHandle>;
  readonly claimMic?: () => boolean;
  readonly releaseMic?: () => void;
  /** ตัวส่ง event วินิจฉัย — ไม่ส่งมา = ใช้ตัวกลางของหน้า (noop ถ้าร้านนี้ปิดโหมดวินิจฉัย) */
  readonly telemetry?: LiveTelemetry;
  readonly now?: () => number;
  /** ตั้ง timer แบบฉีดได้ (idle/expiry) — คืนฟังก์ชันยกเลิก */
  readonly schedule?: (fn: () => void, ms: number) => () => void;
  /** ไม่มีเสียงสนทนานานเท่านี้ = ปิดเอง (ป้องกันไมค์ค้าง) */
  readonly idleTimeoutMs?: number;
  readonly maxEntries?: number;
}

/** เหตุผลการจบเซสชัน — ข้อความไทยผูกไว้ที่เดียว */
/**
 * เหตุผลการจบเซสชัน — ใช้ชุดเดียวกับ telemetry (ห้ามมี string กระจัดกระจายหลายแบบ)
 * เพื่อให้ตอบได้จาก log ว่า "จบเพราะอะไร" โดยไม่ต้องเดาจากข้อความภาษาไทย
 */
export type LiveSessionEndReason = LiveStopReason;

const END_MESSAGES: Record<Exclude<LiveSessionEndReason, "error">, string> = {
  user: "ปิดโหมดเสียงสดแล้ว",
  idle: "ไม่มีการสนทนาสักพัก — ปิดโหมดเสียงสดให้อัตโนมัติ",
  expired: "หมดเวลาของเซสชันเสียงสด — เปิดใหม่ได้เสมอ",
  cap: "ใช้จำนวนคำสั่งของเซสชันครบแล้ว — ปิดโหมดเสียงสด",
  tab_close: "ปิดโหมดเสียงสดแล้ว",
  unmount: "ปิดโหมดเสียงสดแล้ว",
  network: "การเชื่อมต่อหลุด — เปิดโหมดเสียงสดใหม่ได้เลย",
  provider: "ผู้ให้บริการเสียงมีปัญหา — เปิดโหมดเสียงสดใหม่อีกครั้ง",
  webrtc: "ช่องเสียงมีปัญหา — เปิดโหมดเสียงสดใหม่อีกครั้ง",
  access_revoked: "สิทธิ์ใช้โหมดเสียงสดถูกปิดระหว่างใช้งาน",
};

const DEFAULT_IDLE_TIMEOUT_MS = 90_000;
/** idempotency key ต้องเป็น [A-Za-z0-9_-] ยาว 8-64 — สร้างจาก callId ของ provider */
export function createLiveIdempotencyKey(callId: string): string {
  const cleaned = callId.replace(/[^A-Za-z0-9_-]/g, "") || "call";
  let key = `live-${cleaned}`.slice(0, 64);
  while (key.length < 8) key += "0";
  return key;
}

function describeLiveSessionFailure(response: { readonly reason?: string; readonly manualPath?: string }): string {
  if (typeof response.manualPath === "string" && response.manualPath.length > 0) return response.manualPath;
  switch (response.reason) {
    case "live_pilot_only":
      return "โหมดเสียงสดเปิดให้เฉพาะร้านที่เข้าร่วมทดลอง";
    case "live_disabled":
      return "โหมดเสียงสดยังปิดใช้งาน";
    case "live_unconfigured":
      return "โหมดเสียงสดยังตั้งค่าไม่ครบ — แจ้งผู้ดูแลระบบ";
    case "live_store_busy":
      return "ร้านนี้เปิดโหมดเสียงสดอยู่ครบจำนวนแล้ว — ปิดเซสชันเดิมก่อน";
    case "rate_limited":
      return "เปิดโหมดเสียงสดถี่เกินไป — รอแป๊บเดียวแล้วลองใหม่";
    case "network_error":
      return "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ — ลองใหม่อีกครั้ง";
    default:
      return "เปิดโหมดเสียงสดไม่สำเร็จ — ลองใหม่อีกครั้ง";
  }
}

function describeLiveRelayFailure(response: { readonly reason?: string; readonly manualPath?: string }): string {
  if (typeof response.manualPath === "string" && response.manualPath.length > 0) return response.manualPath;
  switch (response.reason) {
    case "rate_limited":
      return "คำสั่งถี่เกินไป — พูดใหม่อีกครั้ง";
    case "live_tool_not_allowed":
      return "คำสั่งนี้ยังไม่เปิดใช้ในโหมดเสียงสด";
    case "assistant_unavailable":
      return "ผู้ช่วยยังใช้ไม่ได้ชั่วคราว — ลองใหม่อีกครั้ง";
    default:
      return "ส่งคำสั่งไม่สำเร็จ — พูดใหม่อีกครั้ง";
  }
}

export interface LiveAssistantCore {
  readonly cartId: string;
  readonly start: () => Promise<void>;
  /** จบเซสชันทุกทาง — ปลอดภัยต่อการเรียกซ้ำ (เรียกตอน idle = ไม่มีผล) */
  readonly stop: (reason: LiveSessionEndReason, errorMessage?: string) => void;
  readonly getState: () => LiveAssistantState;
  readonly subscribe: (listener: () => void) => () => void;
}

/** ได้คำถามตัวเลือกเรื่องเดิมติดกันกี่ครั้งแล้วให้หยุดถาม (ถามครั้งแรก + ให้ตอบพลาดได้อีก 2 รอบ) */
export const MAX_REPEATED_CLARIFICATIONS = 3;

/**
 * "เรื่อง" ของคำถามตัวเลือก — ใช้เมนู + เหตุผล (ไม่ใช้ note/คำที่ model พูด เพราะเปลี่ยนทุกรอบ)
 * ไม่ใช่คำถาม = null
 */
export function clarificationSignature(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const result = data as { status?: unknown; reason?: unknown; productName?: unknown; productId?: unknown; pending?: unknown };
  if (result.status === "clarification") {
    return `one:${String(result.productId ?? result.productName ?? "")}:${String(result.reason ?? "")}`;
  }
  if (result.status === "clarification_batch" && Array.isArray(result.pending)) {
    return `batch:${result.pending
      .map((item) => {
        const entry = (typeof item === "object" && item !== null ? item : {}) as { productName?: unknown; productPhrase?: unknown; reason?: unknown };
        return `${String(entry.productName ?? entry.productPhrase ?? "")}:${String(entry.reason ?? "")}`;
      })
      .sort()
      .join("|")}`;
  }
  return null;
}

export function createLiveAssistantCore(deps: LiveAssistantCoreDeps): LiveAssistantCore {
  const now = deps.now ?? (() => Date.now());
  const schedule = deps.schedule ?? ((fn: () => void, ms: number) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  });
  const idleTimeoutMs = Math.max(5_000, deps.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS);
  const maxEntries = Math.max(1, deps.maxEntries ?? 20);
  const claimMic = deps.claimMic ?? (() => claimMicOwnership("ai-live"));
  const releaseMic = deps.releaseMic ?? (() => releaseMicOwnership("ai-live"));
  const telemetry = deps.telemetry ?? { ...noopLiveTelemetry, emit: emitLiveTelemetry };
  /** ทุก event ของ core ผูก sessionId ปัจจุบันให้อัตโนมัติ — timeline จึงต่อกันได้ */
  const track = (event: Parameters<LiveTelemetry["emit"]>[0]): void => {
    telemetry.emit(sessionId ? { ...event, sessionId } : event);
  };

  if (typeof deps.cartId !== "string" || !ASSISTANT_CART_ID_PATTERN.test(deps.cartId)) {
    throw new Error("Invalid live assistant cart id");
  }

  let phase: LiveAssistantPhase = "idle";
  let status: LiveAssistantStatus | null = null;
  let entries: readonly LiveAssistantUiEntry[] = [];
  let toolCallsUsed = 0;
  let toolCallsCap: number | null = null;

  let sessionId: string | null = null;
  let sessionToken: string | null = null;
  let handle: LiveConnectionHandle | null = null;
  let cancelIdle: (() => void) | null = null;
  let cancelExpiry: (() => void) | null = null;
  /** ประมวลผล function call ทีละคำสั่ง — กัน apply ตะกร้าทับกันเมื่อ response เดียวมีหลาย call */
  let relayChain: Promise<void> = Promise.resolve();
  /** call ที่รับแล้ว (กัน event ซ้ำของ provider) — จำกัดขนาดตาม cap ของเซสชัน */
  const seenCallIds = new Set<string>();
  let liveCartVersion = 0;
  /** คำถามตัวเลือกล่าสุด + จำนวนครั้งที่ได้ซ้ำติดกัน — ตัดวงวน "ถามตัวเลือกเดิมไม่จบ" */
  let lastClarification: { signature: string; count: number } | null = null;
  let entrySequence = 0;
  /** เวลาที่เซสชันนี้เริ่ม (ฝั่งเบราว์เซอร์) — ใช้รายงานความยาวเซสชันตอนจบ */
  let sessionStartedAtMs: number | null = null;

  const listeners = new Set<() => void>();
  let snapshot: LiveAssistantState = { phase, status, entries, toolCallsUsed, toolCallsCap };

  function notify(): void {
    snapshot = { phase, status, entries, toolCallsUsed, toolCallsCap };
    for (const listener of [...listeners]) listener();
  }

  function pushEntry(level: LiveAssistantUiEntry["level"], message: string): void {
    entrySequence += 1;
    entries = [...entries, { id: entrySequence, level, message }].slice(-maxEntries);
  }

  function resetIdleTimer(): void {
    cancelIdle?.();
    cancelIdle = schedule(() => {
      cancelIdle = null;
      if (phase !== "active") return;
      track({ event: "live.idle_timeout", stage: "session", result: "ended" });
      stop("idle");
    }, idleTimeoutMs);
  }

  function setStatus(next: LiveAssistantStatus): void {
    status = next;
    resetIdleTimer();
    notify();
  }

  function setPhase(next: LiveAssistantPhase): void {
    phase = next;
    if (next !== "active") status = null;
    notify();
  }

  /** bridge ไม่พร้อม = แก้ตะกร้าไม่ได้ — โหมด Live ต้องมีหน้าขายรับผลเสมอ */
  function cartSnapshot(): { itemCount: number; total: number; locked: boolean } | null {
    const api = deps.getCartApi();
    if (!api) return null;
    const snap = api.getSnapshot();
    return { itemCount: snap.cart.items.length, total: snap.cart.total, locked: snap.locked };
  }

  /** ผล apply ที่อนุมัติแล้ว → ตะกร้าจริงผ่าน bridge เดิม (ADR-009) — คืน false เมื่อแก้ไม่สำเร็จ */
  function applyApprovedIntent(step: Extract<AssistantTurnStep, { kind: "apply" }>): boolean {
    // server รู้แค่ว่า tool ผ่าน — จุดนี้คือ "ลงตะกร้าจริงบนหน้าขายหรือไม่" ซึ่งเป็นคนละเรื่องกัน
    track({ event: "cart.apply_started", stage: "cart", result: "started", cartVersion: liveCartVersion });
    const api = deps.getCartApi();
    if (!api) {
      pushEntry("error", "หน้าขายยังไม่พร้อม — แก้ตะกร้าไม่ได้ในขณะนี้");
      track({ event: "cart.apply_failed", stage: "cart", result: "failed", reason: "cart_api_missing" });
      return false;
    }
    const snap = api.getSnapshot();
    const resolution = applyVoiceCartIntent(step.intent as never, {
      cart: snap.cart,
      products: snap.products,
      productAliases: deps.getProductAliases?.() ?? [],
      locked: snap.locked,
    });
    if (resolution.status === "blocked") {
      pushEntry("error", resolution.announcement);
      track({
        event: "cart.apply_failed",
        stage: "cart",
        result: "failed",
        reason: snap.locked ? "cart_locked" : "resolution_blocked",
        cartVersion: liveCartVersion,
      });
      return false;
    }
    api.commit(resolution.cart);
    const cartVersionBefore = liveCartVersion;
    liveCartVersion += 1;
    deps.onFocusSell?.();
    pushEntry("assistant", resolution.announcement);
    track({
      event: "cart.apply_succeeded",
      stage: "cart",
      result: "success",
      cartVersion: liveCartVersion,
      metadata: {
        cartVersionBefore,
        itemCount: resolution.cart.items.length,
        total: resolution.cart.total,
      },
    });
    return true;
  }

  function runOutcomeSteps(outcome: { readonly ok: true; readonly data: unknown } | { readonly ok: false; readonly code: string }, tool: string): boolean {
    const steps = outcome.ok
      ? planAssistantTurn([{ kind: "tool", ok: true, tool, result: outcome.data }])
      : planAssistantTurn([{ kind: "error", ok: false, tool, code: outcome.code }]);
    let applied = true;
    for (const step of steps) {
      if (step.kind === "apply") {
        if (!applyApprovedIntent(step)) applied = false;
        continue;
      }
      if (step.kind === "message") {
        pushEntry(step.level, step.message);
        continue;
      }
      if (step.kind === "open_checkout") {
        // "กดปุ่ม" ให้เท่านั้น — ไม่มีการสร้าง payment/QR ที่นี่ และพนักงานยังเป็นคนยืนยัน
        deps.onFocusSell?.();
        emitPosCommand("open-checkout");
        pushEntry("assistant", step.message);
        track({ event: "cart.checkout_opened", stage: "cart", result: "success" });
        continue;
      }
      // clear_search/open_product เป็นขั้นของโหมดข้อความ (ต้องมีคนอยู่หน้าจอ) — โหมดเสียง
      // ปล่อยให้ model พูดแนะนำแทน จึงไม่เดินขั้นเหล่านี้
    }
    return applied;
  }

  async function handleFunctionCall(call: { readonly callId: string; readonly tool: string; readonly argsText: string }): Promise<void> {
    if (phase !== "active" || !sessionId || !sessionToken || !handle) return;
    if (seenCallIds.has(call.callId)) return;
    seenCallIds.add(call.callId);
    if (seenCallIds.size > 200) {
      // กันหน่วยความจำโตในเซสชันยาว — cap ของเซสชันจำกัดจำนวน call อยู่แล้ว
      const first = seenCallIds.values().next().value;
      if (first) seenCallIds.delete(first);
    }

    // ชื่อ tool ฝั่ง provider ห้ามมีจุด (`pos_add_item`) — แปลงกลับเป็นชื่อจริงของระบบก่อนเสมอ
    // ไม่รู้จัก = ไม่ relay (model อาจเรียกชื่อที่เราไม่ได้ให้ไว้)
    const tool = fromOpenAiToolName(call.tool);
    if (!tool) {
      pushEntry("error", "คำสั่งนี้ยังไม่เปิดใช้ในโหมดเสียงสด");
      handle.sendFunctionCallOutput(call.callId, JSON.stringify({ ok: false, reason: "unknown_tool" }));
      setStatus("speaking");
      return;
    }

    setStatus("working");
    let args: unknown = {};
    let argsValid = true;
    if (typeof call.argsText === "string" && call.argsText.trim().length > 0) {
      try {
        args = JSON.parse(call.argsText);
      } catch {
        argsValid = false;
      }
    } else if (call.argsText === undefined || call.argsText === null) {
      args = {};
    }
    if (!argsValid || args === null || typeof args !== "object") {
      // model ส่ง args ที่ไม่ใช่ JSON — แจ้งกลับแบบ typed ให้ model พูดแก้ตัวเอง
      pushEntry("error", "คำสั่งไม่อยู่ในรูปแบบที่รองรับ — พูดใหม่อีกครั้ง");
      handle.sendFunctionCallOutput(call.callId, JSON.stringify({ ok: false, reason: "invalid_args" }));
      setStatus("speaking");
      return;
    }

    let summary: { itemCount: number; total: number; locked: boolean } | undefined;
    try {
      summary = cartSnapshot() ?? undefined;
    } catch {
      summary = undefined;
    }

    let relay: LiveToolRelayResponse;
    try {
      relay = await deps.relayTool({
        sessionId,
        sessionToken,
        callId: call.callId,
        tool,
        args,
        idempotencyKey: createLiveIdempotencyKey(call.callId),
        cartVersion: liveCartVersion,
        ...(summary ? { summary } : {}),
      });
    } catch {
      relay = { ok: false, reason: "network_error" };
    }

    if (phase !== "active" || !handle) return; // จบเซสชันระหว่างรอ = ไม่ส่งอะไรกลับไปอีก

    if (!relay.ok) {
      pushEntry("error", describeLiveRelayFailure(relay));
      if (relay.reason === "live_tool_cap_reached") {
        track({ event: "live.cap_reached", stage: "session", result: "blocked", reason: "tool_cap" });
        stop("cap");
        return;
      }
      // model ต้องได้ยินผลเสมอ ไม่งั้นจะรอคำตอบค้าง — ส่ง typed failure กลับเป็น output
      handle.sendFunctionCallOutput(call.callId, JSON.stringify({ ok: false, reason: relay.reason ?? "relay_failed" }));
      setStatus("speaking");
      return;
    }

    // นับจาก response ฝั่งสำเร็จเท่านั้น (failure branch ไม่มี field นี้ — M5 typecheck)
    if (typeof relay.toolCallsUsed === "number") toolCallsUsed = relay.toolCallsUsed;
    if (typeof relay.toolCallsCap === "number") toolCallsCap = relay.toolCallsCap;

    const outcome = relay.outcome;
    let applied = true;
    try {
      applied = runOutcomeSteps(outcome, tool);
    } catch {
      applied = false;
      pushEntry("error", "ผลลัพธ์จากผู้ช่วยไม่รู้จัก — ใช้หน้าจอแทนได้ตามปกติ");
    }
    let payload = outcome.ok && (outcome.data as { status?: unknown } | null)?.status === "apply"
      ? { ...(outcome.data as Record<string, unknown>), applied }
      : outcome.ok
        ? outcome.data
        : { ok: false, code: outcome.code };

    // กันถามวน: คำถามตัวเลือก "เรื่องเดิม" ติดกันถึงเพดาน = หยุดให้ model ถาม แล้วให้คนเลือกบนจอ
    const signature = outcome.ok ? clarificationSignature(outcome.data) : null;
    if (signature === null) {
      lastClarification = null;
    } else {
      const count = lastClarification?.signature === signature ? lastClarification.count + 1 : 1;
      lastClarification = { signature, count };
      if (count >= MAX_REPEATED_CLARIFICATIONS) {
        payload = { ...(payload as Record<string, unknown>), stopAsking: true, instruction: "หยุดถามตัวเลือกนี้ บอกพนักงานสั้น ๆ ให้เลือกตัวเลือกบนหน้าจอเอง" };
        pushEntry("error", "ผู้ช่วยยังจับตัวเลือกไม่ได้ — เลือกเมนูนี้บนหน้าจอแทนได้เลย");
        track({ event: "cart.clarification_repeated", stage: "cart", result: "blocked", reason: `repeat_${count}` });
        lastClarification = null;
      }
    }
    handle.sendFunctionCallOutput(call.callId, JSON.stringify(payload));
    setStatus("speaking");
    notify();
  }

  const start = async (): Promise<void> => {
    if (phase !== "idle") return;
    track({ event: "live.requested", stage: "session", result: "started" });
    track({ event: "mic.claim_started", stage: "mic", result: "started" });
    if (!claimMic()) {
      pushEntry("error", "ปุ่มเสียงเดิมกำลังฟังอยู่ — รอรอบนั้นจบแล้วแตะ AI Live อีกครั้ง");
      track({ event: "mic.claim_failed", stage: "mic", result: "blocked", reason: "voice_pos_busy" });
      notify();
      return;
    }
    track({ event: "mic.claimed", stage: "mic", result: "success" });
    if (!deps.getCartApi()) {
      releaseMic();
      pushEntry("error", "หน้าขายยังไม่พร้อม — โหมดเสียงสดยังเปิดไม่ได้");
      track({ event: "mic.released", stage: "mic", result: "ended", reason: "cart_api_missing" });
      track({
        event: "live.session_create_failed", stage: "session", result: "failed", reason: "cart_api_missing",
      });
      notify();
      return;
    }

    setPhase("connecting");
    pushEntry("assistant", "กำลังเชื่อมต่อโหมดเสียงสด…");
    notify();

    const sessionStartedAt = now();
    track({ event: "live.session_create_started", stage: "session", result: "started" });
    let session: LiveSessionResponse;
    try {
      session = await deps.createSession({ activeCartId: deps.cartId });
    } catch {
      session = { ok: false, reason: "network_error" };
    }
    if (!session.ok) {
      releaseMic();
      setPhase("idle");
      pushEntry("error", describeLiveSessionFailure(session));
      // ด่านที่ปฏิเสธ (สิทธิ์/แพ็กเกจ/pilot/kill switch/rate limit) ต้องเห็นได้จาก timeline
      track({
        event: "live.access_denied",
        stage: "session",
        result: "blocked",
        reason: session.reason ?? "unknown",
        durationMs: now() - sessionStartedAt,
      });
      track({ event: "mic.released", stage: "mic", result: "ended", reason: "session_create_failed" });
      notify();
      return;
    }
    track({ event: "live.access_granted", stage: "session", result: "success" });

    sessionId = session.sessionId;
    sessionToken = session.sessionToken;
    track({
      event: "live.session_created",
      stage: "session",
      result: "success",
      durationMs: now() - sessionStartedAt,
    });
    toolCallsCap = session.caps?.toolCallsPerSession ?? null;
    toolCallsUsed = 0;
    liveCartVersion = 0;
    lastClarification = null;
    sessionStartedAtMs = now();

    try {
      handle = await deps.connect({
        ephemeralToken: session.ephemeralToken,
        model: session.model,
        sessionId: session.sessionId,
        handlers: {
          onOpen: () => {
            if (phase !== "active") setPhase("active");
            setStatus("listening");
            pushEntry("assistant", "เริ่มฟังแล้ว — พูดได้เลย แตะปุ่มซ้ำเพื่อปิด");
          },
          onUserSpeechStarted: () => setStatus("listening"),
          onAssistantResponseDone: () => setStatus("listening"),
          onFunctionCall: (call) => {
            // เรียงคิวให้คำสั่งเดินทีละคำสั่ง (apply ตะกร้าต้องไม่แย่ง snapshot กัน)
            relayChain = relayChain.then(() => handleFunctionCall(call)).catch(() => undefined);
          },
          onError: () => {
            // ข้อความจาก provider ไม่แสดงดิบ (อาจมีเนื้อหาจากเสียง) — fail closed เป็นข้อความเดิม
            stop("webrtc", "การเชื่อมต่อเสียงมีปัญหา — ลองเปิดโหมดเสียงสดใหม่อีกครั้ง");
          },
          onClosed: () => {
            if (phase !== "active") return;
            track({ event: "live.network_lost", stage: "session", result: "failed", reason: "connection_closed" });
            stop("network", "การเชื่อมต่อเสียงหลุด — เปิดโหมดเสียงสดใหม่ได้เลย");
          },
        },
      });
    } catch {
      handle = null;
      releaseMic();
      setPhase("idle");
      pushEntry("error", "เปิดช่องเสียงไม่สำเร็จ — ตรวจสิทธิ์ไมโครโฟนของเบราว์เซอร์แล้วลองใหม่");
      // จุดนี้คือ getUserMedia ถูกปฏิเสธ หรือ SDP ต่อไม่ติด (รายละเอียดอยู่ใน event ของ webrtc)
      track({ event: "mic.claim_failed", stage: "mic", result: "failed", reason: "media_device_error" });
      track({ event: "live.session_create_failed", stage: "session", result: "failed", reason: "connect_failed" });
      void bestEffortEnd();
      notify();
      return;
    }

    // เซสชันบน server หมดอายุตาม TTL — ปิดฝั่งนี้ให้ตรงจังหวะ (ปิดไมค์ก่อน server ปฏิเสธเอง)
    const remainingMs = Math.max(0, session.expiresAt - now());
    cancelExpiry = schedule(() => {
      cancelExpiry = null;
      if (phase === "active" || phase === "connecting") {
        track({ event: "live.expired", stage: "session", result: "ended" });
        stop("expired");
      }
    }, remainingMs);
    setPhase("active");
    resetIdleTimer();
    notify();
  };

  function bestEffortEnd(): Promise<unknown> {
    if (!sessionId || !sessionToken) return Promise.resolve();
    return deps.endSession({ sessionId, sessionToken }).catch(() => undefined);
  }

  /** กัน stop ถูกเรียกซ้อนจาก event ของ connection ระหว่างกำลังปิดเอง (เช่น onclose ไหม้เข้ามา) */
  let stopping = false;

  function stop(reason: LiveSessionEndReason, errorMessage?: string): void {
    if (phase === "idle" || stopping) return;
    stopping = true;
    const startedAt = sessionStartedAtMs;
    track({ event: "live.stop_requested", stage: "stop", result: "started", reason });
    cancelIdle?.();
    cancelIdle = null;
    cancelExpiry?.();
    cancelExpiry = null;
    try {
      handle?.close();
    } catch {
      // ปิดไม่สำเร็จ (เช่นปิดไปแล้ว) — ไมค์ถูกหยุดที่ track เสมออยู่แล้ว
    }
    handle = null;
    releaseMic();
    track({ event: "mic.released", stage: "mic", result: "ended", reason: "session_stopped" });
    track({
      event: "live.stopped",
      stage: "stop",
      result: "ended",
      reason,
      // เก็บเฉพาะค่าที่รู้จริงฝั่งนี้ — วินาทีของเซสชันฝั่ง server อยู่ใน log ของ route ปิดเซสชัน
      metadata: {
        sessionSeconds: startedAt === null ? null : Math.max(0, Math.round((now() - startedAt) / 1000)),
        toolCallsUsed,
      },
    });
    void bestEffortEnd();
    sessionId = null;
    sessionToken = null;
    sessionStartedAtMs = null;
    setPhase("idle");
    // การปิดปกติ (แตะซ้ำ/idle/หมดเวลา/หมดเพดาน) ไม่ใช่ error — แสดงเป็นข้อความผู้ช่วยธรรมดา
    // ส่วนการปิดเพราะมีอะไรพัง (เครือข่าย/provider/ช่องเสียง/สิทธิ์ถูกถอน) ต้องเป็นระดับ error
    const failed = errorMessage !== undefined
      || reason === "error" || reason === "network" || reason === "provider"
      || reason === "webrtc" || reason === "access_revoked";
    pushEntry(
      failed ? "error" : "assistant",
      errorMessage ?? (reason === "error" ? "ปิดโหมดเสียงสดแล้ว" : END_MESSAGES[reason]),
    );
    stopping = false;
    notify();
  }

  return {
    cartId: deps.cartId,
    start,
    stop,
    getState: (): LiveAssistantState => snapshot,
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
