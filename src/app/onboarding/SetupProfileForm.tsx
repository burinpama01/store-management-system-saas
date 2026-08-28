"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveSetupProfileAction } from "./actions";

type BusinessMode = "retail" | "restaurant" | "service";

const MODES: Array<{ value: BusinessMode; label: string; desc: string }> = [
  { value: "restaurant", label: "ร้านอาหาร/เครื่องดื่ม", desc: "มีโต๊ะ เสิร์ฟหน้าร้าน" },
  { value: "retail", label: "ร้านขายของ/ขายส่ง", desc: "ขายหน้าเคาน์เตอร์ ไม่มีโต๊ะ" },
  { value: "service", label: "บริการ/อื่น ๆ", desc: "รับงานบริการ นัดเวลา" },
];

export function SetupProfileForm({
  initial,
  canManage,
}: {
  initial: { businessMode: BusinessMode | ""; usesTables: boolean; needsPrinting: boolean; hasProfile: boolean };
  canManage: boolean;
}) {
  const router = useRouter();
  const [businessMode, setBusinessMode] = useState<BusinessMode | "">(initial.businessMode);
  const [usesTables, setUsesTables] = useState(initial.usesTables);
  const [needsPrinting, setNeedsPrinting] = useState(initial.needsPrinting);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [isPending, startTransition] = useTransition();

  function save() {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await saveSetupProfileAction({ businessMode, usesTables, needsPrinting });
      if (result.ok) {
        setSaved(true);
        router.refresh();
      } else {
        setError(result.error ?? "บันทึกไม่สำเร็จ");
      }
    });
  }

  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] p-5">
      <h2 className="text-lg font-extrabold text-[var(--ink)]">ตอบ 3 คำถาม เพื่อปรับระบบให้ตรงร้าน</h2>
      <p className="mt-1 text-sm text-[var(--muted)]">
        คำตอบช่วยซ่อนเมนูที่ร้านไม่ใช้ และปรับขั้นตอนเตรียมร้านให้สั้นลง (เปลี่ยนคำตอบใหม่ได้ทุกเมื่อ)
      </p>

      <fieldset className="mt-4">
        <legend className="text-sm font-bold text-[var(--ink)]">1) ร้านของคุณคือประเภทไหน?</legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          {MODES.map((mode) => (
            <button
              key={mode.value}
              type="button"
              disabled={!canManage || isPending}
              onClick={() => setBusinessMode(mode.value)}
              className={`min-h-11 rounded-[var(--radius-md)] border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                businessMode === mode.value
                  ? "border-[var(--tenant-primary)] bg-[var(--tenant-primary-soft)]"
                  : "border-[var(--border)] hover:border-[var(--tenant-primary)]"
              }`}
              aria-pressed={businessMode === mode.value}
            >
              <span className="block text-sm font-bold text-[var(--ink)]">{mode.label}</span>
              <span className="block text-xs text-[var(--muted)]">{mode.desc}</span>
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="mt-4">
        <legend className="text-sm font-bold text-[var(--ink)]">2) ร้านมีโต๊ะให้ลูกค้านั่งไหม?</legend>
        <div className="mt-2 flex gap-2">
          {[
            { value: true, label: "มีโต๊ะ" },
            { value: false, label: "ไม่มีโต๊ะ" },
          ].map((option) => (
            <button
              key={String(option.value)}
              type="button"
              disabled={!canManage || isPending}
              onClick={() => setUsesTables(option.value)}
              aria-pressed={usesTables === option.value}
              className={`min-h-11 flex-1 rounded-[var(--radius-md)] border text-sm font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                usesTables === option.value
                  ? "border-[var(--tenant-primary)] bg-[var(--tenant-primary-soft)] text-[var(--tenant-primary-strong)]"
                  : "border-[var(--border)] text-[var(--ink-2)] hover:border-[var(--tenant-primary)]"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="mt-4">
        <legend className="text-sm font-bold text-[var(--ink)]">3) ต้องพิมพ์ใบเสร็จ/สลิปหรือไม่?</legend>
        <div className="mt-2 flex gap-2">
          {[
            { value: true, label: "ต้องพิมพ์" },
            { value: false, label: "ไม่ต้องพิมพ์" },
          ].map((option) => (
            <button
              key={String(option.value)}
              type="button"
              disabled={!canManage || isPending}
              onClick={() => setNeedsPrinting(option.value)}
              aria-pressed={needsPrinting === option.value}
              className={`min-h-11 flex-1 rounded-[var(--radius-md)] border text-sm font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                needsPrinting === option.value
                  ? "border-[var(--tenant-primary)] bg-[var(--tenant-primary-soft)] text-[var(--tenant-primary-strong)]"
                  : "border-[var(--border)] text-[var(--ink-2)] hover:border-[var(--tenant-primary)]"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </fieldset>

      {error ? (
        <p className="mt-3 rounded-[var(--radius-md)] border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700" role="alert">
          บันทึกไม่สำเร็จ: {error}
        </p>
      ) : null}
      {saved ? (
        <p className="mt-3 text-xs font-semibold text-green-700" role="status">
          บันทึกแล้ว — ระบบปรับเมนูและขั้นตอนให้ตามคำตอบ
        </p>
      ) : null}

      <button
        type="button"
        onClick={save}
        disabled={!canManage || isPending || businessMode === ""}
        className="btn-primary mt-4 min-h-11 w-full disabled:cursor-not-allowed disabled:opacity-40"
      >
        {isPending ? "กำลังบันทึก..." : initial.hasProfile ? "อัปเดตคำตอบ" : "บันทึกคำตอบ"}
      </button>
      {!canManage ? (
        <p className="mt-2 text-xs text-[var(--muted)]">เฉพาะผู้มีสิทธิ์ตั้งค่าร้าน (settings.manage_store) จึงจะบันทึกได้</p>
      ) : null}
    </div>
  );
}