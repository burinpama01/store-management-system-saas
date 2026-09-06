"use client";

// W7 — แถบสถานะและปุ่มควบคุมโหมดคำปลุก (ตาม Design System v1)
//
// หลักที่ยึดจากดีไซน์:
//   * "เมื่อไมค์ทำงานต้องเห็นสถานะเสมอ และมีปุ่มปิดที่หาเจอในหนึ่งจังหวะ"
//   * ห้ามสื่อสถานะด้วยสีอย่างเดียว — ทุกสถานะมีทั้งไอคอนและข้อความ
//     (จอร้านหลายเครื่องสีเพี้ยน และพนักงานตาบอดสีมีจริง)
//   * ระหว่าง STANDBY ห้ามกระพริบหรือแย่ง focus จากงานขาย
//   * เบราว์เซอร์ปกติไม่มีคำปลุก จึงต้องไม่จองพื้นที่บนแถบหัวเลย

export type VoiceStandbyUiState =
  /** ไม่มี Launcher — ไม่ต้องแสดงอะไรทั้งสิ้น */
  | "unavailable"
  /** มี Launcher แต่ผู้ใช้พักไว้ */
  | "off"
  /** พร้อมรับคำปลุก */
  | "standby"
  /** กำลังฟังคำสั่งอยู่ */
  | "listening"
  /** เปิดไม่ได้จริง (ไม่มีไมค์/ชุดรู้จำเสียง) — ยังกดปุ่มพูดได้ */
  | "degraded";

interface StatusStyle {
  readonly icon: string;
  readonly label: string;
  readonly hint: string;
  readonly color: string;
  readonly background: string;
  readonly border: string;
}

/** สีมาจาก Design System v1 — เขียวใช้เมื่อพร้อมจริงเท่านั้น แดงแปลว่า "กำลังจับคำสั่ง" ไม่ใช่ error */
const STATUS: Record<Exclude<VoiceStandbyUiState, "unavailable">, StatusStyle> = {
  off: {
    icon: "○",
    label: "สแตนด์บายปิด",
    hint: "กดไมค์เพื่อพูดได้",
    color: "#667085",
    background: "#F2F4F7",
    border: "#D0D5DD",
  },
  standby: {
    icon: "●",
    label: "พร้อมรับคำปลุก",
    hint: "พูดว่า “Hello StoreOS”",
    color: "#167554",
    background: "#E7F6EF",
    border: "#A6E0C6",
  },
  listening: {
    icon: "■",
    label: "กำลังฟังคำสั่ง",
    hint: "พูดได้เลย",
    color: "#C23F37",
    background: "#FDECEA",
    border: "#F3B6B1",
  },
  degraded: {
    icon: "⚠",
    label: "สแตนด์บายไม่พร้อม",
    hint: "ยังใช้ปุ่มพูดได้",
    color: "#946000",
    background: "#FDF6E3",
    border: "#EBD08A",
  },
};

export interface VoiceStandbyControlProps {
  readonly state: VoiceStandbyUiState;
  /** เปิด/พักโหมดคำปลุก — ไม่ส่งมาจะแสดงสถานะอย่างเดียว */
  readonly onToggle?: () => void;
  readonly className?: string;
}

export function VoiceStandbyControl({ state, onToggle, className }: VoiceStandbyControlProps) {
  // ไม่มี Launcher = ไม่จองพื้นที่ ไม่มีปุ่มที่กดแล้วไม่เกิดอะไร
  if (state === "unavailable") return null;

  const status = STATUS[state];
  const paused = state === "off";
  const toggleLabel = paused ? "เปิดสแตนด์บาย" : "พักสแตนด์บาย";

  return (
    <div className={`flex items-center gap-2 ${className ?? ""}`.trim()}>
      <span
        data-testid="voice-standby-status"
        // live region แยกจาก transcript — อ่านเฉพาะ "สถานะ" ไม่ใช่คำพูดของผู้ใช้
        role="status"
        aria-live="polite"
        className="inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-sm font-bold"
        style={{ color: status.color, backgroundColor: status.background, borderColor: status.border }}
      >
        {/* ไอคอนเป็นการตกแต่ง — ข้อความคือสิ่งที่ screen reader ต้องได้ยิน */}
        <span aria-hidden="true">{status.icon}</span>
        <span>{status.label}</span>
        <span className="hidden font-normal opacity-80 lg:inline">· {status.hint}</span>
      </span>

      {onToggle ? (
        <button
          type="button"
          data-testid="voice-standby-toggle"
          onClick={onToggle}
          aria-pressed={!paused}
          aria-label={toggleLabel}
          title={toggleLabel}
          // ≥44px ตาม accessibility contract ของดีไซน์ (นิ้วเดียวกดได้ไม่โดนปุ่มข้าง ๆ)
          className="min-h-11 min-w-11 rounded-lg border border-[var(--color-border,#D0D5DD)] px-3 text-sm font-semibold text-[var(--color-text-secondary,#475467)] transition-colors hover:bg-black/5 focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          {paused ? "เปิด" : "พัก"}
        </button>
      ) : null}
    </div>
  );
}
