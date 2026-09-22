// window.speechSynthesis แบบ polyfill สำหรับแอป Android (1.0.6+) — อ่านออกเสียงด้วย TTS ของเครื่อง
//
// ทำไมต้องมี: WebView ของแอปไม่มี speechSynthesis → เสียงพูดทุกจุดถอยไปเป็น beep
// (คำตอบรับคำสั่งเสียงใน POS, ประกาศออเดอร์, ปุ่มทดลองเสียงในตั้งค่า)
// แทนที่จะแก้ทีละจุด ติดตั้ง speechSynthesis + SpeechSynthesisUtterance ที่ส่งต่อไป
// @capacitor-community/text-to-speech — โค้ดเดิม (announce.ts / feedback.ts) ใช้ได้ทันที
// ติดตั้งเฉพาะเมื่ออยู่ในแอปและ WebView ไม่มี speechSynthesis ของตัวเอง

export interface NativeTtsPluginLike {
  speak(options: { text: string; lang: string; rate: number; pitch: number; volume: number; queueStrategy: number }): Promise<void>;
  stop(): Promise<void>;
  getSupportedLanguages(): Promise<{ languages?: string[] }>;
}

interface NativeWindowLike {
  Capacitor?: {
    isNativePlatform?: () => boolean;
    Plugins?: { TextToSpeech?: NativeTtsPluginLike };
  };
  speechSynthesis?: unknown;
  SpeechSynthesisUtterance?: unknown;
}

interface PolyfillVoice {
  readonly name: string;
  readonly lang: string;
  readonly voiceURI: string;
  readonly localService: boolean;
  readonly default: boolean;
}

/** สร้างคู่ speechSynthesis/SpeechSynthesisUtterance ที่ส่งงานต่อให้ plugin (แยกไว้ให้เทสต์ได้) */
export function createNativeSpeechSynthesis(plugin: NativeTtsPluginLike) {
  let voices: PolyfillVoice[] = [];
  const listeners = new Set<() => void>();
  // เลขรอบพูด — cancel() แล้ว utterance เก่าที่ค้างใน promise ห้ามยิง onend ซ้ำ/ผิดตัว
  let generation = 0;

  class NativeUtterance {
    text: string;
    lang = "th-TH";
    rate = 1;
    pitch = 1;
    volume = 1;
    voice: unknown = null;
    onstart: (() => void) | null = null;
    onend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(text: string) {
      this.text = text;
    }
  }

  const synth = {
    speaking: false,
    pending: false,
    paused: false,
    onvoiceschanged: null as (() => void) | null,
    getVoices: (): PolyfillVoice[] => voices,
    addEventListener: (type: string, listener: () => void) => {
      if (type === "voiceschanged") listeners.add(listener);
    },
    removeEventListener: (type: string, listener: () => void) => {
      if (type === "voiceschanged") listeners.delete(listener);
    },
    // รับ unknown ให้ตรงกับชนิด speechSynthesis ที่ announce/feedback ประกาศไว้
    speak: (input: unknown) => {
      const utterance = input as NativeUtterance;
      const mine = ++generation;
      synth.speaking = true;
      utterance.onstart?.();
      plugin
        .speak({
          text: utterance.text,
          lang: utterance.lang || "th-TH",
          rate: utterance.rate || 1,
          pitch: utterance.pitch || 1,
          volume: utterance.volume ?? 1,
          queueStrategy: 0, // 0 = ตัดเสียงก่อนหน้า (เหมือน cancel แล้วพูดใหม่)
        })
        .then(
          () => {
            if (mine !== generation) return;
            synth.speaking = false;
            utterance.onend?.();
          },
          () => {
            if (mine !== generation) return;
            synth.speaking = false;
            utterance.onerror?.();
          },
        );
    },
    cancel: () => {
      generation += 1;
      synth.speaking = false;
      void plugin.stop().catch(() => {});
    },
    pause: () => {},
    resume: () => {},
  };

  /** โหลดรายการภาษาจากเครื่อง — announce.ts จะพูดก็ต่อเมื่อมีเสียงไทย (ไม่มี = beep ตามเดิม) */
  const loadVoices = async () => {
    try {
      const { languages = [] } = await plugin.getSupportedLanguages();
      voices = languages.map((lang, index) => ({
        name: `Android ${lang}`,
        lang,
        voiceURI: `android-tts-${lang}`,
        localService: true,
        default: index === 0,
      }));
    } catch {
      voices = [];
    }
    synth.onvoiceschanged?.();
    for (const listener of listeners) listener();
  };

  return { synth, Utterance: NativeUtterance, loadVoices };
}

let installed = false;

/** เรียกครั้งเดียวตอนเปิดหน้า — บนเว็บปกติ/แอปรุ่นเก่าที่ไม่มี plugin ไม่ทำอะไร */
export function installNativeSpeechSynthesis(win: unknown = typeof window === "undefined" ? undefined : window): boolean {
  if (installed) return true;
  const target = win as NativeWindowLike | undefined;
  if (!target?.Capacitor?.isNativePlatform?.()) return false;
  const plugin = target.Capacitor.Plugins?.TextToSpeech;
  if (!plugin || typeof plugin.speak !== "function") return false;
  if (target.speechSynthesis) return false; // WebView มีของจริงอยู่แล้ว ใช้ของจริง

  const { synth, Utterance, loadVoices } = createNativeSpeechSynthesis(plugin);
  try {
    target.speechSynthesis = synth;
    target.SpeechSynthesisUtterance = Utterance;
  } catch {
    return false; // property อ่านอย่างเดียว = ติดตั้งไม่ได้ ใช้ beep ต่อไป
  }
  installed = true;
  void loadVoices();
  return true;
}
