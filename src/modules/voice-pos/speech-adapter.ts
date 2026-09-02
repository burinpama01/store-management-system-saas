// U13 — Voice foundation (R2) · adapter ครอบ Web Speech API ให้ "ถอดเปลี่ยนได้"
// ห้ามมี React/DOM UI ในไฟล์นี้ — UI คุยกับ interface ด้านล่างเท่านั้น
//
// สัญญาที่ล็อกไว้:
//   - push-to-talk: 1 session ต่อ 1 การกด (continuous = false)
//   - locale ค่าเริ่มต้น th-TH
//   - parser ได้รับเฉพาะ final transcript (interim ใช้แสดงผลชั่วคราวเท่านั้น)
//   - มี active session ได้ครั้งละ 1 — กดซ้ำระหว่างฟังต้องไม่เปิด session ใหม่
//   - permission denied / offline / abort / timeout ต้องกลับมาสถานะที่กู้คืนได้เสมอ

import type { VoiceErrorCode, VoiceRecognitionState } from "./types";

export interface VoiceSpeechHandlers {
  readonly onState?: (state: VoiceRecognitionState) => void;
  /** ข้อความชั่วคราวสำหรับแสดงผลเท่านั้น — ห้ามส่งเข้า parser หรือ log */
  readonly onInterim?: (text: string) => void;
  readonly onFinal: (transcript: string, confidence: number | null) => void;
  readonly onError: (code: VoiceErrorCode) => void;
}

export interface VoiceSpeechSession {
  /** ยังฟังอยู่หรือไม่ */
  isActive(): boolean;
  /** ขอให้ engine สรุปผลที่ได้ยินแล้ว (ปุ่มปล่อย/กดซ้ำ) */
  stop(): void;
  /** ยกเลิกทิ้ง — จะไม่มี final ส่งกลับ */
  cancel(): void;
}

export interface VoiceSpeechAdapter {
  /** ตรวจจาก runtime capability เท่านั้น ห้ามเดาจาก user-agent */
  isSupported(): boolean;
  /** เริ่ม 1 session; ถ้ามี session ค้างอยู่จะคืนตัวเดิมโดยไม่เปิดใหม่ */
  start(handlers: VoiceSpeechHandlers): VoiceSpeechSession;
}

/** โครงขั้นต่ำของ SpeechRecognition ที่เราใช้จริง (ไม่ผูกกับ lib.dom เต็มรูปแบบ) */
export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onstart: ((event: unknown) => void) | null;
  onresult: ((event: SpeechRecognitionResultEventLike) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: ((event: unknown) => void) | null;
}

export interface SpeechRecognitionAlternativeLike {
  readonly transcript: string;
  readonly confidence?: number;
}

export interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: SpeechRecognitionAlternativeLike;
}

export interface SpeechRecognitionResultEventLike {
  readonly resultIndex?: number;
  readonly results: {
    readonly length: number;
    readonly [index: number]: SpeechRecognitionResultLike;
  };
}

export interface SpeechRecognitionWindowLike {
  SpeechRecognition?: new () => SpeechRecognitionLike;
  webkitSpeechRecognition?: new () => SpeechRecognitionLike;
}

export interface BrowserSpeechAdapterOptions {
  /** ฉีด window ได้เพื่อทดสอบ — ไม่ส่งมาจะใช้ globalThis */
  readonly window?: SpeechRecognitionWindowLike | null;
  readonly locale?: string;
  /** ตัดจบอัตโนมัติกันค้าง (ms) */
  readonly timeoutMs?: number;
}

export const VOICE_DEFAULT_LOCALE = "th-TH";
export const VOICE_DEFAULT_TIMEOUT_MS = 8000;

/** map error string ของ Web Speech → enum ของเรา (ค่าที่ไม่รู้จัก = service_error) */
export function mapSpeechErrorCode(raw: string | undefined): VoiceErrorCode {
  switch (raw) {
    case "not-allowed":
    case "service-not-allowed":
      return "permission_denied";
    case "no-speech":
      return "no_speech";
    case "network":
      return "network";
    case "aborted":
      return "aborted";
    default:
      return "service_error";
  }
}

const INERT_SESSION: VoiceSpeechSession = {
  isActive: () => false,
  stop: () => {},
  cancel: () => {},
};

function resolveConstructor(
  win: SpeechRecognitionWindowLike | null | undefined,
): (new () => SpeechRecognitionLike) | null {
  if (!win) return null;
  const ctor = win.SpeechRecognition ?? win.webkitSpeechRecognition;
  return typeof ctor === "function" ? ctor : null;
}

/**
 * adapter จริงที่ครอบ SpeechRecognition ของเบราว์เซอร์
 * ทุกเส้นทางจบต้องคืน state "idle" เสมอ เพื่อให้ปุ่มกดใหม่ได้ (กู้คืนได้)
 */
export function createBrowserSpeechAdapter(
  options: BrowserSpeechAdapterOptions = {},
): VoiceSpeechAdapter {
  const locale = options.locale ?? VOICE_DEFAULT_LOCALE;
  const timeoutMs = options.timeoutMs ?? VOICE_DEFAULT_TIMEOUT_MS;
  const getWindow = (): SpeechRecognitionWindowLike | null =>
    options.window !== undefined
      ? options.window
      : ((globalThis as unknown as SpeechRecognitionWindowLike | undefined) ?? null);

  let activeSession: VoiceSpeechSession | null = null;

  const isSupported = (): boolean => resolveConstructor(getWindow()) !== null;

  const start = (handlers: VoiceSpeechHandlers): VoiceSpeechSession => {
    // 1 active session เท่านั้น — กดซ้ำระหว่างฟังไม่เปิด session ใหม่
    if (activeSession && activeSession.isActive()) return activeSession;

    const Ctor = resolveConstructor(getWindow());
    if (!Ctor) {
      handlers.onError("unsupported_browser");
      handlers.onState?.("error");
      return INERT_SESSION;
    }

    const recognition = new Ctor();
    recognition.lang = locale;
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    let finished = false;
    let delivered = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const clearTimer = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const finish = (): void => {
      if (finished) return;
      finished = true;
      clearTimer();
      recognition.onstart = null;
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      activeSession = null;
    };

    const fail = (code: VoiceErrorCode): void => {
      if (finished) return;
      finish();
      handlers.onError(code);
      handlers.onState?.("error");
      handlers.onState?.("idle");
    };

    recognition.onstart = () => {
      if (finished) return;
      handlers.onState?.("listening");
    };

    recognition.onresult = (event) => {
      if (finished) return;
      const results = event.results;
      const startIndex = event.resultIndex ?? 0;
      for (let i = startIndex; i < results.length; i += 1) {
        const item = results[i];
        if (!item) continue;
        const alternative = item[0];
        const transcript = alternative?.transcript ?? "";
        if (item.isFinal) {
          delivered = true;
          finish();
          handlers.onState?.("resolving");
          const confidence =
            typeof alternative?.confidence === "number" ? alternative.confidence : null;
          handlers.onFinal(transcript, confidence);
          handlers.onState?.("success");
          handlers.onState?.("idle");
          return;
        }
        // interim: แสดงผลได้อย่างเดียว — ไม่ส่งเข้า parser
        handlers.onInterim?.(transcript);
      }
    };

    recognition.onerror = (event) => {
      fail(mapSpeechErrorCode(event?.error));
    };

    recognition.onend = () => {
      // จบโดยไม่มี final และไม่มี error = ผู้ใช้/engine ยกเลิก
      if (finished || delivered) return;
      fail("aborted");
    };

    handlers.onState?.("requesting");
    try {
      recognition.start();
    } catch {
      fail("service_error");
      return INERT_SESSION;
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (finished) return;
        try {
          recognition.abort();
        } catch {
          // เพิกเฉย — รายงาน timeout เป็นสาเหตุหลักอยู่แล้ว
        }
        fail("timeout");
      }, timeoutMs);
    }

    const session: VoiceSpeechSession = {
      isActive: () => !finished,
      stop: () => {
        if (finished) return;
        try {
          recognition.stop();
        } catch {
          fail("service_error");
        }
      },
      cancel: () => {
        if (finished) return;
        try {
          recognition.abort();
        } catch {
          // ไม่ต้องรายงาน — ผู้ใช้เป็นคนยกเลิกเอง
        }
        finish();
        handlers.onState?.("idle");
      },
    };

    activeSession = session;
    return session;
  };

  return { isSupported, start };
}
