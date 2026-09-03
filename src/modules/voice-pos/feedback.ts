// U23 — เสียงตอบรับของระบบ (R2)
// เจตนา: พนักงานมือไม่ว่าง (กำลังชงเครื่องดื่ม) ต้องรู้ผลคำสั่งโดยไม่ต้องมองจอ
//
// มี 2 ชั้น:
//   1) เสียงเตือนสั้น (beep) — เริ่มฟัง / สำเร็จ / ไม่สำเร็จ  ตอบสนองทันที ไม่ต้องรอสังเคราะห์เสียง
//   2) อ่านผลลัพธ์เป็นเสียงไทย (speechSynthesis) — บอกว่าระบบทำอะไรให้
//
// ข้อบังคับความเป็นส่วนตัว: พูดได้เฉพาะ "ข้อความผลลัพธ์ที่ระบบสร้างเอง" เท่านั้น
// ห้ามอ่านคำพูดดิบของผู้ใช้ (transcript) ออกมาไม่ว่ากรณีใด — ตัวเรียกส่งเฉพาะ announcement

export type VoiceCueKind = "listening" | "success" | "error";

export interface VoiceFeedback {
  /** เสียงเตือนสั้น — คืนทันที ไม่รอเสียงจบ */
  cue: (kind: VoiceCueKind) => void;
  /**
   * อ่านข้อความผลลัพธ์ (ข้อความของระบบเท่านั้น)
   * onEnd ถูกเรียกเมื่ออ่านจบ — และเรียกทันทีเมื่ออ่านไม่ได้/ปิดเสียงไว้ ผู้เรียก
   * จึงวางลำดับงานต่อจากเสียงได้โดยไม่ต้องเดาเวลา (ใช้เปิดไมค์ต่อโดยไม่อัดเสียงตัวเอง)
   */
  speak: (text: string, onEnd?: () => void) => void;
  /** หยุดเสียงที่ค้างอยู่ (ใช้ตอนเริ่มคำสั่งใหม่/unmount) */
  stop: () => void;
}

/** โครงขั้นต่ำของ speechSynthesis ที่ใช้จริง (ไม่ผูกกับ lib.dom เต็มรูป) */
export interface SpeechSynthesisLike {
  speak: (utterance: SpeechUtteranceLike) => void;
  cancel: () => void;
}

export interface SpeechUtteranceLike {
  text: string;
  lang: string;
  rate: number;
  volume: number;
  onend?: (() => void) | null;
  onerror?: (() => void) | null;
}

export interface VoiceFeedbackWindowLike {
  speechSynthesis?: SpeechSynthesisLike;
  SpeechSynthesisUtterance?: new (text: string) => SpeechUtteranceLike;
  AudioContext?: new () => AudioContextLike;
  webkitAudioContext?: new () => AudioContextLike;
}

export interface AudioContextLike {
  readonly currentTime: number;
  readonly destination: unknown;
  createOscillator: () => OscillatorLike;
  createGain: () => GainLike;
  close?: () => void;
}

export interface OscillatorLike {
  type: string;
  frequency: { value: number };
  connect: (target: unknown) => void;
  start: (when?: number) => void;
  stop: (when?: number) => void;
}

export interface GainLike {
  gain: { value: number };
  connect: (target: unknown) => void;
}

/** โทนเสียงของแต่ละสถานะ — สั้นและต่างกันพอให้แยกออกในร้านที่มีเสียงรบกวน */
const CUE_TONES: Record<VoiceCueKind, { readonly hz: number; readonly ms: number }> = {
  listening: { hz: 880, ms: 90 },
  success: { hz: 1320, ms: 110 },
  error: { hz: 320, ms: 220 },
};

export interface VoiceFeedbackOptions {
  readonly window?: VoiceFeedbackWindowLike | null;
  readonly locale?: string;
  /** ปิดเสียงทั้งหมด (ผู้ใช้กดปิดเอง) */
  readonly muted?: boolean;
  /** ความเร็วการอ่าน — เร็วกว่าปกติเล็กน้อยให้ทันจังหวะหน้าร้าน */
  readonly rate?: number;
}

const NOOP_FEEDBACK: VoiceFeedback = {
  cue: () => {},
  // ปิดเสียงไว้ = ถือว่า "พูดจบ" ทันที ไม่งั้นงานที่รอเสียงจบจะไม่เกิดเลย
  speak: (_text, onEnd) => onEnd?.(),
  stop: () => {},
};

function resolveWindow(options: VoiceFeedbackOptions): VoiceFeedbackWindowLike | null {
  if (options.window !== undefined) return options.window;
  return (globalThis as unknown as VoiceFeedbackWindowLike | undefined) ?? null;
}

/**
 * ตัวเล่นเสียงตอบรับของเบราว์เซอร์ — ไม่มีไฟล์เสียง ไม่มี network
 * ทุกอย่างห่อ try/catch: เสียงเป็นของเสริม ห้ามทำให้คำสั่งหลักพัง
 */
export function createBrowserVoiceFeedback(options: VoiceFeedbackOptions = {}): VoiceFeedback {
  if (options.muted) return NOOP_FEEDBACK;
  const win = resolveWindow(options);
  if (!win) return NOOP_FEEDBACK;

  const locale = options.locale ?? "th-TH";
  const rate = options.rate ?? 1.1;
  let audioContext: AudioContextLike | null = null;

  const getAudioContext = (): AudioContextLike | null => {
    if (audioContext) return audioContext;
    const Ctor = win.AudioContext ?? win.webkitAudioContext;
    if (typeof Ctor !== "function") return null;
    try {
      audioContext = new Ctor();
      return audioContext;
    } catch {
      return null;
    }
  };

  return {
    cue: (kind) => {
      const context = getAudioContext();
      if (!context) return;
      try {
        const tone = CUE_TONES[kind];
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = "sine";
        oscillator.frequency.value = tone.hz;
        gain.gain.value = 0.06; // เบา ๆ พอได้ยิน ไม่รบกวนลูกค้า
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.start();
        oscillator.stop(context.currentTime + tone.ms / 1000);
      } catch {
        // เสียงเตือนเล่นไม่ได้ = ไม่เป็นไร คำสั่งยังทำงานปกติ
      }
    },
    speak: (text, onEnd) => {
      // เรียก onEnd ได้ครั้งเดียวเสมอ — onend กับ onerror อาจยิงทั้งคู่ในบางเบราว์เซอร์
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        onEnd?.();
      };
      const synth = win.speechSynthesis;
      const Utterance = win.SpeechSynthesisUtterance;
      if (!synth || typeof Utterance !== "function") {
        finish();
        return;
      }
      const message = text.trim();
      if (!message) {
        finish();
        return;
      }
      try {
        synth.cancel();
        const utterance = new Utterance(message);
        utterance.lang = locale;
        utterance.rate = rate;
        utterance.volume = 1;
        utterance.onend = finish;
        utterance.onerror = finish;
        synth.speak(utterance);
      } catch {
        // อ่านออกเสียงไม่ได้ = ผู้ใช้ยังเห็นข้อความบนจออยู่แล้ว
        finish();
      }
    },
    stop: () => {
      try {
        win.speechSynthesis?.cancel();
      } catch {
        // ไม่มีอะไรต้องทำต่อ
      }
    },
  };
}
