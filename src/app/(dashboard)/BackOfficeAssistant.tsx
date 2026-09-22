"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ProposalCard } from "@/modules/ai-assistant/ui/ProposalCard";
import {
  parseAssistantProposal,
  type AssistantProposal,
} from "@/modules/ai-assistant/ui/text-assistant-ui";

/**
 * ผู้ช่วยหลังร้าน — ปุ่มเดียวเรียกใช้ได้ทั้งฟีเจอร์
 *
 * ต่างจากแผงผู้ช่วยในหน้าขายตรงที่ไม่ยุ่งกับตะกร้าเลย งานหลังร้านไม่มีตะกร้า และการ
 * ผูกเข้ากับ core ของหน้าขายจะลากเงื่อนไข "ต้องมีตะกร้าก่อน" มาโดยไม่จำเป็น
 *
 * เห็นเฉพาะเจ้าของ/ผู้จัดการ — layout เป็นคนตัดสินจากสิทธิ์ก่อน mount component นี้
 * (ฝั่ง server ยังกั้นซ้ำที่ tool ทุกตัว ปุ่มที่หลุดมาก็สั่งอะไรไม่ได้อยู่ดี)
 *
 * ## ทุกขนาดจอ
 * ปุ่มลอยมุมขวาล่างเสมอ ไม่ซ่อนที่ breakpoint ไหน และเว้นจากขอบด้วย safe-area เผื่อ
 * มือถือที่มีแถบล่าง; แผงเปิดเต็มความกว้างบนมือถือ (ชิดขอบล่าง อ่านง่ายด้วยนิ้วโป้ง)
 * แล้วหดเป็นแผงลอยมุมขวาบนจอ sm ขึ้นไป โดยจำกัดความสูงไม่ให้เกินจอเสมอ
 */

interface AssistantEntry {
  readonly id: number;
  readonly level: "user" | "assistant" | "error";
  readonly text: string;
}

const FAILURE_TEXT: Record<string, string> = {
  network_error: "เชื่อมต่อไม่ได้ ลองใหม่อีกครั้ง",
  forbidden: "คำสั่งนี้ใช้ผ่านผู้ช่วยไม่ได้ — ใช้หน้าจอแทน",
  ai_disabled: "ระบบ AI ยังไม่เปิดสำหรับร้านนี้",
  quota_denied: "โควตา AI หมด — เติมได้ที่หน้าตั้งค่า",
  ai_timeout: "แปลคำสั่งไม่ทัน ลองพิมพ์สั้นลง",
  ai_error: "เชื่อมต่อ AI มีปัญหา ลองใหม่อีกครั้ง",
  ai_invalid_output: "แปลคำสั่งไม่สำเร็จ ลองพิมพ์ใหม่แบบสั้น ๆ",
};

const CODE_TEXT: Record<string, string> = {
  PERMISSION_DENIED: "บัญชีนี้ไม่มีสิทธิ์ทำรายการนี้",
  MUTATIONS_DISABLED: "ผู้ช่วยยังแก้ข้อมูลไม่ได้ในร้านนี้",
  FEATURE_DISABLED: "แพ็กเกจนี้ยังไม่รองรับผู้ช่วย AI",
  PROPOSAL_STALE: "ข้อมูลเปลี่ยนไประหว่างที่ดูรายการอยู่ — สั่งใหม่อีกครั้ง",
  PROPOSAL_NOT_FOUND: "รายการนี้หมดอายุหรือถูกใช้ไปแล้ว — สั่งใหม่อีกครั้ง",
  PREREQUISITE_REQUIRED: "ยังเลือกข้อมูลที่ขาดไม่ครบ",
  CONTEXT_UNAVAILABLE: "เซสชันหมดอายุ — รีเฟรชหน้าแล้วลองใหม่",
  UNKNOWN_TOOL: "ยังไม่รองรับคำสั่งนี้",
};

/** id ของเครื่อง/แท็บนี้ — ชื่อ key และรูปแบบตรงกับแผงในหน้าขาย */
const DEVICE_KEY = "ai-assistant:device-id";
const ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

function deviceHeaders(): Record<string, string> {
  try {
    let id = sessionStorage.getItem(DEVICE_KEY);
    if (!id || !ID_PATTERN.test(id)) {
      id = `dev-${crypto.randomUUID().replace(/-/g, "")}`;
      sessionStorage.setItem(DEVICE_KEY, id);
    }
    return { "Content-Type": "application/json", "x-storeos-assistant-device": id };
  } catch {
    return { "Content-Type": "application/json" };
  }
}

function newRequestId(sequence: number): string {
  const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID().replace(/-/g, "")
    : `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  return `bo${sequence.toString(36)}${random}`.slice(0, 64);
}

/**
 * ขอบเขตของผู้ช่วยที่ผู้ใช้คนนี้เรียกได้
 *
 * `accounting` = แคชเชียร์บนหน้าบัญชี — ข้อความช่วยและป้ายปุ่มต้องบอกขอบเขตให้ตรง
 * ไม่งั้นเขาจะพิมพ์ "แก้ราคาลาเต้" แล้วโดนปฏิเสธโดยไม่รู้ว่าเพราะอะไร
 */
export type AssistantScope = "full" | "accounting";

const SCOPE_COPY: Record<AssistantScope, { label: string; hint: string; placeholder: string }> = {
  full: {
    label: "ผู้ช่วยหลังร้าน",
    hint: "พิมพ์สิ่งที่อยากทำ เช่น “ลงค่าน้ำแข็ง 450”, “แก้ราคาอเมริกาโน่เย็นเป็น 60”, “เปิด QR ให้ทุกเมนู” — ระบบจะสรุปให้ดูก่อนเสมอ ยังไม่แก้อะไรจนกว่าจะกดยืนยัน",
    placeholder: "พิมพ์คำสั่ง…",
  },
  accounting: {
    label: "ผู้ช่วยลงบัญชี",
    hint: "พิมพ์รายการที่จะลง เช่น “ลงค่าน้ำแข็ง 450” หรือ “รายรับอื่น 500 ค่าจัดเลี้ยง” — ระบบจะสรุปให้ดูก่อนเสมอ ยังไม่บันทึกจนกว่าจะกดยืนยัน (บัญชีนี้ใช้ได้เฉพาะเรื่องรายรับ-รายจ่าย)",
    placeholder: "พิมพ์รายการรายรับ-รายจ่าย…",
  },
};

export function BackOfficeAssistant({ scope = "full" }: { scope?: AssistantScope }) {
  const copy = SCOPE_COPY[scope];
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [entries, setEntries] = useState<AssistantEntry[]>([]);
  const [proposal, setProposal] = useState<AssistantProposal | null>(null);
  const sequence = useRef(0);
  const entryId = useRef(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const push = useCallback((level: AssistantEntry["level"], value: string) => {
    entryId.current += 1;
    setEntries((previous) => [...previous, { id: entryId.current, level, text: value }].slice(-20));
  }, []);

  const call = useCallback(async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const response = await fetch("/api/ai-assistant/text-command", {
        method: "POST",
        headers: deviceHeaders(),
        body: JSON.stringify(body),
      });
      const payload: unknown = await response.json().catch(() => null);
      const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
      if (!record || record.ok !== true) {
        const reason = typeof record?.reason === "string" ? record.reason : "network_error";
        push("error", FAILURE_TEXT[reason] ?? "ทำรายการไม่สำเร็จ");
        return;
      }
      if (typeof record.failure === "string") {
        push("error", FAILURE_TEXT[record.failure] ?? "ทำรายการไม่สำเร็จ");
        return;
      }
      const outcomes = Array.isArray(record.outcomes) ? record.outcomes : [];
      if (outcomes.length === 0) {
        push("error", "ยังไม่เข้าใจคำสั่งนี้ — ลองพิมพ์สั้น ๆ เช่น “ลงค่าน้ำแข็ง 450”");
        return;
      }
      for (const raw of outcomes) {
        const outcome = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
        if (outcome?.kind === "proposal") {
          const parsed = parseAssistantProposal(outcome.proposal);
          // การ์ดที่อ่านรูปไม่ได้ = ไม่แสดงเลย ดีกว่าให้คนตัดสินใจจากของพัง
          if (parsed) {
            setProposal(parsed);
            push("assistant", parsed.summary);
          } else {
            push("error", "อ่านรายการที่เสนอไม่ได้ — ลองสั่งใหม่");
          }
          continue;
        }
        if (outcome?.kind === "error") {
          const code = typeof outcome.code === "string" ? outcome.code : "";
          push("error", CODE_TEXT[code] ?? `ทำรายการไม่สำเร็จ (${code || "ไม่ทราบสาเหตุ"})`);
          continue;
        }
        setProposal(null);
        push("assistant", "ทำรายการเรียบร้อยแล้ว");
      }
    } catch {
      push("error", FAILURE_TEXT.network_error);
    } finally {
      setBusy(false);
    }
  }, [push]);

  const submit = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    sequence.current += 1;
    setText("");
    setProposal(null);
    push("user", trimmed);
    await call({ requestId: newRequestId(sequence.current), text: trimmed });
  }, [busy, call, push, text]);

  const confirm = useCallback(async (answers: Record<string, string>) => {
    if (!proposal || busy) return;
    sequence.current += 1;
    const pending = proposal;
    setProposal(null);
    await call({
      requestId: newRequestId(sequence.current),
      confirm: { tool: pending.tool, proposalId: pending.id, answers },
    });
  }, [busy, call, proposal]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`เปิด${copy.label}`}
        className="fixed right-4 bottom-4 z-40 flex min-h-12 min-w-12 items-center gap-2 rounded-full bg-orange-600 px-4 text-sm font-semibold text-white shadow-lg transition-colors hover:bg-orange-700 motion-reduce:transition-none"
        style={{ bottom: "calc(1rem + env(safe-area-inset-bottom, 0px))" }}
      >
        <span aria-hidden>✨</span>
        {/* ข้อความซ่อนบนจอแคบเพื่อไม่ให้ปุ่มบังเนื้อหา แต่ตัวปุ่มยังอยู่ทุกขนาดจอ */}
        <span className="hidden sm:inline">{copy.label}</span>
      </button>
    );
  }

  return (
    <section
      aria-label={copy.label}
      className="fixed inset-x-0 bottom-0 z-40 flex max-h-[85vh] flex-col rounded-t-2xl border border-gray-200 bg-white shadow-2xl sm:inset-x-auto sm:right-4 sm:bottom-4 sm:max-h-[80vh] sm:w-96 sm:rounded-2xl"
      style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
    >
      <header className="flex items-center justify-between gap-2 border-b border-gray-200 px-4 py-3">
        <h2 className="text-sm font-semibold text-gray-900">{copy.label}</h2>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="ปิดผู้ช่วย"
          className="min-h-11 min-w-11 rounded-lg text-gray-500 hover:text-gray-900"
        >
          ✕
        </button>
      </header>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-3">
        {entries.length === 0 ? (
          <p className="text-xs text-gray-500">
            {copy.hint}
          </p>
        ) : (
          entries.map((entry) => (
            <p
              key={entry.id}
              className={`break-words text-sm ${
                entry.level === "error" ? "text-red-700" : entry.level === "user" ? "text-gray-500" : "text-gray-900"
              }`}
            >
              {entry.level === "user" ? `» ${entry.text}` : entry.text}
            </p>
          ))
        )}

        {proposal ? (
          <ProposalCard proposal={proposal} busy={busy} onConfirm={confirm} onCancel={() => setProposal(null)} />
        ) : null}

        {busy ? <p role="status" className="text-xs text-gray-500">กำลังประมวลผล…</p> : null}
      </div>

      <form
        onSubmit={(event) => { event.preventDefault(); void submit(); }}
        className="flex items-center gap-2 border-t border-gray-200 px-4 py-3"
      >
        <input
          ref={inputRef}
          value={text}
          onChange={(event) => setText(event.target.value)}
          maxLength={200}
          disabled={busy}
          placeholder={copy.placeholder}
          aria-label={`พิมพ์คำสั่งสำหรับ${copy.label}`}
          className="min-h-11 min-w-0 flex-1 rounded-lg border border-gray-300 px-3 text-sm text-gray-800 placeholder:text-gray-400 focus:border-orange-400 focus:outline-none disabled:bg-gray-100"
        />
        <button
          type="submit"
          disabled={busy || text.trim().length === 0}
          className="min-h-11 shrink-0 rounded-lg bg-orange-600 px-4 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-gray-300"
        >
          ส่ง
        </button>
      </form>
    </section>
  );
}
