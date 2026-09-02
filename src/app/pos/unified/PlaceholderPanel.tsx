"use client";

// U9 — Placeholder ตรงไปตรงมาของแท็บที่ยังไม่เปิดใช้ (Kitchen = U10, Bills = U11)
// ปุ่มตัวอย่างถูก disabled พร้อมเหตุผลกำกับ เพื่อไม่ให้ผู้ใช้คาดหวังเกินสิ่งที่มีจริง

interface PlaceholderPanelProps {
  /** id เฉพาะของหัวข้อ — กัน id ซ้ำใน DOM เมื่อมี placeholder หลายอัน (aria-labelledby) */
  readonly titleId: string;
  readonly title: string;
  readonly description: string;
  readonly upcomingLabel: string;
  /** ชื่อปุ่มที่จะมีในรอบถัดไป — แสดงเป็น disabled affordance */
  readonly affordances: readonly string[];
}

export function PlaceholderPanel({ titleId, title, description, upcomingLabel, affordances }: PlaceholderPanelProps) {
  return (
    <div
      aria-labelledby={titleId}
      className="rounded-xl border border-dashed border-gray-300 bg-white/60 p-6"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={titleId} className="text-base font-semibold text-gray-900">
          {title}
        </h3>
        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">
          {upcomingLabel}
        </span>
      </div>
      <p className="mt-2 max-w-prose text-sm text-gray-600">{description}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        {affordances.map((label) => (
          <button
            key={label}
            type="button"
            disabled
            aria-disabled="true"
            title="ยังไม่เปิดใช้งาน — จะเปิดในเวอร์ชันถัดไป"
            className="min-h-9 cursor-not-allowed rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-sm text-gray-400"
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
