// W0 spike — สัญญาข้อความระหว่าง native wake host (Windows) กับหน้าเว็บ StoreOS
//
// คู่แฝดฝั่ง .NET อยู่ที่ windows/StoreOS.VoiceSpike/StandbyContract.cs — แก้ที่ไหนต้องแก้อีกที่
//
// กฎที่ห้ามละเมิด (เขียนไว้ตรงนี้เพราะเป็นขอบเขตความปลอดภัย ไม่ใช่แค่รูปแบบข้อมูล):
//   1. ข้อความจาก native เป็น "ข้อมูล" ไม่ใช่ "คำสั่ง" — บอกได้แค่ว่าได้ยินคำปลุก
//      ห้ามรับ intent/คำสั่ง/ข้อความที่ได้ยินจากฝั่ง native มาใช้ตรง ๆ เด็ดขาด
//      ฟิลด์แปลกปลอมทุกตัวถูกทิ้งตั้งแต่ชั้น parse
//   2. wake หนึ่งครั้ง = สิทธิ์เปิดไมค์หนึ่งรอบ ไม่ใช่สิทธิ์ทำรายการ
//   3. ห้ามใช้ข้อความนี้ไป synthesize คลิกหรือข้าม user-activation ของเบราว์เซอร์
//      ถ้าเบราว์เซอร์ไม่ยอมให้เริ่มฟังเอง ต้องตกไปให้ผู้ใช้แตะเอง (push-to-talk)
//
// โมดูลนี้ยังไม่ถูกต่อเข้ากับ POS — เป็นส่วนหนึ่งของ spike Task 9 เท่านั้น

export const STANDBY_CONTRACT_VERSION = 1;

export const STANDBY_MESSAGE_TYPES = {
  wakeDetected: "wake.detected",
  wakeFallback: "wake.fallback",
  sessionStarted: "command.sessionStarted",
  sessionExtended: "command.sessionExtended",
  sessionEnded: "command.sessionEnded",
  /** web → native: ขอสถานะล่าสุดของเครื่อง (ปุ่ม "ตรวจอีกครั้ง") */
  requestHealth: "command.requestHealth",
  /** web → native: เปิด/ปิดคำปลุกของเครื่องนี้ และจำค่าไว้ */
  setStandby: "command.setStandby",
  /** native → web: สถานะของฝั่งเครื่อง */
  health: "host.health",
} as const;

export type StandbyMessageType = (typeof STANDBY_MESSAGE_TYPES)[keyof typeof STANDBY_MESSAGE_TYPES];

/** รหัสคำปลุกที่อนุญาต — native ส่งรหัสมา ไม่ใช่ข้อความที่ได้ยิน */
export const WAKE_PHRASE_IDS = ["hello_os", "hanlo_os", "helo_os", "watdee_os", "sawatdee_os"] as const;
export type WakePhraseId = (typeof WAKE_PHRASE_IDS)[number];

export interface StandbyInboundMessage {
  readonly v: number;
  readonly type: typeof STANDBY_MESSAGE_TYPES.wakeDetected | typeof STANDBY_MESSAGE_TYPES.wakeFallback;
  readonly seq: number;
  readonly sessionId: string;
  readonly at: string;
  readonly phraseId: WakePhraseId | null;
  readonly confidence: number | null;
  readonly reason: string | null;
}

export interface StandbyOutboundMessage {
  readonly v: number;
  readonly type:
    | typeof STANDBY_MESSAGE_TYPES.sessionStarted
    | typeof STANDBY_MESSAGE_TYPES.sessionExtended
    | typeof STANDBY_MESSAGE_TYPES.sessionEnded
    | typeof STANDBY_MESSAGE_TYPES.requestHealth
    | typeof STANDBY_MESSAGE_TYPES.setStandby;
  readonly seq: number;
  readonly sessionId: string;
  readonly reason?: string;
}

/** สถานะที่ฝั่งเครื่องรายงานมา — ไม่มีรหัสอุปกรณ์ดิบและไม่มีเส้นทางไฟล์ */
export interface VoiceHostHealth {
  readonly state: "off" | "standby" | "listening" | "degraded";
  readonly hostVersion: string;
  readonly recognizer: string | null;
  readonly recognizerCulture: string | null;
  readonly microphone: string | null;
  readonly faultCode: VoiceHostFaultCode | null;
  readonly pronunciationGrammar: boolean;
}

/** รหัสปัญหาที่รู้จัก — enum ปิด เพื่อให้แปลเป็นคำแนะนำได้โดยไม่ต้องรับข้อความ error ดิบ */
export const VOICE_HOST_FAULT_CODES = [
  "no_recognizer",
  "audio_device_busy",
  "audio_input_missing",
  "microphone_denied",
  "pronunciation_fallback",
  "engine_error",
] as const;
export type VoiceHostFaultCode = (typeof VOICE_HOST_FAULT_CODES)[number];

const HEALTH_STATES = ["off", "standby", "listening", "degraded"] as const;

/** แปลงข้อความสถานะจากเครื่อง — คืน null เมื่อรูปทรงไม่ผ่าน */
export function parseHostHealth(raw: unknown): VoiceHostHealth | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (value.v !== STANDBY_CONTRACT_VERSION) return null;
  if (value.type !== STANDBY_MESSAGE_TYPES.health) return null;

  const state = HEALTH_STATES.find((candidate) => candidate === value.state);
  if (!state) return null;

  const fault = (VOICE_HOST_FAULT_CODES as readonly string[]).includes(value.faultCode as string)
    ? (value.faultCode as VoiceHostFaultCode)
    : null;

  // ตัดความยาวทุกข้อความที่จะเอาไปแสดง — ค่าที่มาจากนอกหน้าเว็บต้องไม่ทำ layout พัง
  const text = (input: unknown): string | null =>
    typeof input === "string" && input.length > 0 ? input.slice(0, 120) : null;

  return {
    state,
    hostVersion: text(value.hostVersion) ?? "ไม่ทราบ",
    recognizer: text(value.recognizer),
    recognizerCulture: text(value.recognizerCulture),
    microphone: text(value.microphone),
    faultCode: fault,
    pronunciationGrammar: value.pronunciationGrammar !== false,
  };
}

const SESSION_ID_RE = /^[a-z0-9]{6,32}$/i;

function isWakePhraseId(value: unknown): value is WakePhraseId {
  return typeof value === "string" && (WAKE_PHRASE_IDS as readonly string[]).includes(value);
}

/**
 * แปลงข้อความดิบจาก native ให้เป็นรูปที่ใช้ได้ — คืน null เมื่อรับไม่ได้
 *
 * ตั้งใจไม่โยน error: ข้อความจากภายนอกที่รูปทรงผิดต้องถูกทิ้งเงียบ ๆ ไม่ใช่ทำ POS ล้ม
 */
export function parseStandbyMessage(raw: unknown): StandbyInboundMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;

  if (value.v !== STANDBY_CONTRACT_VERSION) return null;
  if (value.type !== STANDBY_MESSAGE_TYPES.wakeDetected && value.type !== STANDBY_MESSAGE_TYPES.wakeFallback) return null;
  if (typeof value.seq !== "number" || !Number.isFinite(value.seq) || value.seq <= 0) return null;
  if (typeof value.sessionId !== "string" || !SESSION_ID_RE.test(value.sessionId)) return null;
  if (typeof value.at !== "string" || Number.isNaN(Date.parse(value.at))) return null;

  const confidence = typeof value.confidence === "number" && value.confidence >= 0 && value.confidence <= 1
    ? value.confidence
    : null;

  // wake.detected ต้องมีรหัสคำปลุกที่รู้จักเสมอ ไม่งั้นถือว่าใช้ไม่ได้
  const phraseId = isWakePhraseId(value.phraseId) ? value.phraseId : null;
  if (value.type === STANDBY_MESSAGE_TYPES.wakeDetected && phraseId === null) return null;

  return {
    v: STANDBY_CONTRACT_VERSION,
    type: value.type,
    seq: value.seq,
    sessionId: value.sessionId,
    at: value.at,
    phraseId,
    confidence,
    reason: typeof value.reason === "string" ? value.reason.slice(0, 64) : null,
  };
}

export type StandbyBridgeEvent =
  | { readonly kind: "start-listening"; readonly sessionId: string; readonly phraseId: WakePhraseId }
  | { readonly kind: "show-push-to-talk"; readonly sessionId: string; readonly reason: string }
  | { readonly kind: "ignored"; readonly reason: string };

export interface StandbyBridgeOptions {
  /** ส่งข้อความกลับไปหา native host */
  readonly send: (message: StandbyOutboundMessage) => void;
  /** เว็บพร้อมเปิดไมค์ไหม (เช่น permission granted, ไม่ได้กำลังฟังอยู่แล้ว) */
  readonly canStartListening: () => boolean;
}

/**
 * ฝั่งเว็บของสัญญา standby
 *
 * หน้าที่: กันข้อความซ้ำ/ย้อนหลัง, ตัดสินว่าจะเริ่มฟังหรือให้ผู้ใช้แตะเอง,
 * และรายงาน lifecycle กลับ native เพื่อให้ watchdog ฝั่งนั้นทำงานถูก
 */
export class StandbyBridge {
  private lastSeq = 0;
  private outboundSeq = 0;
  private activeSessionId: string | null = null;

  constructor(private readonly options: StandbyBridgeOptions) {}

  get listeningSessionId(): string | null {
    return this.activeSessionId;
  }

  /** รับข้อความจาก native — คืนสิ่งที่ UI ต้องทำต่อ */
  handle(raw: unknown): StandbyBridgeEvent {
    const message = parseStandbyMessage(raw);
    if (!message) return { kind: "ignored", reason: "malformed" };

    // ข้อความมาช้ากว่าที่เคยรับแล้ว = ของเก่าที่ค้างในสาย ทิ้งทิ้ง
    if (message.seq <= this.lastSeq) return { kind: "ignored", reason: "stale_seq" };
    this.lastSeq = message.seq;

    if (message.type === STANDBY_MESSAGE_TYPES.wakeFallback) {
      this.activeSessionId = null;
      return { kind: "show-push-to-talk", sessionId: message.sessionId, reason: message.reason ?? "unknown" };
    }

    if (this.activeSessionId) return { kind: "ignored", reason: "already_listening" };

    if (!this.options.canStartListening()) {
      // ไม่แอบเปิดไมค์และไม่สร้างคลิกปลอม — บอกผู้ใช้ให้แตะเองภายในเวลาที่ native ยังรออยู่
      return { kind: "show-push-to-talk", sessionId: message.sessionId, reason: "user_activation_required" };
    }

    this.activeSessionId = message.sessionId;
    return { kind: "start-listening", sessionId: message.sessionId, phraseId: message.phraseId as WakePhraseId };
  }

  /** เว็บเปิดไมค์สำเร็จแล้ว */
  notifyListeningStarted(sessionId: string): void {
    if (this.activeSessionId !== sessionId) return;
    this.emit(STANDBY_MESSAGE_TYPES.sessionStarted, sessionId);
  }

  /** ยังคุยต่อในรอบเดิม (multi-turn) — ขอต่อเวลา watchdog */
  notifyTurnContinued(sessionId: string): void {
    if (this.activeSessionId !== sessionId) return;
    this.emit(STANDBY_MESSAGE_TYPES.sessionExtended, sessionId);
  }

  /** จบรอบและคืนไมค์ */
  notifyListeningEnded(sessionId: string, reason = "completed"): void {
    if (this.activeSessionId !== sessionId) return;
    this.activeSessionId = null;
    this.emit(STANDBY_MESSAGE_TYPES.sessionEnded, sessionId, reason);
  }

  private emit(type: StandbyOutboundMessage["type"], sessionId: string, reason?: string): void {
    this.options.send({
      v: STANDBY_CONTRACT_VERSION,
      type,
      seq: ++this.outboundSeq,
      sessionId,
      ...(reason ? { reason } : {}),
    });
  }
}
