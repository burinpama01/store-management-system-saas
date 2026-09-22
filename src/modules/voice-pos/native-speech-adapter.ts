// adapter แปลงเสียงด้วยตัวเครื่อง Android ผ่าน @capacitor-community/speech-recognition (แอป 1.0.5+)
//
// ทำไมต้องมี: WebView ของแอปไม่มี Web Speech API (webkitSpeechRecognition) — ปุ่มเสียงทุกจุด
// ขึ้น "ไม่รองรับ" เมื่อเปิดในแอป ทั้งที่เครื่องมีตัวแปลงเสียงภาษาไทยของระบบอยู่แล้ว
// สัญญาเดียวกับ createBrowserSpeechAdapter: 1 session ต่อการกด, final เท่านั้นเข้า parser,
// ทุกเส้นทางจบต้องกลับ "idle" (กดใหม่ได้เสมอ)

import type { VoiceErrorCode } from "./types";
import type { VoiceSpeechAdapter, VoiceSpeechHandlers, VoiceSpeechSession } from "./speech-adapter";

/** โครงขั้นต่ำของ plugin ที่เราใช้ (window.Capacitor.Plugins.SpeechRecognition) */
export interface NativeSpeechPluginLike {
  requestPermissions(): Promise<{ speechRecognition?: string }>;
  start(options: {
    language: string;
    maxResults: number;
    partialResults: boolean;
    popup: boolean;
  }): Promise<{ matches?: string[]; status?: string; message?: string } | void>;
  stop(): Promise<void>;
}

interface CapacitorWindowLike {
  Capacitor?: {
    isNativePlatform?: () => boolean;
    Plugins?: { SpeechRecognition?: NativeSpeechPluginLike };
  };
}

/** plugin ของแอป — null บนเว็บปกติหรือแอปรุ่นก่อน 1.0.5 (ไม่มี plugin) */
export function getNativeSpeechPlugin(win: unknown = globalThis): NativeSpeechPluginLike | null {
  const cap = (win as CapacitorWindowLike | null | undefined)?.Capacitor;
  if (!cap?.isNativePlatform?.()) return null;
  const plugin = cap.Plugins?.SpeechRecognition;
  return plugin && typeof plugin.start === "function" ? plugin : null;
}

/** ข้อความ error ของ plugin (Android SpeechRecognizer) → enum ของเรา */
export function mapNativeSpeechError(message: string | undefined): VoiceErrorCode {
  const text = (message ?? "").toLowerCase();
  if (text.includes("permission")) return "permission_denied";
  if (text.includes("no match") || text.includes("no speech") || text.includes("didn't understand")) return "no_speech";
  if (text.includes("network")) return "network";
  if (text.includes("not available")) return "unsupported_browser";
  return "service_error";
}

const INERT_SESSION: VoiceSpeechSession = {
  isActive: () => false,
  stop: () => {},
  cancel: () => {},
};

export function createNativeSpeechAdapter(
  plugin: NativeSpeechPluginLike,
  options: { locale: string; timeoutMs: number },
): VoiceSpeechAdapter {
  let activeSession: VoiceSpeechSession | null = null;

  const start = (handlers: VoiceSpeechHandlers): VoiceSpeechSession => {
    if (activeSession && activeSession.isActive()) return activeSession;

    let finished = false;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (): void => {
      finished = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      activeSession = null;
    };

    const fail = (code: VoiceErrorCode): void => {
      if (finished) return;
      finish();
      handlers.onError(code);
      handlers.onState?.("error");
      handlers.onState?.("idle");
    };

    handlers.onState?.("requesting");

    void (async () => {
      try {
        const permission = await plugin.requestPermissions();
        if (finished) return;
        if (permission.speechRecognition !== "granted") {
          fail("permission_denied");
          return;
        }
        handlers.onState?.("listening");
        // partialResults=false: promise คืนผลสุดท้ายเมื่อหยุดพูด/กดปล่อย (stop) — ไม่มี interim
        const result = await plugin.start({
          language: options.locale,
          maxResults: 1,
          partialResults: false,
          popup: false,
        });
        if (finished || cancelled) return;
        const transcript = (result && Array.isArray(result.matches) ? result.matches[0] : "") ?? "";
        if (result && result.status === "error") {
          fail(mapNativeSpeechError(result.message));
          return;
        }
        if (!transcript.trim()) {
          fail("no_speech");
          return;
        }
        finish();
        handlers.onState?.("resolving");
        handlers.onFinal(transcript, null);
        handlers.onState?.("success");
        handlers.onState?.("idle");
      } catch (error) {
        if (cancelled) return;
        fail(mapNativeSpeechError(error instanceof Error ? error.message : String(error)));
      }
    })();

    if (options.timeoutMs > 0) {
      timer = setTimeout(() => {
        if (finished) return;
        void plugin.stop().catch(() => {});
        fail("timeout");
      }, options.timeoutMs);
    }

    const session: VoiceSpeechSession = {
      isActive: () => !finished,
      stop: () => {
        if (finished) return;
        // ให้ engine สรุปผลที่ได้ยินแล้ว — ผลมาทาง promise ของ start
        void plugin.stop().catch(() => fail("service_error"));
      },
      cancel: () => {
        if (finished) return;
        cancelled = true;
        void plugin.stop().catch(() => {});
        finish();
        handlers.onState?.("idle");
      },
    };
    activeSession = session;
    return finished ? INERT_SESSION : session;
  };

  return { isSupported: () => true, start };
}
