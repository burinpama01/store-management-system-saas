"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  FESTIVALS,
  FESTIVAL_CATEGORY_LABELS,
  type FestivalCategory,
  type FestivalSettings,
} from "@/modules/store-website/festivals";
import { saveFestivalSettingsAction } from "./actions";

export interface UpcomingFestival {
  key: string;
  name: string;
  startsOn: string;
  endsOn: string;
}

const CATEGORIES: FestivalCategory[] = ["thai", "buddhist", "chinese", "global", "shopping"];

function thaiDate(iso: string) {
  return new Intl.DateTimeFormat("th-TH", { timeZone: "Asia/Bangkok", day: "numeric", month: "short", year: "numeric" }).format(new Date(`${iso}T00:00:00+07:00`));
}

/** แผงเทศกาล: เปลี่ยนชุดตกแต่งตามเทศกาลอัตโนมัติ + เลือกเทศกาล + ดูตัวอย่าง */
export function FestivalPanel({
  settings,
  upcoming,
  pendingLunarKeys,
  previewKey,
  onPreview,
}: {
  settings: FestivalSettings;
  upcoming: UpcomingFestival[];
  /** เทศกาลจันทรคติที่ยังไม่มีวันที่ยืนยัน (ยังไม่แสดงจนกว่าระบบยืนยันวันที่) */
  pendingLunarKeys: string[];
  previewKey: string | null;
  onPreview: (key: string | null) => void;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<FestivalSettings>(settings);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const disabled = new Set(draft.disabled);
  const pendingLunar = new Set(pendingLunarKeys);

  function change(next: FestivalSettings) {
    setDraft(next);
    setDirty(true);
  }

  function toggle(key: string) {
    change({ ...draft, disabled: disabled.has(key) ? draft.disabled.filter((k) => k !== key) : [...draft.disabled, key] });
  }

  function save() {
    setMessage(null);
    startTransition(async () => {
      const result = await saveFestivalSettingsAction(draft);
      if (!result.ok) setMessage({ ok: false, text: result.error ?? "บันทึกไม่สำเร็จ" });
      else {
        setDirty(false);
        setMessage({ ok: true, text: draft.auto ? "บันทึกแล้ว — เว็บจะเปลี่ยนชุดตกแต่งเองตามเทศกาล" : "บันทึกแล้ว (ปิดเทศกาลอัตโนมัติ)" });
        router.refresh();
      }
    });
  }

  return (
    <div className="panel space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-sm font-semibold">🎉 เทศกาล (ชั้นตกแต่งซ้อนบนเทมเพลต — เมนูและข้อมูลร้านไม่เปลี่ยน)</p>
        <label className="flex items-center gap-2 text-sm font-semibold">
          <input type="checkbox" checked={draft.auto} onChange={(e) => change({ ...draft, auto: e.target.checked })} />
          เปลี่ยนตามเทศกาลอัตโนมัติ
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span>เริ่มแสดงก่อนวันเทศกาล</span>
        <input className="input w-16" style={{ fontSize: 16 }} inputMode="numeric" value={String(draft.leadDays)}
          onChange={(e) => change({ ...draft, leadDays: Math.min(14, Math.max(0, Number(e.target.value.replace(/[^0-9]/g, "")) || 0)) })} />
        <span>วัน</span>
      </div>

      {upcoming.length > 0 && (
        <div className="rounded-lg bg-black/5 p-3 text-sm">
          <p className="font-semibold">เทศกาลถัดไปที่จะแสดง</p>
          <ul className="mt-1 space-y-0.5">
            {upcoming.map((f) => (
              <li key={`${f.key}-${f.startsOn}`}>
                {f.name} · {thaiDate(f.startsOn)}{f.endsOn !== f.startsOn ? ` – ${thaiDate(f.endsOn)}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="space-y-3">
        {CATEGORIES.map((category) => (
          <div key={category}>
            <p className="text-xs font-semibold text-[var(--color-text-muted)]">{FESTIVAL_CATEGORY_LABELS[category]}</p>
            <div className="mt-1 flex flex-wrap gap-2">
              {FESTIVALS.filter((f) => f.category === category).map((f) => (
                <span key={f.key} className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-xs ${disabled.has(f.key) ? "border-[var(--color-border)] opacity-50" : "border-transparent"}`}
                  style={disabled.has(f.key) ? undefined : { background: `${f.color}22` }}>
                  <label className="flex cursor-pointer items-center gap-1">
                    <input type="checkbox" checked={!disabled.has(f.key)} onChange={() => toggle(f.key)} />
                    {f.name}
                    {pendingLunar.has(f.key) && <span title="รอระบบยืนยันวันที่ปีนี้">⏳</span>}
                  </label>
                  <button type="button" className={`ml-1 underline ${previewKey === f.key ? "font-bold" : ""}`} onClick={() => onPreview(previewKey === f.key ? null : f.key)}>
                    {previewKey === f.key ? "ปิดตัวอย่าง" : "ดูตัวอย่าง"}
                  </button>
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
      {pendingLunarKeys.length > 0 && (
        <p className="text-xs text-[var(--color-text-muted)]">⏳ = เทศกาลตามจันทรคติที่ StoreOS กำลังตรวจวันที่กับปฏิทินราชการ จะเริ่มแสดงเมื่อยืนยันวันที่แล้ว</p>
      )}

      {message && (
        <p className={`rounded border px-2 py-1 text-sm ${message.ok ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-red-200 bg-red-50 text-red-700"}`}>{message.text}</p>
      )}
      <button type="button" className="btn-primary text-sm" disabled={pending || !dirty} onClick={save}>
        {pending ? "กำลังบันทึก…" : "บันทึกเทศกาล"}
      </button>
    </div>
  );
}
