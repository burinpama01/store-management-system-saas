"use client";

// U13 — Voice foundation (R2) · ปุ่ม push-to-talk
// หน้าที่เดียว: คุม 1 รอบการฟัง → ส่ง final transcript เข้า parser → คืน VoiceParseResult ให้ผู้เรียก
// ปุ่มนี้ "ไม่" ลงมือทำอะไรกับ router/ตะกร้าเอง — U14/U15 เป็นผู้รับผลไปทำต่อ
//
// กฎความเป็นส่วนตัวที่บังคับในไฟล์นี้:
//   - transcript อยู่ใน state ชั่วคราวเท่านั้น และถูกล้างทันทีหลัง parse / timeout / unmount
//   - ห้าม console.log / ส่ง transcript ออกนอกคอมโพเนนต์ (ผู้เรียกได้เฉพาะ intent + result code)

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { parseVoiceCommand } from "@/modules/voice-pos/parser";
import type { WindowsVoiceHostAdapter } from "@/modules/voice-pos/windows-host";
import {
  createBrowserSpeechAdapter,
  type VoiceSpeechAdapter,
  type VoiceSpeechSession,
} from "@/modules/voice-pos/speech-adapter";
import { createBrowserVoiceFeedback, type VoiceFeedback } from "@/modules/voice-pos/feedback";
import {
  readVoiceFeedbackPreference,
  subscribeVoiceFeedbackPreference,
  writeVoiceFeedbackPreference,
} from "@/modules/voice-pos/feedback-preference";
import {
  buildVoiceTelemetry,
  type VoiceErrorCode,
  type VoiceParseResult,
  type VoiceRecognitionState,
  type VoiceTelemetryEvent,
} from "@/modules/voice-pos/types";

/** ข้อความผู้ใช้ต่อ error code — กู้คืนได้ทุกกรณี และชี้ทางสำรอง Ctrl+K เสมอ */
const ERROR_MESSAGE: Record<VoiceErrorCode, string> = {
  unsupported_browser: "เบราว์เซอร์นี้ยังสั่งงานด้วยเสียงไม่ได้ — ใช้ Ctrl+K พิมพ์คำสั่งแทนได้",
  permission_denied: "ยังไม่ได้อนุญาตให้ใช้ไมโครโฟน — เปิดสิทธิ์ในเบราว์เซอร์แล้วลองใหม่ หรือใช้ Ctrl+K",
  no_speech: "ไม่ได้ยินเสียงพูด — กดปุ่มแล้วพูดอีกครั้ง",
  network: "เชื่อมต่อบริการรู้จำเสียงไม่ได้ — ตรวจอินเทอร์เน็ตแล้วลองใหม่ หรือใช้ Ctrl+K",
  aborted: "ยกเลิกการฟังแล้ว",
  timeout: "หมดเวลาฟัง — กดปุ่มแล้วพูดอีกครั้ง",
  service_error: "บริการรู้จำเสียงขัดข้อง — ใช้ Ctrl+K พิมพ์คำสั่งแทนได้",
};

/** ข้อความผลลัพธ์ที่ปลอดภัย (ไม่มีคำพูดของผู้ใช้อยู่ในนั้น) */
const RESULT_MESSAGE: Record<VoiceParseResult["resultCode"], string> = {
  matched: "รับคำสั่งแล้ว",
  empty_transcript: "ยังไม่ได้ยินคำสั่ง — ลองพูดใหม่อีกครั้ง",
  no_match: "ยังไม่รองรับคำสั่งนี้ — ใช้ Ctrl+K พิมพ์คำสั่งแทนได้",
  forbidden_command: "คำสั่งนี้ต้องทำบนหน้าจอ",
  invalid_quantity: "จำนวนไม่ถูกต้อง — ระบุจำนวนระหว่าง 1 ถึง 99",
  low_confidence: "ฟังไม่ชัด — ยังไม่ทำให้อัตโนมัติ ลองพูดใหม่หรือใช้ Ctrl+K",
};

/** ข้อความสถานะอยู่บนแถบหัวนานเท่านี้แล้วหายเอง — คำแนะนำที่หมดอายุแล้วสั่งงานผิด */
const MESSAGE_VISIBLE_MS = 8000;

/** คำตอบจาก onResult ที่ขอให้ฟังต่อได้ */
export interface VoiceResultResponse {
  readonly message: string;
  readonly listenAgain?: boolean;
}

/**
 * กันวนไม่รู้จบ: ถ้าไม่มีใครพูดจริง session จะจบด้วย timeout ซึ่งไม่ต่อให้อยู่แล้ว
 * แต่ยังตั้งเพดานไว้เผื่อกรณีที่ผู้เรียกขอ listenAgain ทุกครั้ง
 */
const MAX_AUTO_LISTEN_CHAIN = 3;

/** ใช้เมื่อได้ยินคำปลุกแล้วแต่เปิดไมค์เองไม่ได้ — ต้องบอกให้ชัดว่าต้องทำอะไรต่อ */
const WAKE_TAP_REQUIRED_MESSAGE = "ตรวจพบคำปลุก — แตะปุ่มไมค์เพื่อพูด";

const STATE_LABEL: Record<VoiceRecognitionState, string> = {
  idle: "สั่งงานด้วยเสียง",
  requesting: "กำลังขอไมโครโฟน…",
  listening: "กำลังฟัง… พูดคำสั่งได้เลย",
  resolving: "กำลังแปลคำสั่ง…",
  success: "สั่งงานด้วยเสียง",
  error: "สั่งงานด้วยเสียง",
};

export interface VoiceCommandButtonProps {
  /** ฉีด adapter ได้ (ทดสอบ/สลับ engine); ไม่ส่งมาจะใช้ Web Speech ของเบราว์เซอร์ */
  readonly adapter?: VoiceSpeechAdapter;
  /**
   * ผลของ parser — ผู้เรียกเป็นคนตัดสินใจทำต่อตาม decision เท่านั้น
   * คืน string ได้เพื่อให้ปุ่มประกาศข้อความของผู้เรียกแทนข้อความมาตรฐาน
   * (U14: ใช้ประกาศผลการนำทาง โดยยังมี live region เดียวไม่ให้ screen reader อ่านซ้ำ)
   */
  /**
   * คืนข้อความที่จะแสดง/อ่านออกเสียง คืนเป็น object ได้เมื่ออยากให้เปิดไมค์ต่อทันที
   * หลังพูดจบ (listenAgain) — ใช้ตอนระบบเพิ่งบอกว่า "ยังต้องเลือก …" ซึ่งขั้นถัดไป
   * คือคำสั่งเสียงอีกคำเสมอ การให้แคชเชียร์ต้องกดปุ่มซ้ำทั้งที่มือถือถาดอยู่คือแรงเสียดทาน
   */
  readonly onResult?: (
    result: VoiceParseResult,
    /**
     * คำพูดดิบของรอบนี้ — ส่งต่อให้ผู้เรียกใช้ "ภายในรอบเดียว" เท่านั้น
     * (ตัวเดียวกับที่ parser รับอยู่แล้ว) ห้ามเก็บลง state/ref/telemetry
     * ใช้ตอนที่บริบทบนหน้าจอบอกความหมายได้ เช่น หน้าต่างตัวเลือกเปิดอยู่แล้วผู้ใช้
     * พูดแค่ชื่อตัวเลือกโดยไม่มีคำว่า "เลือก" นำหน้า
     */
    transcript: string,
    /**
     * P5 — AI fallback เป็นงาน async ผู้เรียกจึงคืน Promise ได้
     * ระหว่างรอ ปุ่มค้างสถานะ "กำลังแปลคำสั่ง…" และไม่รับ final ซ้ำของรอบเดิม
     */
  ) => string | VoiceResultResponse | void | Promise<string | VoiceResultResponse | void>;
  /** เหตุการณ์ที่บันทึกได้ (ไม่มี transcript) — U16 จะต่อปลายทางจริง */
  readonly onTelemetry?: (event: VoiceTelemetryEvent) => void;
  readonly locale?: string;
  readonly disabled?: boolean;
  readonly className?: string;
  /**
   * ค่าเริ่มต้น false — screen reader จะได้ยินเฉพาะ "สถานะ" ไม่ใช่คำพูดของผู้ใช้
   * (คำพูดยังแสดงบนจอระหว่างฟัง แต่ถูกตัดออกจาก accessibility tree)
   */
  readonly announceTranscript?: boolean;
  /** ฉีดตัวเล่นเสียงตอบรับได้ (ทดสอบ/ปิดเสียง) — ไม่ส่งมาจะใช้ของเบราว์เซอร์ */
  readonly feedback?: VoiceFeedback;
  /**
   * W5 — สายคุยกับ StoreOS Launcher บน Windows (คำปลุก)
   * ไม่ส่งมา = ไม่มีคำปลุก ปุ่มทำงานแบบกดพูดเหมือนเดิมทุกประการ
   */
  readonly standbyHost?: WindowsVoiceHostAdapter;
}

export function VoiceCommandButton({
  adapter,
  onResult,
  onTelemetry,
  locale = "th-TH",
  disabled = false,
  className,
  announceTranscript = false,
  feedback,
  standbyHost,
}: VoiceCommandButtonProps) {
  const speech = useMemo(
    () => adapter ?? createBrowserSpeechAdapter({ locale }),
    [adapter, locale],
  );
  // U17 — ห้ามตัดสิน "รองรับไหม" ตอน render แรก: server ไม่มี window เลยได้ false เสมอ
  // ส่วน client ได้ true → ข้อความไม่ตรงกัน = hydration mismatch (React #418)
  // useSyncExternalStore ให้ snapshot ฝั่ง server เป็น null (ยังไม่รู้ = ปุ่มปิดไว้ก่อน)
  // แล้วสลับเป็นผลตรวจจริงของเบราว์เซอร์หลัง hydrate โดยไม่ต้อง setState ใน effect
  const supported = useSyncExternalStore<boolean | null>(
    useCallback(() => () => {}, []),
    useCallback(() => speech.isSupported(), [speech]),
    useCallback(() => null, []),
  );

  // U23 — เสียงตอบรับ: อ่านค่าของเครื่องหลัง hydrate (server snapshot = null กัน hydration mismatch)
  const soundOn = useSyncExternalStore<boolean | null>(
    subscribeVoiceFeedbackPreference,
    readVoiceFeedbackPreference,
    () => null,
  );
  const soundEnabled = soundOn ?? false;
  const player = useMemo<VoiceFeedback>(
    () => feedback ?? createBrowserVoiceFeedback({ locale, muted: !soundEnabled }),
    [feedback, locale, soundEnabled],
  );

  const [state, setState] = useState<VoiceRecognitionState>("idle");
  // transcript ชั่วคราวสำหรับแสดงผลระหว่างฟังเท่านั้น — ล้างทุกครั้งที่จบรอบ
  const [interim, setInterim] = useState("");
  const [message, setMessage] = useState("");
  const messageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** นับจำนวนครั้งที่ระบบเปิดไมค์ต่อให้เอง (รีเซ็ตเมื่อผู้ใช้กดปุ่มเอง) */
  const autoListenCountRef = useRef(0);
  const startListeningRef = useRef<((options?: { keepMessage?: boolean }) => void) | null>(null);
  const sessionRef = useRef<VoiceSpeechSession | null>(null);
  // U14 — กัน final ซ้ำจาก engine: 1 การกด = ส่งผลให้ผู้เรียกได้ครั้งเดียว
  const settledRef = useRef(false);
  /** รอบคำปลุกที่กำลังถืออยู่ (null = รอบนี้ผู้ใช้กดปุ่มเอง) — ต้องรายงานคืนให้ Launcher เสมอ */
  const standbySessionRef = useRef<string | null>(null);

  // unmount = ยกเลิก session ที่ค้าง และล้าง transcript ออกจากหน่วยความจำ
  useEffect(() => {
    return () => {
      sessionRef.current?.cancel();
      sessionRef.current = null;
      setInterim("");
      if (messageTimerRef.current) clearTimeout(messageTimerRef.current);
    };
  }, []);

  /**
   * ข้อความสถานะเป็นคำแนะนำ "ณ ตอนนั้น" (เช่น ให้พูดว่า "เลือก…") ถ้าค้างบนแถบหัว
   * ต่อไปเรื่อย ๆ มันจะสั่งงานที่จบไปแล้ว และกินความกว้างของแถบหัวถาวร จึงล้างเองหลัง
   * ผู้ใช้มีเวลาอ่าน/ฟังจบ (เสียงพูดที่ยาวสุดของระบบสั้นกว่านี้มาก)
   */
  const showMessage = useCallback((text: string) => {
    if (messageTimerRef.current) clearTimeout(messageTimerRef.current);
    setMessage(text);
    if (!text) return;
    messageTimerRef.current = setTimeout(() => {
      setMessage("");
      messageTimerRef.current = null;
    }, MESSAGE_VISIBLE_MS);
  }, []);

  const listening = state === "requesting" || state === "listening";
  // U24 — ระหว่างฟัง/แปลคำสั่ง แสดงผลเต็มจอให้เห็นจากอีกฝั่งเคาน์เตอร์ได้
  // overlay ไม่รับคลิก (pointer-events-none) แอปข้างหลังจึงยังกดได้ตามปกติ
  // = "ทำงานอยู่พื้นหลัง" ไม่ใช่ modal ที่บล็อกการขาย
  const overlayVisible = listening || state === "resolving";

  /** ปิดรอบคำปลุกและคืนไมค์ให้ Launcher — เรียกซ้ำได้ ไม่มีผลถ้าไม่ได้ถือรอบอยู่ */
  const endStandbySession = useCallback(
    (outcome: "completed" | "aborted" | "tap_required") => {
      const sessionId = standbySessionRef.current;
      if (!sessionId) return;
      standbySessionRef.current = null;
      standbyHost?.commandEnded(sessionId, outcome);
    },
    [standbyHost],
  );

  const startListening = useCallback((options?: { keepMessage?: boolean }) => {
    // เปิดไมค์ต่อเองต้องไม่ลบข้อความที่เพิ่งบอกไป — มันคือคำสั่งที่ผู้ใช้กำลังจะทำตาม
    // (เช่น "ยังต้องเลือก ระดับการคั่ว") ส่วนการกดปุ่มเองคือเริ่มคำสั่งใหม่ จึงล้างได้
    if (!options?.keepMessage) showMessage("");
    setInterim("");
    settledRef.current = false;
    player.stop();
    player.cue("listening");

    sessionRef.current = speech.start({
      onState: (next) => {
        setState(next);
        if (next === "idle" || next === "error") {
          sessionRef.current = null;
          setInterim("");
        }
      },
      onInterim: (text) => {
        setInterim(text);
      },
      onFinal: (transcript, confidence) => {
        // final ซ้ำของการกดเดียวกันต้องถูกทิ้ง (ไม่สั่งงานสองครั้ง)
        if (settledRef.current) return;
        settledRef.current = true;
        const result = parseVoiceCommand(transcript, { recognitionConfidence: confidence });
        // ล้าง transcript ทันทีหลัง parse — ห้ามค้างใน state หรือ ref
        setInterim("");
        onTelemetry?.(buildVoiceTelemetry(result, locale));

        // ผู้เรียกอาจต้องถาม AI ต่อ (async) — ระหว่างนั้นค้างสถานะ "กำลังแปลคำสั่ง…"
        setState("resolving");
        void Promise.resolve(onResult?.(result, transcript))
          .catch(() => undefined)
          .then((announcement) => {
            const response =
              typeof announcement === "string" || announcement === undefined || announcement === null
                ? { message: typeof announcement === "string" ? announcement : "" }
                : announcement;
            const spoken = response.message || RESULT_MESSAGE[result.resultCode];
            showMessage(spoken);
            // อ่านเฉพาะ "ข้อความของระบบ" — ไม่มีคำพูดดิบของผู้ใช้อยู่ในนั้น
            player.cue(result.decision === "execute" ? "success" : "error");
            // เปิดไมค์ต่อ "หลังระบบพูดจบ" เท่านั้น ไม่งั้นไมค์จะอัดเสียงที่ระบบกำลังพูดเอง
            const shouldListenAgain =
              response.listenAgain === true && autoListenCountRef.current < MAX_AUTO_LISTEN_CHAIN;
            // ยังคุยต่อ = ขอต่อเวลา watchdog ของ Launcher; จบรอบ = คืนไมค์ให้ทันที
            if (shouldListenAgain && standbySessionRef.current) {
              standbyHost?.commandExtended(standbySessionRef.current);
            } else {
              endStandbySession("completed");
            }
            player.speak(spoken, shouldListenAgain
              ? () => {
                autoListenCountRef.current += 1;
                startListeningRef.current?.({ keepMessage: true });
              }
              : undefined);
          });
      },
      onError: (code) => {
        if (settledRef.current) return;
        settledRef.current = true;
        setInterim("");
        // เปิดไมค์เองไม่ได้เพราะเบราว์เซอร์ไม่ให้ = ไม่ใช่ความผิดพลาดของอุปกรณ์
        // ต้องบอก Launcher ให้กลับไปฟังคำปลุกต่อ แล้วให้ผู้ใช้แตะปุ่มเอง
        endStandbySession(code === "permission_denied" ? "tap_required" : "aborted");
        showMessage(ERROR_MESSAGE[code]);
        player.cue("error");
        player.speak(ERROR_MESSAGE[code]);
      },
    });
  }, [endStandbySession, locale, onResult, onTelemetry, player, showMessage, speech, standbyHost]);

  // startListening เรียกตัวเองผ่าน ref — ประกาศตรง ๆ จะเป็น use-before-define
  useEffect(() => {
    startListeningRef.current = startListening;
  }, [startListening]);

  const handleClick = useCallback(() => {
    if (disabled) return;

    // กดซ้ำระหว่างฟัง = ขอให้สรุปผล (push-to-talk แบบ toggle บนจอสัมผัส)
    if (sessionRef.current?.isActive()) {
      sessionRef.current.stop();
      return;
    }
    // กดเอง = เริ่มนับสายการฟังต่อเนื่องใหม่
    autoListenCountRef.current = 0;
    startListening();
  }, [disabled, startListening]);

  /**
   * รับคำปลุกจาก Launcher
   *
   * ข้อห้ามที่สำคัญที่สุดของ W5: <b>ห้ามสร้างคลิกปลอม</b>เพื่อข้าม user-activation
   * ของเบราว์เซอร์ — เราเรียกเส้นทางเดียวกับตอนกดปุ่มโดยตรง ถ้าเบราว์เซอร์ปฏิเสธ
   * (permission_denied) ก็บอกให้ผู้ใช้แตะเอง ไม่พยายามหลบด่านนั้น
   */
  useEffect(() => {
    if (!standbyHost?.available) return;

    const unsubscribe = standbyHost.subscribe((event) => {
      if (event.kind === "show-push-to-talk") {
        standbySessionRef.current = null;
        showMessage(WAKE_TAP_REQUIRED_MESSAGE);
        return;
      }
      if (event.kind !== "start-listening") return;

      // ปุ่มถูกปิดอยู่ (เช่นกำลังชำระเงิน) — คืนไมค์ทันที อย่าให้ Launcher รอจนหมดเวลา
      if (disabled || supported !== true || sessionRef.current?.isActive()) {
        standbyHost.commandEnded(event.sessionId, "tap_required");
        showMessage(WAKE_TAP_REQUIRED_MESSAGE);
        return;
      }

      standbySessionRef.current = event.sessionId;
      autoListenCountRef.current = 0;
      startListening();
      standbyHost.commandStarted(event.sessionId);
    });

    return unsubscribe;
  }, [disabled, showMessage, standbyHost, startListening, supported]);

  // ยังไม่รู้ผลตรวจ (render แรก/SSR) = ปิดปุ่มไว้ก่อน ปลอดภัยกว่าเปิดแล้วกดไม่ได้
  const unavailable = disabled || supported !== true;

  const overlay =
    overlayVisible && typeof document !== "undefined"
      ? createPortal(
          <div
            data-testid="voice-overlay"
            aria-hidden="true"
            className="pointer-events-none fixed inset-0 z-[90] flex flex-col items-center justify-center gap-4 bg-black/45 px-6 text-center backdrop-blur-[2px]"
          >
            <span
              className={`flex h-24 w-24 items-center justify-center rounded-full text-4xl ${
                state === "resolving" ? "bg-white/90" : "animate-pulse bg-red-500/90"
              }`}
            >
              {state === "resolving" ? "⏳" : "🎙️"}
            </span>
            <p className="text-2xl font-bold text-white drop-shadow">{STATE_LABEL[state]}</p>
            {interim ? (
              <p className="max-w-3xl text-3xl font-semibold italic text-white/95 drop-shadow">{interim}</p>
            ) : (
              <p className="text-base text-white/80">พูดคำสั่งได้เลย — กดปุ่มซ้ำเพื่อจบการฟัง</p>
            )}
            <p className="text-sm text-white/70">หน้าจอยังใช้งานได้ตามปกติระหว่างฟัง</p>
          </div>,
          document.body,
        )
      : null;

  return (
    // แถวเดียวแนวนอน — ปุ่มนี้อยู่บนแถบหัวของ POS ที่ความสูงมีค่า สถานะระหว่างฟัง
    // ไปแสดงบน overlay เต็มจอแทน ที่นี่จึงเหลือแค่บรรทัดสั้น ๆ
    <div className={`flex items-center gap-2 ${className ?? ""}`.trim()}>
      {overlay}
      <button
        type="button"
        data-testid="voice-mic"
        onClick={handleClick}
        disabled={unavailable}
        aria-disabled={unavailable}
        aria-pressed={listening}
        aria-label={STATE_LABEL[state]}
        title={
          supported === true
            ? "กดเพื่อพูดคำสั่ง (หรือกด Ctrl+K พิมพ์คำสั่ง)"
            : supported === false
              ? "เบราว์เซอร์นี้ยังสั่งงานด้วยเสียงไม่ได้ — ใช้ Ctrl+K แทน"
              : "กำลังตรวจสอบว่าเบราว์เซอร์นี้สั่งงานด้วยเสียงได้หรือไม่"
        }
        className={[
          // มือถือทำให้ใหญ่กดง่าย (แคชเชียร์ถือเครื่องมือข้างเดียว กดพลาดแล้วเสียจังหวะ)
          // เดสก์ท็อปกลับมาขนาดปกติเพราะมีเมาส์และที่บนแถบหัวมีจำกัด
          "inline-flex min-h-14 min-w-14 items-center gap-2 rounded-xl border px-4 py-2 text-base font-semibold",
          "sm:min-h-11 sm:min-w-11 sm:rounded-lg sm:px-3 sm:text-sm sm:font-medium",
          "transition-colors motion-reduce:transition-none",
          unavailable
            ? "cursor-not-allowed border-gray-200 bg-gray-50 text-gray-400"
            : listening
              ? "border-red-300 bg-red-50 text-red-700"
              : "border-gray-300 bg-white text-gray-700 hover:bg-gray-50",
        ].join(" ")}
      >
        <span aria-hidden="true">{listening ? "🔴" : "🎤"}</span>
        {/* ไม่มีแถวแท็บมาแย่งที่แล้ว ป้ายจึงโชว์ได้ทั้งบนมือถือและเดสก์ท็อป */}
        <span className="whitespace-nowrap">{STATE_LABEL[state]}</span>
      </button>

      {/* U23 — เปิด/ปิดเสียงตอบรับต่อเครื่อง (ครัวอาจปิด แคชเชียร์อาจเปิด) */}
      {soundOn !== null ? (
        <button
          type="button"
          onClick={() => {
            const next = !soundEnabled;
            writeVoiceFeedbackPreference(next);
            if (!next) player.stop();
          }}
          aria-pressed={soundEnabled}
          aria-label={soundEnabled ? "ปิดเสียงตอบรับ" : "เปิดเสียงตอบรับ"}
          title={soundEnabled ? "ปิดเสียงตอบรับ" : "เปิดเสียงตอบรับ"}
          className="inline-flex min-h-14 min-w-14 shrink-0 items-center justify-center rounded-xl border border-gray-300 bg-white text-base text-gray-700 transition-colors hover:bg-gray-50 motion-reduce:transition-none sm:min-h-11 sm:min-w-11 sm:rounded-lg sm:text-sm"
        >
          <span aria-hidden="true">{soundEnabled ? "🔊" : "🔇"}</span>
        </button>
      ) : null}

      {/* live region: ประกาศ "สถานะ" เท่านั้น — ไม่มีคำพูดของผู้ใช้ (ค่าเริ่มต้น) */}
      <p role="status" aria-live="polite" /* จอเล็กซ่อนด้วย sr-only ไม่ใช่ hidden — live region ต้องอยู่ใน a11y tree
             ไม่งั้น screen reader ไม่ประกาศสถานะบนมือถือ */
        /* not-sr-only ตั้ง white-space: normal ทับ truncate — ต้องบังคับ nowrap ซ้ำ
           ไม่งั้นข้อความยาวตัดเป็นสองบรรทัดแล้วดันความสูงแถบหัว */
        className="sr-only max-w-[14rem] truncate text-xs text-gray-600 sm:not-sr-only sm:block sm:min-w-0 sm:whitespace-nowrap">
        {announceTranscript && interim ? interim : message}
      </p>

      {/* คำพูดชั่วคราว: เห็นบนจอระหว่างฟัง แต่ถูกตัดออกจาก a11y tree เมื่อไม่ได้เปิด announceTranscript */}
      {interim && !announceTranscript ? (
        <p
          data-testid="voice-transcript"
          aria-hidden="true"
          className="hidden min-w-0 max-w-[14rem] truncate text-xs italic text-gray-500 sm:block"
        >
          {interim}
        </p>
      ) : null}

      {supported === false ? (
        <p className="max-w-[16rem] truncate text-xs text-gray-500" title={ERROR_MESSAGE.unsupported_browser}>{ERROR_MESSAGE.unsupported_browser}</p>
      ) : supported === null ? null : (
        /* U16 — แจ้งก่อนขอไมโครโฟน: เบราว์เซอร์อาจส่งเสียงออกนอกเครื่อง.
           ข้อความยังอยู่บนหน้าและอ่านได้ก่อนกดขอไมค์ แต่พับเป็นบรรทัดเดียว —
           สองบรรทัดเต็มกินความสูงหน้า POS ที่ต้องพอดีจอ */
        <details className="shrink-0 text-xs text-gray-500">
          <summary className="cursor-pointer select-none whitespace-nowrap">
            <span className="sm:hidden" aria-hidden="true">ⓘ</span>
            <span className="sr-only sm:not-sr-only">ความเป็นส่วนตัว / วิธีใช้</span>
          </summary>
          <p className="mt-1">
            ระบบไม่บันทึกเสียงหรือข้อความที่พูด แต่เบราว์เซอร์อาจส่งเสียงไปประมวลผลบนบริการของผู้ผลิตเบราว์เซอร์
          </p>
          <p className="mt-1">พิมพ์คำสั่งแทนได้เสมอ (Ctrl+K ในหน้าอื่น) หรือใช้ปุ่มบนหน้าจอ</p>
        </details>
      )}
    </div>
  );
}
