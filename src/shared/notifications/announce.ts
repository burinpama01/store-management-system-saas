"use client";

/**
 * เสียงพูดแจ้งเตือน (TTS ภาษาไทย) — ใช้คู่กับเสียง beep เดิมใน alert-sound.ts
 *
 * เจตนา: พนักงานที่มือไม่ว่างต้องรู้ว่า "ออเดอร์อะไรเข้า" โดยไม่ต้องมองจอ
 * beep เดิมบอกได้แค่ว่ามีของเข้า แต่ไม่บอกว่าเป็นโต๊ะหรือเดลิเวอรี
 *
 * กฎที่ห้ามละเมิด:
 *   1) ไม่มีเสียงไทยบนเครื่อง = **ห้ามพูด** ให้ถอยไป beep
 *      (Chromium จะหยิบเสียงอังกฤษมาอ่านไทยเป็นเสียงต่างดาว แย่กว่าไม่พูดเลย)
 *   2) พูดไม่ได้ต้องคืน false เสมอ เพื่อให้ผู้เรียกเล่น beep แทน — ห้ามเงียบสนิท
 *   3) พูดเฉพาะข้อความที่ระบบสร้างเอง ไม่เอาข้อมูลลูกค้า/ยอดเงินออกลำโพงหน้าร้าน
 */

export type VoicePreference = "store" | "on" | "off";

/** ค่าตั้งของ "เครื่องนี้" — ต่างเครื่องต่างตั้งได้ (แคชเชียร์เปิด เครื่องติดลูกค้าปิด) */
const DEVICE_PREF_KEY = "storeos.notify.voice";

export function readVoicePreference(): VoicePreference {
  if (typeof window === "undefined") return "store";
  try {
    const raw = window.localStorage.getItem(DEVICE_PREF_KEY);
    return raw === "on" || raw === "off" ? raw : "store";
  } catch {
    // โหมดส่วนตัว/localStorage ถูกปิด = ใช้ค่าของร้าน
    return "store";
  }
}

export function writeVoicePreference(pref: VoicePreference) {
  if (typeof window === "undefined") return;
  try {
    if (pref === "store") window.localStorage.removeItem(DEVICE_PREF_KEY);
    else window.localStorage.setItem(DEVICE_PREF_KEY, pref);
  } catch {
    /* เขียนไม่ได้ = ยังใช้ค่าของร้านต่อไป ไม่ต้องแจ้ง error */
  }
}

/** ค่าตั้ง 2 ชั้น: เครื่องมีสิทธิ์ขาดเหนือร้านเสมอ ("store" = ไม่ได้ตั้ง จึงตามร้าน) */
export function resolveVoiceEnabled(storeDefault: boolean, devicePref: VoicePreference): boolean {
  if (devicePref === "on") return true;
  if (devicePref === "off") return false;
  return storeDefault;
}

interface VoiceLike {
  lang: string;
  name: string;
  default?: boolean;
}

interface SynthLike {
  speak: (utterance: unknown) => void;
  cancel: () => void;
  getVoices: () => VoiceLike[];
  addEventListener?: (type: string, listener: () => void) => void;
}

interface SpeechWindowLike {
  speechSynthesis?: SynthLike;
  SpeechSynthesisUtterance?: new (text: string) => {
    text: string;
    lang: string;
    rate: number;
    volume: number;
    voice?: unknown;
  };
}

function resolveWindow(override?: SpeechWindowLike | null): SpeechWindowLike | null {
  if (override !== undefined) return override;
  if (typeof window === "undefined") return null;
  return window as unknown as SpeechWindowLike;
}

/** เสียงไทยตัวแรกที่เจอ (Windows = Pattara/Premwadee, Android = Google ไทย) */
export function pickThaiVoice(voices: VoiceLike[]): VoiceLike | null {
  return voices.find((voice) => voice.lang?.toLowerCase().startsWith("th")) ?? null;
}

/**
 * อุ่นเครื่องรายการเสียง — Chromium คืน getVoices() เป็น array ว่างในครั้งแรก
 * แล้วค่อยยิง event voiceschanged ทีหลัง ถ้าไม่เรียกตัวนี้ตอน mount
 * ออเดอร์ใบแรกของวันจะถอยไป beep ทั้งที่เครื่องมีเสียงไทยอยู่
 */
export function primeVoices(windowOverride?: SpeechWindowLike | null) {
  const win = resolveWindow(windowOverride);
  const synth = win?.speechSynthesis;
  if (!synth) return;
  try {
    synth.getVoices();
    synth.addEventListener?.("voiceschanged", () => {
      try {
        synth.getVoices();
      } catch {
        /* ไม่มีอะไรต้องทำต่อ */
      }
    });
  } catch {
    /* เครื่องนี้พูดไม่ได้ = ใช้ beep ต่อไป */
  }
}

export interface SpeakOptions {
  readonly window?: SpeechWindowLike | null;
  readonly rate?: number;
}

/**
 * อ่านข้อความออกเสียงภาษาไทย
 * @returns true เมื่อสั่งพูดได้จริง / false เมื่อพูดไม่ได้ (ผู้เรียกต้องเล่น beep แทน)
 */
export function speakAnnouncement(text: string, options: SpeakOptions = {}): boolean {
  const message = text.trim();
  if (!message) return false;

  const win = resolveWindow(options.window);
  const synth = win?.speechSynthesis;
  const Utterance = win?.SpeechSynthesisUtterance;
  if (!synth || typeof Utterance !== "function") return false;

  try {
    const thaiVoice = pickThaiVoice(synth.getVoices() ?? []);
    if (!thaiVoice) return false; // กฎข้อ 1 — ไม่มีเสียงไทยห้ามพูด

    // ตัดเสียงเก่าทิ้งก่อนเสมอ: ออเดอร์เข้าติด ๆ กันจะพูดทับกันจนฟังไม่รู้เรื่อง
    synth.cancel();
    const utterance = new Utterance(message);
    utterance.lang = thaiVoice.lang || "th-TH";
    utterance.voice = thaiVoice;
    utterance.rate = options.rate ?? 1;
    utterance.volume = 1;
    synth.speak(utterance);
    return true;
  } catch {
    return false;
  }
}

export function cancelAnnouncement(windowOverride?: SpeechWindowLike | null) {
  const win = resolveWindow(windowOverride);
  try {
    win?.speechSynthesis?.cancel();
  } catch {
    /* ไม่มีอะไรต้องทำต่อ */
  }
}
