"use client";

// U13 — Voice foundation (R2) · ปุ่ม push-to-talk
// หน้าที่เดียว: คุม 1 รอบการฟัง → ส่ง final transcript เข้า parser → คืน VoiceParseResult ให้ผู้เรียก
// ปุ่มนี้ "ไม่" ลงมือทำอะไรกับ router/ตะกร้าเอง — U14/U15 เป็นผู้รับผลไปทำต่อ
//
// กฎความเป็นส่วนตัวที่บังคับในไฟล์นี้:
//   - transcript อยู่ใน state ชั่วคราวเท่านั้น และถูกล้างทันทีหลัง parse / timeout / unmount
//   - ห้าม console.log / ส่ง transcript ออกนอกคอมโพเนนต์ (ผู้เรียกได้เฉพาะ intent + result code)

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseVoiceCommand } from "@/modules/voice-pos/parser";
import {
  createBrowserSpeechAdapter,
  type VoiceSpeechAdapter,
  type VoiceSpeechSession,
} from "@/modules/voice-pos/speech-adapter";
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
  /** ผลของ parser — ผู้เรียกเป็นคนตัดสินใจทำต่อตาม decision เท่านั้น */
  readonly onResult?: (result: VoiceParseResult) => void;
  /** เหตุการณ์ที่บันทึกได้ (ไม่มี transcript) — U16 จะต่อปลายทางจริง */
  readonly onTelemetry?: (event: VoiceTelemetryEvent) => void;
  readonly locale?: string;
  readonly disabled?: boolean;
  readonly className?: string;
}

export function VoiceCommandButton({
  adapter,
  onResult,
  onTelemetry,
  locale = "th-TH",
  disabled = false,
  className,
}: VoiceCommandButtonProps) {
  const speech = useMemo(
    () => adapter ?? createBrowserSpeechAdapter({ locale }),
    [adapter, locale],
  );
  const supported = useMemo(() => speech.isSupported(), [speech]);

  const [state, setState] = useState<VoiceRecognitionState>("idle");
  // transcript ชั่วคราวสำหรับแสดงผลระหว่างฟังเท่านั้น — ล้างทุกครั้งที่จบรอบ
  const [interim, setInterim] = useState("");
  const [message, setMessage] = useState("");
  const sessionRef = useRef<VoiceSpeechSession | null>(null);

  // unmount = ยกเลิก session ที่ค้าง และล้าง transcript ออกจากหน่วยความจำ
  useEffect(() => {
    return () => {
      sessionRef.current?.cancel();
      sessionRef.current = null;
      setInterim("");
    };
  }, []);

  const listening = state === "requesting" || state === "listening";

  const handleClick = useCallback(() => {
    if (disabled) return;

    // กดซ้ำระหว่างฟัง = ขอให้สรุปผล (push-to-talk แบบ toggle บนจอสัมผัส)
    if (sessionRef.current?.isActive()) {
      sessionRef.current.stop();
      return;
    }

    setMessage("");
    setInterim("");

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
        const result = parseVoiceCommand(transcript, { recognitionConfidence: confidence });
        // ล้าง transcript ทันทีหลัง parse — ห้ามค้างใน state หรือ ref
        setInterim("");
        setMessage(RESULT_MESSAGE[result.resultCode]);
        onTelemetry?.(buildVoiceTelemetry(result, locale));
        onResult?.(result);
      },
      onError: (code) => {
        setInterim("");
        setMessage(ERROR_MESSAGE[code]);
      },
    });
  }, [disabled, locale, onResult, onTelemetry, speech]);

  const unavailable = disabled || !supported;

  return (
    <div className={className}>
      <button
        type="button"
        onClick={handleClick}
        disabled={unavailable}
        aria-disabled={unavailable}
        aria-pressed={listening}
        aria-label={STATE_LABEL[state]}
        title={
          supported
            ? "กดเพื่อพูดคำสั่ง (หรือกด Ctrl+K พิมพ์คำสั่ง)"
            : "เบราว์เซอร์นี้ยังสั่งงานด้วยเสียงไม่ได้ — ใช้ Ctrl+K แทน"
        }
        className={[
          // touch target ขั้นต่ำ 44px ตามเกณฑ์ของแผน
          "inline-flex min-h-11 min-w-11 items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium",
          unavailable
            ? "cursor-not-allowed border-gray-200 bg-gray-50 text-gray-400"
            : listening
              ? "border-red-300 bg-red-50 text-red-700"
              : "border-gray-300 bg-white text-gray-700 hover:bg-gray-50",
        ].join(" ")}
      >
        <span aria-hidden="true">{listening ? "🔴" : "🎤"}</span>
        <span>{STATE_LABEL[state]}</span>
      </button>

      {/* live region: สถานะ/ผลลัพธ์ + คำพูดชั่วคราว (ล้างทันทีเมื่อจบรอบ) */}
      <p role="status" aria-live="polite" className="mt-1 min-h-5 text-xs text-gray-600">
        {interim ? interim : message}
      </p>

      {!supported ? (
        <p className="text-xs text-gray-500">{ERROR_MESSAGE.unsupported_browser}</p>
      ) : (
        <p className="text-xs text-gray-500">ใช้ Ctrl+K พิมพ์คำสั่งได้เสมอ</p>
      )}
    </div>
  );
}
