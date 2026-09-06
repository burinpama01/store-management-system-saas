"use client";

// W8 — การ์ดสถานะและวิธีแก้ของเครื่องนี้ (แสดงบนหน้าตั้งค่าเสียง)
//
// ที่ตั้งใจไม่แสดง: รหัสอุปกรณ์ดิบ, เส้นทางไฟล์, ข้อความ error ดิบของ Windows
// คนหน้าร้านต้องการรู้แค่สามอย่าง: ใช้ได้ไหม / ติดอะไร / ต้องทำอะไรต่อ

import { useEffect, useState } from "react";

import { describeHostFault } from "@/modules/voice-pos/host-repair";
import type { VoiceHostHealth } from "@/modules/voice-pos/standby-contract";
import type { WindowsVoiceHostAdapter } from "@/modules/voice-pos/windows-host";

const STATE_TEXT: Record<VoiceHostHealth["state"], { label: string; tone: string }> = {
  standby: { label: "พร้อมรับคำปลุก", tone: "text-[#167554]" },
  listening: { label: "กำลังฟังคำสั่ง", tone: "text-[#C23F37]" },
  off: { label: "ปิดอยู่", tone: "text-[#667085]" },
  degraded: { label: "ใช้งานไม่ได้", tone: "text-[#946000]" },
};

export interface VoiceStandbyDiagnosticsProps {
  readonly host: WindowsVoiceHostAdapter;
}

export function VoiceStandbyDiagnostics({ host }: VoiceStandbyDiagnosticsProps) {
  const [health, setHealth] = useState<VoiceHostHealth | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (!host.available) return;
    const unsubscribe = host.subscribeHealth((next) => {
      setHealth(next);
      setChecking(false);
    });
    // ขอสถานะทันทีที่เปิดหน้า — ไม่งั้นจะว่างเปล่าจนกว่าสถานะฝั่งเครื่องจะเปลี่ยนเอง
    host.requestHealth();
    return unsubscribe;
  }, [host]);

  // เปิดหน้านี้ในเบราว์เซอร์ปกติ = ไม่มีเครื่องให้รายงาน จึงไม่ต้องแสดงการ์ดเปล่า
  if (!host.available) return null;

  const guide = describeHostFault(health?.faultCode ?? null);
  const state = health ? STATE_TEXT[health.state] : null;

  return (
    <section
      data-testid="voice-standby-diagnostics"
      className="panel-muted flex flex-col gap-3 p-4"
      aria-labelledby="voice-standby-diagnostics-title"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="voice-standby-diagnostics-title" className="text-sm font-bold">
          คำปลุกบนเครื่องนี้
        </h3>
        <button
          type="button"
          data-testid="voice-standby-recheck"
          onClick={() => {
            setChecking(true);
            host.requestHealth();
          }}
          className="min-h-11 rounded-lg border border-[var(--color-border,#D0D5DD)] px-4 text-sm font-semibold hover:bg-black/5 focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          {checking ? "กำลังตรวจ…" : "ตรวจอีกครั้ง"}
        </button>
      </div>

      {health ? (
        <>
          <p role="status" aria-live="polite" className={`text-sm font-bold ${state!.tone}`}>
            {state!.label}
          </p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-[var(--color-text-secondary,#475467)]">
            <dt>โปรแกรมบนเครื่อง</dt>
            <dd>{health.hostVersion}</dd>
            <dt>ชุดรู้จำเสียง</dt>
            <dd>{health.recognizer ? `${health.recognizer} (${health.recognizerCulture ?? "-"})` : "ไม่พบ"}</dd>
            <dt>ไมโครโฟน</dt>
            <dd>{health.microphone ?? "ไม่พบ"}</dd>
          </dl>
        </>
      ) : (
        <p className="text-xs text-[var(--color-text-secondary,#475467)]">กำลังอ่านสถานะจากเครื่อง…</p>
      )}

      {guide ? (
        <div data-testid="voice-standby-repair" className="rounded-lg border border-[#EBD08A] bg-[#FDF6E3] p-3">
          <p className="text-sm font-bold text-[#946000]">{guide.problem}</p>
          <ol className="mt-1 list-decimal pl-5 text-xs text-[#6B4A00]">
            {guide.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <p className="mt-2 text-xs font-semibold text-[#6B4A00]">{guide.fallback}</p>
        </div>
      ) : null}

      <p className="text-xs text-[var(--color-text-secondary,#475467)]">
        การเปิด-ปิดคำปลุกเป็นค่าเฉพาะของเครื่องนี้ ไม่ส่งผลกับเครื่องอื่นในร้าน
      </p>
    </section>
  );
}
