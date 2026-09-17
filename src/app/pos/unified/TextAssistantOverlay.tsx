"use client";

// PR2 — ผู้ช่วย AI โหมดข้อความบนหน้าขาย (ADR-008: ปุ่มแยกจาก Voice POS ไม่แทนที่)
// ข้อบังคับ:
//   - ไม่มีไมค์ ไม่มีการ capture เสียงทุกชนิด — Voice POS ยังเป็นเจ้าของไมค์ฝ่ายเดียว
//   - ทุกคำสั่งเดินผ่าน /api/ai-assistant/text-command เท่านั้น (deterministic parser → AI → tool)
//   - ผลที่อนุมัติผลักเข้าตะกร้าผ่าน bridge เดิม (applyVoiceCartIntent) — ไม่มีตะกร้าคู่ขนาน
//   - bridge ไม่พร้อม (หน้าขาย legacy/ยัง mount ไม่จบ) = แสดงสถานะปิด ไม่ crash (fail closed)
//   - ข้อความของผู้ใช้ไม่ถูกแสดงซ้ำใน log ของแผง (เดินตามข้อตกลงความเป็นส่วนตัวของเสียง)

import { useCallback, useEffect, useRef, useState } from "react";
import { useVoiceCartApi } from "./voice-cart-bridge";
import type { VoiceProductAlias } from "@/modules/voice-pos/cart";
import {
  createTextAssistantCore,
  type TextAssistantCore,
  type TextAssistantState,
  type TextCommandRequestBody,
  type TextCommandResponse,
} from "@/modules/ai-assistant/ui/text-assistant-core";
import {
  createLiveAssistantCore,
  type LiveAssistantCore,
  type LiveAssistantState,
  type LiveSessionResponse,
  type LiveToolRequestBody,
  type LiveToolRelayResponse,
} from "@/modules/ai-assistant/ui/live-assistant-core";
import { connectLiveWebRtc } from "@/modules/ai-assistant/ui/live-webrtc";
import { createAssistantCartId, ASSISTANT_CART_ID_PATTERN, TEXT_COMMAND_MAX_LENGTH } from "@/modules/ai-assistant/ui/text-assistant-ui";

export interface TextAssistantOverlayProps {
  /** คำเรียกเมนูของร้าน — ชุดเดียวกับ Voice POS (ผ่านให้ applyVoiceCartIntent) */
  readonly productAliases?: readonly VoiceProductAlias[];
  /** กลับไปแท็บขายหลังผู้ช่วยแก้ตะกร้า/เปิด dialog สินค้า (พฤติกรรมเดียวกับเสียง) */
  readonly onFocusSell?: () => void;
  /** PR3-Live (ADR-008) — ปุ่มเสียงสด "AI Live" (server เปิดให้เฉพาะ liveEnabled + org ใน pilot) */
  readonly liveEnabled?: boolean;
}

function readReason(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const reason = (payload as { reason?: unknown }).reason;
  return typeof reason === "string" && reason.length > 0 ? reason : null;
}

// binding ของแท็บเก็บต่อแท็บใน sessionStorage — reload/นำทางกลับมา = ใช้ id + version เดิมแล้ว
// server ยังผูก session เดิมให้ (session ผูกตะกร้า 1 ใบตลอดอายุ และปฏิเสธ version ย้อนหลัง)
// ถ้า version เคาะกลับมา 0 ทุก mount ผู้ช่วยจะโดน CONTEXT_UNAVAILABLE จนครบ TTL 30 นาที (M4 review)
const CART_ID_STORAGE_KEY = "ai-assistant:active-cart-binding";

interface StoredCartBinding {
  readonly cartId: string;
  readonly cartVersion: number;
}

function readStoredBinding(): StoredCartBinding | null {
  try {
    const raw = sessionStorage.getItem(CART_ID_STORAGE_KEY);
    if (typeof raw !== "string" || raw.length === 0) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const cartId = (parsed as { cartId?: unknown }).cartId;
    const cartVersion = (parsed as { cartVersion?: unknown }).cartVersion;
    if (typeof cartId !== "string" || !ASSISTANT_CART_ID_PATTERN.test(cartId)) return null;
    if (typeof cartVersion !== "number" || !Number.isSafeInteger(cartVersion) || cartVersion < 0) return null;
    return { cartId, cartVersion };
  } catch {
    return null; // โหมดส่วนตัว/JSON พัง — เริ่ม binding ใหม่ได้
  }
}

function writeStoredBinding(binding: StoredCartBinding): void {
  try {
    sessionStorage.setItem(CART_ID_STORAGE_KEY, JSON.stringify(binding));
  } catch {
    // เขียนไม่ได้ = ยอมรับ binding ชั่วคราว (fail ฝั่งความจำ ไม่กระทบความถูกต้อง)
  }
}

/** ตัวเรียกจริงของแผง — HTTP ไม่ 200 / JSON พัง = reason ตัวเดียว ไม่ปล่อยข้อความดิบเข้า UI */
async function sendTextCommand(body: TextCommandRequestBody): Promise<TextCommandResponse> {
  let response: Response;
  try {
    response = await fetch("/api/ai-assistant/text-command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, reason: "network_error" };
  }
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) return { ok: false, reason: readReason(payload) ?? "network_error" };
  return (payload && typeof payload === "object" ? payload : { ok: false, reason: "network_error" }) as TextCommandResponse;
}

// ── PR3-Live — ตัวเรียกจริงของช่องทางเสียงสด (รูปแบบเดียวกับ sendTextCommand: JSON พัง = reason เดียว,
// ข้อความ/เสียงของผู้ใช้ไม่มีใน body ของช่องทางนี้อยู่แล้ว — เสียงเดินทางผ่าน WebRTC ตรงถึง provider) ──

async function createLiveSession(body: { activeCartId: string }): Promise<LiveSessionResponse> {
  let response: Response;
  try {
    response = await fetch("/api/ai-assistant/live/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, reason: "network_error" };
  }
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) return { ok: false, reason: readReason(payload) ?? "network_error" };
  return (payload && typeof payload === "object" ? payload : { ok: false, reason: "network_error" }) as LiveSessionResponse;
}

async function relayLiveTool(body: LiveToolRequestBody): Promise<LiveToolRelayResponse> {
  let response: Response;
  try {
    response = await fetch("/api/ai-assistant/live/tool", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, reason: "network_error" };
  }
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) return { ok: false, reason: readReason(payload) ?? "network_error" };
  return (payload && typeof payload === "object" ? payload : { ok: false, reason: "network_error" }) as LiveToolRelayResponse;
}

/** ปิดเซสชันบน server แบบ best-effort — keepalive กันโดนตัดตอนตอนปิดแท็บ; ไมค์ถูกปิดในเครื่องเสมอ */
async function endLiveSession(body: { sessionId: string; sessionToken: string }): Promise<unknown> {
  try {
    await fetch("/api/ai-assistant/live/session", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true,
    });
  } catch {
    // best-effort ตาม design ของ core — ความล้มเหลวนี้ไม่กระทบ UI
  }
  return null;
}

export function TextAssistantOverlay({ productAliases = [], onFocusSell, liveEnabled = false }: TextAssistantOverlayProps) {
  const getCartApi = useVoiceCartApi();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");

  // core สร้างครั้งเดียวต่อ mount ใน effect (activeCartId คงเส้นตาย — server ผูกตะกร้า 1 ใบ
  // ต่อ session การสร้างใหม่กลางทาง = binding ถูกปฏิเสธ) — deps ที่ค่าเปลี่ยนได้ตาม render
  // อ่านผ่าน ref ที่หุ้มด้วย useCallback คงตัว และตัว core เองถูกแตะเฉพาะใน event/effect
  const coreRef = useRef<TextAssistantCore | null>(null);
  const liveCoreRef = useRef<LiveAssistantCore | null>(null);
  // ข้อความค้างของเซสชันเสียงสดตอนปิดแล้ว (หรือความล้มเหลวตอนเริ่ม) — ตั้งจาก subscription
  // (event-driven ไม่ใช่ effect) แล้วล้างเองหลัง 8 วินาที กัน "ปิดเซสชันแล้วหายเงียบ"
  const lastLiveEntryIdRef = useRef(0);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [liveNotice, setLiveNotice] = useState<{ readonly level: "assistant" | "error"; readonly message: string } | null>(null);
  const liveProps = useRef({ productAliases, onFocusSell });
  useEffect(() => {
    liveProps.current = { productAliases, onFocusSell };
  });
  const getProductAliases = useCallback(() => liveProps.current.productAliases, []);
  const notifyFocusSell = useCallback(() => liveProps.current.onFocusSell?.(), []);
  const [state, setState] = useState<TextAssistantState>({ entries: [], busy: false, undo: null, cartVersion: 0 });
  const [liveState, setLiveState] = useState<LiveAssistantState>({ phase: "idle", status: null, entries: [], toolCallsUsed: 0, toolCallsCap: null });
  useEffect(() => {
    if (!coreRef.current) {
      // reuse binding เดิมของแท็บถ้ามี (รูปแบบไม่ผ่าน = core สร้างใหม่เอง) แล้วจดไว้สำหรับ mount ถัดไป
      const stored = readStoredBinding();
      const cartId = stored?.cartId ?? createAssistantCartId();
      writeStoredBinding({ cartId, cartVersion: stored?.cartVersion ?? 0 });
      coreRef.current = createTextAssistantCore({
        cartId,
        initialCartVersion: stored?.cartVersion ?? 0,
        getCartApi,
        sendCommand: sendTextCommand,
        getProductAliases,
        onFocusSell: notifyFocusSell,
      });
      // PR3-Live — core เสียงสดใช้ binding ตะกร้าใบเดียวกัน (server ของช่องทาง Live แยกจากโหมดข้อความ)
      if (liveEnabled) {
        liveCoreRef.current = createLiveAssistantCore({
          cartId,
          getCartApi,
          getProductAliases,
          onFocusSell: notifyFocusSell,
          createSession: createLiveSession,
          relayTool: relayLiveTool,
          endSession: endLiveSession,
          connect: connectLiveWebRtc,
        });
      }
    }
    const core = coreRef.current;
    const liveCore = liveCoreRef.current;
    const unsubscribeText = core.subscribe(() => {
      // version ไต่ขึ้นทุกครั้งที่แก้ตะกร้าสำเร็จ — จดกลับ storage ทุกจังหวะ state เปลี่ยน
      setState(core.getState());
      writeStoredBinding({ cartId: core.cartId, cartVersion: core.getState().cartVersion });
    });
    const unsubscribeLive = liveCore?.subscribe(() => {
      const next = liveCore.getState();
      setLiveState(next);
      const last = next.entries.length > 0 ? next.entries[next.entries.length - 1] : null;
      if (next.phase !== "idle") {
        if (last) lastLiveEntryIdRef.current = last.id;
        setLiveNotice(null);
        return;
      }
      // กลับมา idle พร้อมข้อความใหม่ (ปิดเซสชัน/เริ่มไม่สำเร็จ) = โชว์ค้างสั้น ๆ แล้วหายเอง
      if (!last || last.id <= lastLiveEntryIdRef.current) return;
      lastLiveEntryIdRef.current = last.id;
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
      setLiveNotice({ level: last.level, message: last.message });
      noticeTimerRef.current = setTimeout(() => setLiveNotice(null), 8000);
    });
    return () => {
      unsubscribeText();
      unsubscribeLive?.();
    };
  }, [getCartApi, getProductAliases, notifyFocusSell, liveEnabled]);

  // PR3-Live — ปิดแท็บ/ย้ายหน้า/unmount = ปิดเซสชันเสียงสดทุกท่อน (ไมค์ห้ามรอดข้าม mount ตาม ADR-008)
  // effect แยก mount-only เพื่อไม่ให้ cleanup ของ effect หลัก (ที่ re-run ได้) ไปปิดเซสชันที่กำลังเปิด
  useEffect(() => {
    const onPageHide = () => liveCoreRef.current?.stop("page");
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
      liveCoreRef.current?.stop("page");
    };
  }, []);

  // นาฬิกาเดินเฉพาะตอนมี undo ค้าง — ค่าที่แสดงคำนวณจากเวลาที่ re-render ล่าสุด
  // (พ้นหน้าต่าง 6 วินาทีปุ่มหายเอง; ตัวตัดสินจริงตอนกดคือ core เสมอ)
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!state.undo) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [state.undo]);

  const remainingUndoMs = state.undo ? state.undo.expiresAt - now : 0;
  const ready = getCartApi() !== null;
  const undoVisible = state.undo !== null && remainingUndoMs > 0;
  const liveActive = liveState.phase !== "idle";
  // โหมดเสียงสดเปิด = ล็อกการพิมพ์/ย้อนกลับ (cartVersion ของสองช่องทางแยกกัน — สลับกันกลางทางไม่ได้)
  const canSubmit = ready && !state.busy && !liveActive && text.trim().length > 0;

  const submit = useCallback(() => {
    const value = text.trim();
    const core = coreRef.current;
    if (!value || !core || state.busy || liveActive) return;
    setText("");
    void core.send(value);
  }, [liveActive, state.busy, text]);

  const sendCandidate = useCallback((name: string) => void coreRef.current?.send(name), []);
  const undoLast = useCallback(() => {
    if (liveActive) return;
    coreRef.current?.undo();
  }, [liveActive]);

  const toggleLive = useCallback(() => {
    const core = liveCoreRef.current;
    if (!core) return;
    if (core.getState().phase === "idle") void core.start();
    else core.stop("user");
  }, []);

  // สถานะสดของปุ่ม/การ์ด — null = กำลังเปิดช่องเสียง (ยังไม่เห็น data channel)
  const liveStatusLabel = liveState.status === "listening"
    ? "ฟังอยู่"
    : liveState.status === "working"
      ? "กำลังทำ"
      : liveState.status === "speaking"
        ? "พูดยืนยัน"
        : "กำลังเชื่อมต่อ…";
  const undoSeconds = Math.max(0, Math.ceil(remainingUndoMs / 1000));

  return (
    <>
      <div className="relative shrink-0">
      {/* ปุ่มแยกชัดจากปุ่มเสียง — ไอคอนบอท + คำว่า "ผู้ช่วย" ไม่มีสัญลักษณ์ไมค์ */}
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="min-h-11 shrink-0 rounded-lg border border-gray-300 bg-white px-3 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-50 motion-reduce:transition-none"
      >
        🤖 <span className="hidden sm:inline">ผู้ช่วย</span>
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="ผู้ช่วย AI โหมดข้อความ"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              setOpen(false);
            }
          }}
          className="fixed inset-x-2 bottom-2 z-50 flex flex-col gap-2 rounded-xl border border-gray-200 bg-white p-3 shadow-xl sm:absolute sm:inset-x-auto sm:bottom-auto sm:left-0 sm:top-[calc(100%+4px)] sm:w-96"
        >
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-gray-800">ผู้ช่วย AI — พิมพ์คำสั่ง</p>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="min-h-8 rounded-md px-2 text-xs font-semibold text-gray-500 hover:text-gray-800"
            >
              ปิด
            </button>
          </div>

          {/* fail closed: หน้าขายไม่พร้อม = สถานะปิดชัดเจน ไม่มีช่องทางส่งคำสั่ง */}
          {!ready ? (
            <p role="status" className="rounded-lg bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
              หน้าขายยังไม่พร้อม — ผู้ช่วยปิดใช้งานชั่วคราว
            </p>
          ) : null}

          <div
            role="log"
            aria-live="polite"
            aria-label="ผลการทำงานของผู้ช่วย"
            className="flex min-h-16 max-h-56 flex-col gap-1.5 overflow-y-auto rounded-lg bg-gray-50 p-2"
          >
            {state.entries.length === 0 ? (
              <p className="text-xs leading-5 text-gray-500">
                พิมพ์คำสั่งสั้น ๆ เช่น “เพิ่มลาเต้ 2 แก้ว” — การเปิดใช้การแก้ตะกร้าผ่านผู้ช่วยจะบอกสถานะที่ผลลัพธ์เสมอ
              </p>
            ) : (
              state.entries.map((entry) => (
                <div key={entry.id}>
                  <p className={`text-xs leading-5 ${entry.level === "error" ? "text-red-700" : "text-gray-800"}`}>
                    {entry.message}
                  </p>
                  {entry.candidates ? (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {entry.candidates.map((candidate) => (
                        <button
                          key={candidate.id}
                          type="button"
                          onClick={() => sendCandidate(candidate.name)}
                          className="min-h-8 rounded-full border border-gray-300 bg-white px-2 text-xs text-gray-700 hover:bg-gray-100"
                        >
                          {candidate.name}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))
            )}
          </div>

          {state.busy ? (
            <p role="status" className="text-xs text-gray-500">
              กำลังประมวลผล…
            </p>
          ) : null}

          {/* PR3-Live — เปิดเสียงสด = ล็อกการพิมพ์/ย้อนกลับ (cartVersion สองช่องทางแยกกัน ห้ามสลับกลางทาง) */}
          {liveActive ? (
            <p role="status" className="text-xs text-gray-500">
              โหมดเสียงสดเปิดอยู่ — พิมพ์/ย้อนกลับชั่วคราว พูดสั่งผ่านไมค์ได้เลย
            </p>
          ) : null}

          <form
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
            className="flex items-center gap-1"
          >
            <input
              value={text}
              onChange={(event) => setText(event.target.value)}
              maxLength={TEXT_COMMAND_MAX_LENGTH}
              disabled={!ready || state.busy || liveActive}
              placeholder="พิมพ์คำสั่ง เช่น เพิ่มลาเต้ 2 แก้ว"
              aria-label="พิมพ์คำสั่งสำหรับผู้ช่วย AI"
              className="min-h-11 min-w-0 flex-1 rounded-lg border border-gray-300 px-2 text-sm text-gray-800 placeholder:text-gray-400 focus:border-orange-400 focus:outline-none disabled:bg-gray-100"
            />
            <button
              type="submit"
              disabled={!canSubmit}
              className="min-h-11 rounded-lg bg-orange-600 px-3 text-sm font-semibold text-white transition-colors hover:bg-orange-700 disabled:cursor-not-allowed disabled:bg-gray-300 motion-reduce:transition-none"
            >
              ส่ง
            </button>
          </form>

          {undoVisible && state.undo && !liveActive ? (
            <button
              type="button"
              onClick={undoLast}
              aria-label={`ย้อนกลับ: ${state.undo.label}`}
              className="min-h-11 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800 hover:bg-amber-100"
            >
              ↩︎ ย้อนกลับ ({undoSeconds} วินาที)
            </button>
          ) : null}
        </div>
      ) : null}
      </div>

      {/* PR3-Live (ADR-008) — ปุ่มเสียงสดแยกชัดจากปุ่มเสียงเดิมและปุ่มข้อความ
          แตะ = เริ่มเซสชัน (claim ไมค์ → live/session → WebRTC) แตะซ้ำ = ปิด
          สิทธิ์/pilot/kill switch ตรวจซ้ำที่ route ทุก request — ปุ่มเป็นแค่ทางเข้า */}
      {liveEnabled ? (
        <div className="relative shrink-0">
          <button
            type="button"
            onClick={toggleLive}
            disabled={!ready}
            aria-pressed={liveActive}
            className={`min-h-11 shrink-0 rounded-lg px-3 text-sm font-semibold transition-colors motion-reduce:transition-none disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-400 ${
              liveActive
                ? "border border-orange-600 bg-orange-600 text-white hover:bg-orange-700"
                : "border border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
            }`}
          >
            🎙️ <span className="hidden sm:inline">{liveActive ? `AI Live · ${liveStatusLabel}` : "AI Live"}</span>
          </button>

          {liveActive ? (
            <div
              role="status"
              aria-live="polite"
              className="fixed inset-x-2 bottom-2 z-50 flex flex-col gap-2 rounded-xl border border-gray-200 bg-white p-3 shadow-xl sm:absolute sm:inset-x-auto sm:bottom-auto sm:left-0 sm:top-[calc(100%+4px)] sm:w-96"
            >
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-gray-800">AI Live — {liveStatusLabel}</p>
                <button
                  type="button"
                  onClick={() => liveCoreRef.current?.stop("user")}
                  className="min-h-8 rounded-md px-2 text-xs font-semibold text-gray-500 hover:text-gray-800"
                >
                  ปิดเสียงสด
                </button>
              </div>
              <div
                role="log"
                aria-label="สถานะการทำงานของ AI Live"
                className="flex max-h-40 flex-col gap-1.5 overflow-y-auto rounded-lg bg-gray-50 p-2"
              >
                {liveState.entries.length === 0 ? (
                  <p className="text-xs leading-5 text-gray-500">พูดสั่งงานได้เลย เช่น “เพิ่มลาเต้ 2 แก้ว”</p>
                ) : (
                  liveState.entries.map((entry) => (
                    <p
                      key={entry.id}
                      className={`text-xs leading-5 ${entry.level === "error" ? "text-red-700" : "text-gray-800"}`}
                    >
                      {entry.message}
                    </p>
                  ))
                )}
              </div>
              <p className="text-xs text-gray-500">
                แตะปุ่ม AI Live ซ้ำเพื่อปิด
                {liveState.toolCallsCap !== null ? ` — คำสั่ง ${liveState.toolCallsUsed}/${liveState.toolCallsCap}` : ""}
              </p>
            </div>
          ) : liveNotice ? (
            <div
              role="status"
              className="fixed inset-x-2 bottom-2 z-50 rounded-xl border border-gray-200 bg-white p-3 shadow-xl sm:absolute sm:inset-x-auto sm:bottom-auto sm:left-0 sm:top-[calc(100%+4px)] sm:w-96"
            >
              <div className="flex items-start justify-between gap-2">
                <p className={`text-xs leading-5 ${liveNotice.level === "error" ? "text-red-700" : "text-gray-800"}`}>
                  {liveNotice.message}
                </p>
                <button
                  type="button"
                  onClick={() => setLiveNotice(null)}
                  className="min-h-8 shrink-0 rounded-md px-2 text-xs font-semibold text-gray-500 hover:text-gray-800"
                >
                  ปิด
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
