// ช่อง "อุปกรณ์ของเครื่อง" ระหว่างหน้าเว็บกับ StoreOS Launcher 0.5.0+ (ลำโพง / เสียงแจ้งเตือน / อัปเดต)
//
// ต้องตรงกับ windows/StoreOS.Launcher/Services/DeviceBridgeProtocol.cs
// แยกจากสายคำปลุก (voice-pos/windows-host.ts) โดยตั้งใจ — ช่องนี้ไม่แตะไมโครโฟน
//
// หน้าเดียวกันเปิดได้ทั้งในเบราว์เซอร์ปกติ / แอปมือถือ / Launcher:
//   * ไม่มี chrome.webview           → ไม่ใช่ Launcher ทุกอย่างเงียบ เล่นเสียงเองเหมือนเดิม
//   * มี chrome.webview แต่ไม่ตอบ hello → Launcher รุ่นเก่า (≤0.4.1) ชวนดาวน์โหลดรุ่นใหม่
//   * ตอบ hello พร้อม capability     → ส่งเสียงแจ้งเตือนให้ Launcher เล่นออกลำโพงที่เลือก

export const DEVICE_CHANNEL = "storeos.device";
/** Launcher รุ่นเก่าไม่ตอบ hello — รอเท่านี้แล้วถือว่าเป็นรุ่นเก่า */
export const HELLO_TIMEOUT_MS = 4000;

export type LauncherAlertSound = "order" | "qr" | "connect";

export interface LauncherSpeakerDevice {
  readonly id: string;
  readonly name: string;
  readonly isDefault: boolean;
}

export interface LauncherSpeakers {
  readonly devices: readonly LauncherSpeakerDevice[];
  readonly alertDeviceId: string | null;
  readonly alertVolume: number;
  readonly musicDeviceId: string | null;
  readonly musicRoutingSupported: boolean;
}

export interface LauncherUpdateStatus {
  /** idle | checking | downloading | ready | installing | failed | up_to_date */
  readonly state: string;
  readonly currentVersion: string;
  readonly version: string | null;
  readonly error: string | null;
}

export interface LauncherDeviceSnapshot {
  /** หน้านี้เปิดอยู่ใน WebView2 ของ Launcher (รุ่นไหนก็ได้) */
  readonly inLauncher: boolean;
  /** อยู่ใน Launcher แต่ไม่ตอบ hello = รุ่นก่อน 0.5.0 (อัปเดตตัวเองไม่ได้) */
  readonly legacy: boolean;
  readonly version: string | null;
  readonly capabilities: readonly string[];
  readonly speakers: LauncherSpeakers | null;
  readonly update: LauncherUpdateStatus | null;
}

interface WebViewLike {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

const EMPTY: LauncherDeviceSnapshot = {
  inLauncher: false,
  legacy: false,
  version: null,
  capabilities: [],
  speakers: null,
  update: null,
};

let snapshot: LauncherDeviceSnapshot = EMPTY;
let webview: WebViewLike | null = null;
let initialized = false;
const listeners = new Set<() => void>();

function setSnapshot(next: Partial<LauncherDeviceSnapshot>) {
  snapshot = { ...snapshot, ...next };
  for (const listener of listeners) listener();
}

function detectWebView(): WebViewLike | null {
  if (typeof window === "undefined") return null;
  const candidate = (window as unknown as { chrome?: { webview?: unknown } }).chrome?.webview as
    | Partial<WebViewLike>
    | undefined;
  if (!candidate || typeof candidate.postMessage !== "function" || typeof candidate.addEventListener !== "function") {
    return null;
  }
  return candidate as WebViewLike;
}

function send(type: string, payload: Record<string, unknown> = {}) {
  if (!webview) return;
  try {
    webview.postMessage({ channel: DEVICE_CHANNEL, type, ...payload });
  } catch {
    // Launcher กำลังปิด/เปลี่ยนหน้า — รอบหน้าค่อยคุยใหม่
  }
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** อ่านข้อความจาก Launcher — ข้อมูลเท่านั้น ไม่ใช่คำสั่ง; รูปทรงผิด = ทิ้ง */
export function parseDeviceMessage(data: unknown): Partial<LauncherDeviceSnapshot> | null {
  if (!data || typeof data !== "object") return null;
  const message = data as Record<string, unknown>;
  if (message.channel !== DEVICE_CHANNEL) return null;

  if (message.type === "hello") {
    const version = asString(message.version);
    const capabilities = Array.isArray(message.capabilities)
      ? message.capabilities.filter((c): c is string => typeof c === "string").slice(0, 20)
      : [];
    return version ? { version, capabilities, legacy: false } : null;
  }

  if (message.type === "speakers") {
    const devices = Array.isArray(message.devices)
      ? message.devices
          .filter((d): d is Record<string, unknown> => Boolean(d) && typeof d === "object")
          .map((d) => ({ id: asString(d.id) ?? "", name: asString(d.name) ?? "", isDefault: d.isDefault === true }))
          .filter((d) => d.id && d.name)
          .slice(0, 32)
      : [];
    const volume = typeof message.alertVolume === "number" ? Math.min(100, Math.max(0, Math.round(message.alertVolume))) : 100;
    return {
      speakers: {
        devices,
        alertDeviceId: asString(message.alertDeviceId),
        alertVolume: volume,
        musicDeviceId: asString(message.musicDeviceId),
        musicRoutingSupported: message.musicRoutingSupported === true,
      },
    };
  }

  if (message.type === "update.status") {
    const state = asString(message.state);
    const currentVersion = asString(message.currentVersion);
    if (!state || !currentVersion) return null;
    return {
      update: { state, currentVersion, version: asString(message.version), error: asString(message.error) },
    };
  }

  return null;
}

/** เริ่มคุยกับ Launcher (เรียกกี่ครั้งก็ได้) — ในเบราว์เซอร์ปกติไม่ทำอะไร */
export function initLauncherDevice(): void {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  webview = detectWebView();
  if (!webview) return;

  setSnapshot({ inLauncher: true });
  webview.addEventListener("message", (event) => {
    const update = parseDeviceMessage(event.data);
    if (update) setSnapshot(update);
  });
  send("hello.request");
  window.setTimeout(() => {
    if (!snapshot.version) setSnapshot({ legacy: true });
  }, HELLO_TIMEOUT_MS);
}

export function getLauncherDeviceSnapshot(): LauncherDeviceSnapshot {
  return snapshot;
}

export function getServerLauncherDeviceSnapshot(): LauncherDeviceSnapshot {
  return EMPTY;
}

export function subscribeLauncherDevice(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * ให้ Launcher เล่นเสียงแจ้งเตือนออกลำโพงที่เลือก — true = ส่งไปแล้ว ผู้เรียกไม่ต้องเล่นเอง
 * false = ไม่ใช่ Launcher ที่รองรับ (หรือยังไม่ตอบ hello) ให้เล่นด้วยเบราว์เซอร์ตามเดิม
 */
export function playAlertViaLauncher(sound: LauncherAlertSound): boolean {
  initLauncherDevice();
  if (!webview || !snapshot.capabilities.includes("alert-player")) return false;
  send("alert.play", { sound });
  return true;
}

export function requestLauncherSpeakers(): void {
  send("speakers.get");
}

export function saveLauncherSpeakers(input: {
  alertDeviceId: string | null;
  alertVolume: number;
  musicDeviceId: string | null;
}): void {
  send("speakers.set", {
    alertDeviceId: input.alertDeviceId ?? "",
    alertVolume: Math.min(100, Math.max(0, Math.round(input.alertVolume))),
    musicDeviceId: input.musicDeviceId ?? "",
  });
}

export function testLauncherAlert(): void {
  send("alert.test");
}

export function checkLauncherUpdate(): void {
  send("update.check");
}

/** ขอให้ติดตั้งรุ่นที่พร้อมแล้ว — Launcher ถามยืนยันกับคนหน้าเครื่องเองเสมอ */
export function installLauncherUpdate(): void {
  send("update.install");
}

/** สำหรับเทสต์เท่านั้น — ล้างสถานะให้ initLauncherDevice ตรวจ window ใหม่ */
export function resetLauncherDeviceForTests(): void {
  snapshot = EMPTY;
  initialized = false;
  webview = null;
  listeners.clear();
}
