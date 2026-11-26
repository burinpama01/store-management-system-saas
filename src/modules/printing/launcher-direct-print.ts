// พิมพ์ตรงผ่าน StoreOS POS Launcher (แผน POS Launcher Direct IP Printing v2 — เฟส D1)
//
// ต้องตรงกับ windows/StoreOS.Printing/PosBridgeProtocol.cs (ช่อง "storeos.pos")
// หน้าเดียวกันเปิดได้ทั้งในเบราว์เซอร์ / iPad / Launcher เดิม / POS Launcher:
//   * ไม่มี chrome.webview หรือไม่ตอบ hello ภายใน 1.5 วิ → ไม่ใช่ POS Launcher → ใช้ทางเดิม (Print Hub)
//   * ตอบ hello พร้อม capability "print.direct" → ส่งไบต์ใบเสร็จให้โปรแกรมยิง TCP เข้าเครื่องพิมพ์เอง
//     ไม่ผ่านคิวบนคลาวด์ (ตัดเวลารอคิว + ดาวน์โหลดงาน + แจ้งผลกลับ)

import type { Printer } from "@/modules/stores/types";

export const POS_CHANNEL = "storeos.pos";
export const DIRECT_PRINT_CAPABILITY = "print.direct";
export const POS_HELLO_TIMEOUT_MS = 1500;
/** โปรแกรมลองใหม่เองได้สูงสุด 3 ครั้ง (2+5 วิ) + ส่ง 30 วิ — รอเกินนี้ถือว่าไม่แน่ใจ */
export const DIRECT_PRINT_RESULT_TIMEOUT_MS = 60_000;

export type DirectPrintKind = "receipt" | "kitchen" | "test" | "table" | "other";

export interface DirectPrintOutcome {
  /** printed | failed (ยังไม่ได้ส่งอะไร กดซ้ำได้) | unknown (ส่งไปบางส่วน อาจออกกระดาษแล้ว) */
  readonly outcome: "printed" | "failed" | "unknown";
  readonly error: string | null;
  readonly attempts: number;
  readonly elapsedMs: number;
}

export interface DirectPrintRequest {
  readonly printerId?: string | null;
  readonly host: string;
  readonly port?: number | null;
  readonly bytesBase64: string;
  readonly kind: DirectPrintKind;
  readonly label?: string | null;
}

interface WebViewLike {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

type Pending = (message: Record<string, unknown>) => void;

let webview: WebViewLike | null | undefined;
let helloPromise: Promise<readonly string[] | null> | null = null;
/** hello ไม่มีคำตอบ (เช่นโปรแกรมยังโหลดไม่เสร็จตอนเปิดเครื่อง) — ถามใหม่ได้หลังเวลานี้ ไม่ต้องรีเฟรชหน้า */
let helloFailedAt = 0;
export const POS_HELLO_RETRY_MS = 10_000;
const pending = new Map<string, Pending>();
let listening = false;

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

function getWebView(): WebViewLike | null {
  if (webview === undefined) webview = detectWebView();
  if (webview && !listening) {
    listening = true;
    webview.addEventListener("message", (event) => {
      const data = event.data;
      if (!data || typeof data !== "object") return;
      const message = data as Record<string, unknown>;
      if (message.channel !== POS_CHANNEL) return;
      const key =
        message.type === "hello"
          ? "hello"
          : typeof message.jobId === "string"
            ? `job:${message.jobId}`
            : typeof message.requestId === "string"
              ? `req:${message.requestId}`
              : null;
      if (!key) return;
      const resolve = pending.get(key);
      if (resolve) {
        pending.delete(key);
        resolve(message);
      }
    });
  }
  return webview;
}

function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `j${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function waitFor(key: string, timeoutMs: number): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(key);
      resolve(null);
    }, timeoutMs);
    pending.set(key, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
  });
}

/** capability ของ POS Launcher (null = ไม่ได้เปิดใน POS Launcher) — ถามครั้งเดียวต่อหน้า */
export function getPosLauncherCapabilities(): Promise<readonly string[] | null> {
  if (helloPromise && !(helloFailedAt && Date.now() - helloFailedAt >= POS_HELLO_RETRY_MS)) return helloPromise;
  helloFailedAt = 0;
  const view = getWebView();
  if (!view) {
    helloPromise = Promise.resolve(null);
    return helloPromise;
  }
  helloPromise = (async () => {
    const reply = waitFor("hello", POS_HELLO_TIMEOUT_MS);
    try {
      view.postMessage({ channel: POS_CHANNEL, type: "hello.request" });
    } catch {
      return null;
    }
    const message = await reply;
    if (!message) {
      helloFailedAt = Date.now();
      return null;
    }
    return Array.isArray(message.capabilities)
      ? message.capabilities.filter((c): c is string => typeof c === "string").slice(0, 20)
      : [];
  })();
  return helloPromise;
}

export async function isDirectPrintAvailable(): Promise<boolean> {
  const capabilities = await getPosLauncherCapabilities();
  return Boolean(capabilities?.includes(DIRECT_PRINT_CAPABILITY));
}

/** เครื่องพิมพ์ที่พิมพ์ตรงได้ = เครื่องพิมพ์ IP/WiFi ที่ตั้ง IP ไว้ */
export function isDirectPrintablePrinter(printer: Pick<Printer, "type" | "ipAddress"> | null | undefined): boolean {
  return Boolean(printer && (printer.type === "ip" || printer.type === "escpos") && printer.ipAddress);
}

/** อ่านผลจากโปรแกรม — ข้อมูลเท่านั้น รูปทรงผิด = ไม่แน่ใจ */
export function parseDirectPrintResult(message: Record<string, unknown> | null): DirectPrintOutcome {
  if (!message) {
    // ไม่รู้ว่าโปรแกรมส่งไปถึงไหนแล้ว (อาจปิด/รีสตาร์ตกลางทาง) — คงเป็น unknown กันใบซ้ำ
    // แต่บอกวิธีเช็กให้ชัด: ดูกระดาษ หรือแท็บเครื่องพิมพ์ในโปรแกรมที่มีประวัติทุกงาน
    return {
      outcome: "unknown",
      error: "ไม่ได้รับผลจาก POS Launcher — ดูกระดาษหรือประวัติในแท็บเครื่องพิมพ์ก่อนกดพิมพ์ซ้ำ",
      attempts: 0,
      elapsedMs: 0,
    };
  }
  const outcome = message.outcome === "printed" || message.outcome === "failed" ? message.outcome : "unknown";
  return {
    outcome,
    error: typeof message.error === "string" ? message.error : outcome === "printed" ? null : "พิมพ์ไม่สำเร็จ",
    attempts: typeof message.attempts === "number" ? message.attempts : 0,
    elapsedMs: typeof message.elapsedMs === "number" ? message.elapsedMs : 0,
  };
}

export async function printDirect(request: DirectPrintRequest): Promise<DirectPrintOutcome> {
  const view = getWebView();
  if (!view) return { outcome: "failed", error: "ไม่ได้เปิดใน StoreOS POS Launcher", attempts: 0, elapsedMs: 0 };
  const jobId = newId();
  const reply = waitFor(`job:${jobId}`, DIRECT_PRINT_RESULT_TIMEOUT_MS);
  try {
    view.postMessage({
      channel: POS_CHANNEL,
      type: "print.job",
      jobId,
      printerId: request.printerId ?? null,
      host: request.host,
      port: request.port ?? 9100,
      bytesBase64: request.bytesBase64,
      kind: request.kind,
      label: request.label ? request.label.slice(0, 80) : null,
    });
  } catch {
    pending.delete(`job:${jobId}`);
    return { outcome: "failed", error: "ส่งงานให้ POS Launcher ไม่สำเร็จ", attempts: 0, elapsedMs: 0 };
  }
  return parseDirectPrintResult(await reply);
}

/** โยน error ภาษาไทยตามผล — ไม่ส่งต่อเข้า Hub เพราะ "unknown" อาจออกกระดาษไปแล้ว (กันใบซ้ำ) */
export function assertDirectPrinted(result: DirectPrintOutcome): void {
  if (result.outcome === "printed") return;
  if (result.outcome === "unknown") {
    // attempts 0 = ไม่ได้ผลกลับเลย ข้อความอธิบายในตัวแล้ว / >0 = ส่งไปบางส่วนแล้วหลุด
    throw new Error(
      result.attempts === 0
        ? (result.error ?? "ไม่ได้รับผลการพิมพ์")
        : `${result.error ?? "ส่งไม่ครบ"} — อาจพิมพ์ออกไปแล้วบางส่วน ตรวจกระดาษก่อนกดพิมพ์ซ้ำ`,
    );
  }
  throw new Error(result.error ?? "พิมพ์ไม่สำเร็จ");
}

/** เฉพาะเทสต์ */
export function __resetPosLauncherForTests(): void {
  webview = undefined;
  helloPromise = null;
  helloFailedAt = 0;
  pending.clear();
  listening = false;
}
