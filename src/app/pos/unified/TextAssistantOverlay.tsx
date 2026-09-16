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
import { TEXT_COMMAND_MAX_LENGTH } from "@/modules/ai-assistant/ui/text-assistant-ui";

export interface TextAssistantOverlayProps {
  /** คำเรียกเมนูของร้าน — ชุดเดียวกับ Voice POS (ผ่านให้ applyVoiceCartIntent) */
  readonly productAliases?: readonly VoiceProductAlias[];
  /** กลับไปแท็บขายหลังผู้ช่วยแก้ตะกร้า/เปิด dialog สินค้า (พฤติกรรมเดียวกับเสียง) */
  readonly onFocusSell?: () => void;
}

function readReason(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const reason = (payload as { reason?: unknown }).reason;
  return typeof reason === "string" && reason.length > 0 ? reason : null;
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

export function TextAssistantOverlay({ productAliases = [], onFocusSell }: TextAssistantOverlayProps) {
  const getCartApi = useVoiceCartApi();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");

  // core สร้างครั้งเดียวต่อ mount ใน effect (activeCartId คงเส้นตาย — server ผูกตะกร้า 1 ใบ
  // ต่อ session การสร้างใหม่กลางทาง = binding ถูกปฏิเสธ) — deps ที่ค่าเปลี่ยนได้ตาม render
  // อ่านผ่าน ref ที่หุ้มด้วย useCallback คงตัว และตัว core เองถูกแตะเฉพาะใน event/effect
  const coreRef = useRef<TextAssistantCore | null>(null);
  const liveProps = useRef({ productAliases, onFocusSell });
  useEffect(() => {
    liveProps.current = { productAliases, onFocusSell };
  });
  const getProductAliases = useCallback(() => liveProps.current.productAliases, []);
  const notifyFocusSell = useCallback(() => liveProps.current.onFocusSell?.(), []);
  const [state, setState] = useState<TextAssistantState>({ entries: [], busy: false, undo: null });
  useEffect(() => {
    if (!coreRef.current) {
      coreRef.current = createTextAssistantCore({
        getCartApi,
        sendCommand: sendTextCommand,
        getProductAliases,
        onFocusSell: notifyFocusSell,
      });
    }
    const core = coreRef.current;
    return core.subscribe(() => setState(core.getState()));
  }, [getCartApi, getProductAliases, notifyFocusSell]);

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
  const undoSeconds = Math.max(0, Math.ceil(remainingUndoMs / 1000));
  const canSubmit = ready && !state.busy && text.trim().length > 0;

  const submit = useCallback(() => {
    const value = text.trim();
    const core = coreRef.current;
    if (!value || !core || state.busy) return;
    setText("");
    void core.send(value);
  }, [state.busy, text]);

  const sendCandidate = useCallback((name: string) => void coreRef.current?.send(name), []);
  const undoLast = useCallback(() => coreRef.current?.undo(), []);

  return (
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
              disabled={!ready || state.busy}
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

          {undoVisible && state.undo ? (
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
  );
}
