"use client";

// P7 (v0.44.6) — แผงคิวคำสั่งเสียงหลายรายการ
//
// ทำไมเป็น "แผง" ไม่ใช่ "dialog": ตัวเลือกสินค้าเปิดเป็น dialog อยู่แล้ว ถ้าคิวเป็น
// dialog อีกใบจะซ้อนกันและกดผิดใบแน่นอน กติกาคือมี dialog ได้ครั้งละหนึ่ง — คิวจึงเป็น
// แผงที่อยู่ "ข้างใต้/ข้าง ๆ" ไม่จับ focus และไม่บังสรุปยอดที่ต้องเห็นตลอดเวลา
//
// มือถือ (<768px): bottom sheet เหนือแถบสรุปยอด (ไม่ทับ) — bottom-20 คือความสูงของแถบนั้น
// จอใหญ่: แผงลอยมุมขวาล่างแบบกะทัดรัด

import type { VoiceCommandQueue as Queue, VoiceQueueItem } from "@/modules/voice-pos/command-queue";

const STATUS_LABEL: Record<VoiceQueueItem["status"], string> = {
  pending: "รอคิว",
  resolving: "กำลังตรวจ",
  awaiting_input: "รอเลือก",
  applied: "เพิ่มแล้ว",
  skipped: "ข้าม",
  blocked: "ทำไม่ได้",
};

const STATUS_TONE: Record<VoiceQueueItem["status"], string> = {
  pending: "text-[var(--muted)]",
  resolving: "text-teal-700",
  awaiting_input: "text-amber-700",
  applied: "text-emerald-700",
  skipped: "text-[var(--muted)]",
  blocked: "text-red-600",
};

export interface VoiceCommandQueueProps {
  readonly queue: Queue | null;
  readonly activeIndex: number;
  readonly onSkipCurrent: () => void;
  readonly onCancelAll: () => void;
}

export function VoiceCommandQueue({ queue, activeIndex, onSkipCurrent, onCancelAll }: VoiceCommandQueueProps) {
  if (!queue || queue.items.length === 0) return null;
  const done = queue.cancelled || activeIndex >= queue.items.length;

  return (
    <section
      // ไม่ใช่ role="dialog" โดยตั้งใจ — ห้ามแย่ง focus จากหน้าต่างตัวเลือกสินค้า
      aria-label="คิวคำสั่งเสียง"
      data-testid="voice-command-queue"
      className="fixed inset-x-2 bottom-20 z-30 rounded-xl border border-[var(--border)] bg-white/95 p-3 shadow-lg backdrop-blur sm:inset-x-auto sm:right-4 sm:bottom-4 sm:w-80"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-[var(--ink)]">
          คำสั่งเสียง {Math.min(activeIndex + (done ? 0 : 1), queue.items.length)}/{queue.items.length}
        </p>
        {!done ? (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onSkipCurrent}
              className="min-h-11 rounded-lg border border-[var(--border)] px-3 text-xs font-semibold text-[var(--ink-2)] hover:bg-slate-50"
            >
              ข้ามรายการนี้
            </button>
            <button
              type="button"
              onClick={onCancelAll}
              className="min-h-11 rounded-lg border border-red-200 px-3 text-xs font-semibold text-red-700 hover:bg-red-50"
            >
              ยกเลิกที่เหลือ
            </button>
          </div>
        ) : null}
      </div>

      <ol className="max-h-40 space-y-1 overflow-y-auto text-sm">
        {queue.items.map((item, index) => {
          const isActive = !done && index === activeIndex;
          return (
            <li
              key={item.id}
              aria-current={isActive ? "step" : undefined}
              className={`flex items-start justify-between gap-2 rounded-md px-2 py-1 ${isActive ? "bg-teal-50" : ""}`}
            >
              <span className="min-w-0 flex-1 truncate text-[var(--ink-2)]">
                {index + 1}. {item.command.productPhrase ?? "คำสั่ง"}
                {item.note ? <span className="block truncate text-xs text-[var(--muted)]">{item.note}</span> : null}
              </span>
              <span className={`shrink-0 text-xs font-semibold ${STATUS_TONE[item.status]}`}>
                {STATUS_LABEL[item.status]}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
