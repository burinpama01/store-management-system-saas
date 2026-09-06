// W5 — ฝั่งเว็บของสายคุยกับ StoreOS Launcher บน Windows
//
// หน้าเว็บเดียวกันนี้ถูกเปิดทั้งในเบราว์เซอร์ปกติและใน WebView2 ของ Launcher
// โมดูลนี้ทำให้ "รู้ว่าอยู่ที่ไหน" โดยไม่เดาจาก user-agent และไม่พังเมื่อไม่มี host
//
// ขอบเขตที่ยึด (เหมือนฝั่ง native):
//   * ข้อความจาก host คือ "ข้อมูล" ไม่ใช่ "คำสั่ง" — บอกได้แค่ว่าได้ยินคำปลุก
//     การตีความและลงมือทำยังเป็นของโมดูลเดิมทั้งหมด
//   * wake หนึ่งครั้ง = สิทธิ์เปิดไมค์หนึ่งรอบ ไม่ใช่สิทธิ์ทำรายการ
//   * ห้ามสร้างคลิกปลอมเพื่อข้าม user-activation ของเบราว์เซอร์ — เปิดไมค์เองไม่ได้
//     ต้องบอกให้ผู้ใช้แตะปุ่มเดิม

import {
  StandbyBridge,
  type StandbyBridgeEvent,
  type StandbyOutboundMessage,
} from "./standby-contract";

/** ผลของรอบคำสั่งที่รายงานกลับไปให้ host รู้ว่าคืนไมค์ได้แล้ว */
export type CommandOutcome = "completed" | "aborted" | "tap_required";

/** ส่วนของ chrome.webview ที่เราใช้จริง (ไม่ผูกกับ type ของ WebView2 ทั้งก้อน) */
export interface WindowsWebViewLike {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

export interface WindowsVoiceHostAdapter {
  /** true เฉพาะเมื่อหน้านี้ถูกเปิดใน Launcher จริง — เบราว์เซอร์ปกติได้ false โดยไม่ error */
  readonly available: boolean;
  /** รับเหตุการณ์คำปลุก คืนฟังก์ชันสำหรับเลิกรับ */
  subscribe(listener: (event: StandbyBridgeEvent) => void): () => void;
  /** บอก host ว่าเว็บถือไมค์แล้ว */
  commandStarted(sessionId: string): void;
  /** ยังคุยต่อในรอบเดิม — ขอต่อเวลา watchdog ของ host */
  commandExtended(sessionId: string): void;
  /** จบรอบและคืนไมค์ */
  commandEnded(sessionId: string, outcome: CommandOutcome): void;
  dispose(): void;
}

export interface WindowsVoiceHostOptions {
  /** ฉีดของปลอมได้ในเทสต์; ไม่ส่งมาจะมองหา window.chrome.webview เอง */
  readonly webview?: WindowsWebViewLike | null;
  /** เว็บพร้อมเปิดไมค์ไหม (ไม่ได้กำลังฟังอยู่ / เบราว์เซอร์รองรับ) */
  readonly canStartListening?: () => boolean;
}

/**
 * ตรวจว่าวัตถุที่ได้มาใช้เป็นสายคุยได้จริง
 *
 * ต้องตรวจทุกเมธอดที่จะเรียก ไม่ใช่แค่ว่า "มีวัตถุอยู่" — ของที่ขาดเมธอดจะทำให้
 * หน้า POS ล้มตั้งแต่ตอนสร้าง adapter ซึ่งแปลว่าขายของไม่ได้ทั้งหน้าเพราะฟีเจอร์เสริม
 */
function asWebView(candidate: unknown): WindowsWebViewLike | null {
  if (!candidate || typeof candidate !== "object") return null;

  const view = candidate as Partial<WindowsWebViewLike>;
  if (typeof view.postMessage !== "function") return null;
  if (typeof view.addEventListener !== "function") return null;
  if (typeof view.removeEventListener !== "function") return null;
  return view as WindowsWebViewLike;
}

/** อ่าน chrome.webview แบบไม่พังบน server และไม่พังบนเบราว์เซอร์ที่ไม่มี */
function detectWebView(): WindowsWebViewLike | null {
  if (typeof window === "undefined") return null;
  return asWebView((window as unknown as { chrome?: { webview?: unknown } }).chrome?.webview);
}

/** อะแดปเตอร์เปล่าสำหรับเบราว์เซอร์ปกติ — ทุกเมธอดเงียบ ไม่มี error ให้ผู้เรียกต้องดัก */
const UNAVAILABLE: WindowsVoiceHostAdapter = {
  available: false,
  subscribe: () => () => {},
  commandStarted: () => {},
  commandExtended: () => {},
  commandEnded: () => {},
  dispose: () => {},
};

export function createWindowsVoiceHost(options?: WindowsVoiceHostOptions): WindowsVoiceHostAdapter {
  const webview = options?.webview === undefined ? detectWebView() : asWebView(options.webview);
  if (!webview) return UNAVAILABLE;

  const listeners = new Set<(event: StandbyBridgeEvent) => void>();
  const bridge = new StandbyBridge({
    send: (message: StandbyOutboundMessage) => {
      if (disposed) return;
      webview.postMessage(message);
    },
    canStartListening: options?.canStartListening ?? (() => true),
  });
  let disposed = false;

  const onMessage = (event: { data: unknown }) => {
    if (disposed) return;
    // ทุกข้อความผ่านด่านเดียวกับฝั่ง native: รูปทรงผิด/ซ้ำ/ย้อนหลัง ถูกทิ้งเงียบ
    const decision = bridge.handle(event.data);
    if (decision.kind === "ignored") return;
    for (const listener of listeners) listener(decision);
  };

  webview.addEventListener("message", onMessage);

  return {
    available: true,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    commandStarted(sessionId) {
      bridge.notifyListeningStarted(sessionId);
    },
    commandExtended(sessionId) {
      bridge.notifyTurnContinued(sessionId);
    },
    commandEnded(sessionId, outcome) {
      bridge.notifyListeningEnded(sessionId, outcome);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      webview.removeEventListener("message", onMessage);
    },
  };
}
