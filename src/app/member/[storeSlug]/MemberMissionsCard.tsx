"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { MemberMissionCard, MemberMissionsView } from "@/modules/missions/repository";
import { joinMissionAction, setMissionSmsOptOutAction } from "./actions";

interface Props {
  storeSlug: string;
  portalCode: string;
  view: MemberMissionsView;
  /** "home" = หน้าแรก: แถบภารกิจที่กำลังทำ + ปุ่มดูทั้งหมด (ไม่มีรายการรับ/ตั้งค่า SMS) */
  mode?: "home" | "full";
  onSeeAll?: () => void;
}

function formatShortDate(iso: string | null) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("th-TH", { day: "numeric", month: "short", timeZone: "Asia/Bangkok" });
}

function daysLeft(iso: string | null) {
  if (!iso) return null;
  const days = Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
  return days <= 0 ? null : days;
}

/** ดวงสะสม — เกิน 12 ดวงแสดงเป็นหลอดอย่างเดียว */
function Stamps({ progress, target }: { progress: number; target: number }) {
  if (target > 12) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5" aria-hidden>
      {Array.from({ length: target }, (_, i) => {
        const last = i === target - 1;
        const done = i < progress;
        return (
          <span
            key={i}
            className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${
              done
                ? "bg-[var(--color-brand)] text-white"
                : last
                  ? "border-2 border-[var(--color-brand)] text-[var(--color-brand)]"
                  : "border-2 border-dashed border-[var(--border-strong)] text-[var(--quiet)]"
            }`}
          >
            {done ? "✓" : last ? "🎁" : i + 1}
          </span>
        );
      })}
    </div>
  );
}

function ProgressBar({ progress, target }: { progress: number; target: number }) {
  const pct = Math.min(100, Math.round((progress / Math.max(target, 1)) * 100));
  return (
    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--canvas-2)]">
      <div className="h-full rounded-full bg-[var(--color-brand)]" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function MemberMissionsCard({ storeSlug, portalCode, view, mode = "full", onSeeAll }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [openId, setOpenId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [smsOptIn, setSmsOptIn] = useState(true);

  if (!view.enabled || view.missions.length === 0) return null;

  const active = view.missions.filter((m) => m.enrollment?.status === "active");
  const others = view.missions.filter((m) => m.enrollment?.status !== "active");
  const opened = view.missions.find((m) => m.missionId === openId) ?? null;

  function join(mission: MemberMissionCard) {
    setMessage(null);
    const fd = new FormData();
    fd.set("storeSlug", storeSlug);
    fd.set("portalCode", portalCode);
    fd.set("missionId", mission.missionId);
    fd.set("smsOptIn", smsOptIn && !view.smsOptOut ? "1" : "0");
    startTransition(async () => {
      const res = await joinMissionAction(fd);
      if (res.error) {
        setMessage(res.error);
        return;
      }
      setMessage(res.already ? "คุณกำลังทำภารกิจนี้อยู่แล้ว" : `รับภารกิจ “${mission.name}” แล้ว — บอกเบอร์หรือแสดงรหัสสมาชิกทุกครั้งที่ซื้อ`);
      setOpenId(mission.missionId);
      router.refresh();
    });
  }

  function toggleSmsOptOut() {
    setMessage(null);
    const fd = new FormData();
    fd.set("storeSlug", storeSlug);
    fd.set("portalCode", portalCode);
    fd.set("optOut", view.smsOptOut ? "0" : "1");
    startTransition(async () => {
      const res = await setMissionSmsOptOutAction(fd);
      if (res.error) {
        setMessage(res.error);
        return;
      }
      setMessage(view.smsOptOut ? "เปิดรับ SMS ภารกิจแล้ว" : "หยุดรับ SMS ภารกิจจากร้านนี้แล้ว");
      router.refresh();
    });
  }

  const hasJoinable = view.missions.some((m) => m.canJoin);

  // หน้าแรก: แถบภารกิจที่กำลังทำ (แตะ = ไปแท็บภารกิจ) หรือชวนรับภารกิจ
  if (mode === "home") {
    const joinable = view.missions.filter((m) => m.canJoin).length;
    return (
      <section aria-label="ภารกิจที่กำลังทำ">
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="text-base font-bold text-[var(--foreground)]">
            {active.length > 0 ? `ภารกิจที่กำลังทำ (${active.length})` : "ภารกิจ"}
          </h2>
          <button type="button" onClick={onSeeAll} className="text-xs font-semibold text-[var(--tenant-primary)]">
            ดูทั้งหมด ›
          </button>
        </div>
        {active.length > 0 ? (
          <div className="-mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {active.map((m) => {
              const e = m.enrollment!;
              const left = daysLeft(e.expiresAt);
              return (
                <button
                  key={m.missionId}
                  type="button"
                  onClick={onSeeAll}
                  className="w-40 shrink-0 snap-start rounded-xl border border-[var(--border)] bg-white p-3 text-left"
                >
                  <p className="line-clamp-2 min-h-[2.5rem] text-sm font-semibold leading-snug text-[var(--foreground)]">{m.name}</p>
                  <ProgressBar progress={e.progress} target={e.targetCount} />
                  <div className="mt-1 flex justify-between text-[11px] text-[var(--muted)]">
                    <span>{e.progress}/{e.targetCount}</span>
                    <span>{left ? `เหลือ ${left} วัน` : e.expiresAt ? formatShortDate(e.expiresAt) : ""}</span>
                  </div>
                </button>
              );
            })}
          </div>
        ) : (
          <button
            type="button"
            onClick={onSeeAll}
            className="flex w-full items-center gap-3 rounded-xl border border-[var(--border)] bg-white p-3 text-left"
          >
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-[var(--tenant-primary-soft)] text-xl">🎯</span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-[var(--foreground)]">
                {joinable > 0 ? `มีภารกิจให้รับ ${joinable} รายการ` : "ดูภารกิจของร้าน"}
              </span>
              <span className="block text-xs text-[var(--muted)]">ซื้อครบตามภารกิจ รับคูปองรางวัล ไม่ต้องจ่ายล่วงหน้า</span>
            </span>
            <span className="text-sm font-semibold text-[var(--tenant-primary)]">›</span>
          </button>
        )}
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-[var(--border)] bg-white p-5 shadow-sm">
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-bold text-[var(--foreground)]">ภารกิจ</h2>
        {active.length > 0 && <span className="text-xs text-[var(--muted)]">กำลังทำ {active.length}</span>}
      </div>

      {message && (
        <p className="mt-2 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-sm text-[var(--ink-2)]" role="status">
          {message}
        </p>
      )}

      {active.length > 0 && (
        <div className="-mx-5 mt-3 flex snap-x gap-3 overflow-x-auto px-5 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {active.map((m) => {
            const e = m.enrollment!;
            const left = daysLeft(e.expiresAt);
            return (
              <button
                key={m.missionId}
                type="button"
                onClick={() => setOpenId(openId === m.missionId ? null : m.missionId)}
                className={`w-44 shrink-0 snap-start rounded-lg border p-3 text-left ${
                  openId === m.missionId ? "border-[var(--color-brand)]" : "border-[var(--border)]"
                } bg-white`}
              >
                <p className="line-clamp-2 min-h-[2.5rem] text-sm font-semibold leading-snug text-[var(--foreground)]">{m.name}</p>
                <ProgressBar progress={e.progress} target={e.targetCount} />
                <div className="mt-1 flex justify-between text-[11px] text-[var(--muted)]">
                  <span>{e.progress}/{e.targetCount}</span>
                  <span>{left ? `เหลือ ${left} วัน` : e.expiresAt ? formatShortDate(e.expiresAt) : ""}</span>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {opened && opened.enrollment && (
        <div className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] p-3">
          <p className="font-semibold text-[var(--foreground)]">{opened.name}</p>
          <p className="text-xs text-[var(--muted)]">รางวัล: {opened.rewardText}</p>
          <Stamps progress={opened.enrollment.progress} target={opened.enrollment.targetCount} />
          {opened.enrollment.targetCount > 12 && <ProgressBar progress={opened.enrollment.progress} target={opened.enrollment.targetCount} />}
          {opened.enrollment.status === "active" && (
            <p className="mt-2 text-sm font-bold text-[var(--color-brand-hover)]">
              อีก {Math.max(opened.enrollment.targetCount - opened.enrollment.progress, 0)} ชิ้น ได้รางวัล!
            </p>
          )}
          {opened.enrollment.status === "completed" && (
            <p className="mt-2 text-sm font-bold text-emerald-700">ทำครบแล้ว — คูปองรางวัลอยู่ในแท็บ “คูปอง” ด้านล่าง</p>
          )}
          <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-[var(--ink-2)]">
            <li>นับ: {opened.scopeText}{opened.maxPerOrder ? ` · สูงสุด ${opened.maxPerOrder} ชิ้นต่อบิล` : ""}</li>
            <li>นับเฉพาะบิลที่จ่ายหลังกดรับ และต้องบอกเบอร์หรือแสดงรหัสสมาชิกตอนจ่าย</li>
            {opened.enrollment.expiresAt && <li>หมดเขตรอบนี้ {formatShortDate(opened.enrollment.expiresAt)}</li>}
            <li>ใช้คูปองรางวัลต้องแสดงรหัสสมาชิก 5 นาทีที่ร้าน</li>
          </ul>
        </div>
      )}

      {others.length > 0 && (
        <div className="mt-4 space-y-2">
          <p className="text-sm font-semibold text-[var(--foreground)]">{active.length > 0 ? "ภารกิจอื่น" : "ภารกิจสำหรับคุณ"}</p>
          {others.map((m) => {
            const e = m.enrollment;
            const ended = m.joinEndsAt ? formatShortDate(m.joinEndsAt) : null;
            return (
              <div key={m.missionId} className="flex items-center gap-3 rounded-lg border border-[var(--border)] p-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-[var(--foreground)]">{m.name}</p>
                  <p className="text-xs text-[var(--muted)]">
                    {m.targetCount} ชิ้น · {m.rewardText}
                    {m.durationDays ? ` · ภายใน ${m.durationDays} วัน` : ""}
                    {ended ? ` · รับได้ถึง ${ended}` : ""}
                  </p>
                  {e?.status === "completed" && <p className="text-xs font-semibold text-emerald-700">ทำครบแล้ว (รอบที่ {e.round})</p>}
                  {e?.status === "expired" && <p className="text-xs text-[var(--muted)]">รอบที่แล้วหมดเขต</p>}
                </div>
                {m.canJoin ? (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => join(m)}
                    className="shrink-0 rounded-lg border-2 border-[var(--color-brand)] px-3 py-1.5 text-sm font-semibold text-[var(--color-brand)] disabled:opacity-50"
                  >
                    {e ? "รับรอบใหม่" : "รับภารกิจ"}
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      {hasJoinable && !view.smsOptOut && (
        <label className="mt-3 flex items-start gap-2 text-xs text-[var(--ink-2)]">
          <input type="checkbox" className="mt-0.5" checked={smsOptIn} onChange={(e) => setSmsOptIn(e.target.checked)} />
          <span>รับ SMS แจ้งเมื่อใกล้ครบ ได้คูปอง และคูปองใกล้หมดอายุ (ไม่เกิน 3 ข้อความทุก 7 วัน)</span>
        </label>
      )}
      <button
        type="button"
        disabled={pending}
        onClick={toggleSmsOptOut}
        className="mt-3 block text-xs text-[var(--muted)] underline disabled:opacity-50"
      >
        {view.smsOptOut ? "เปิดรับ SMS ภารกิจจากร้านนี้" : "หยุดรับ SMS ภารกิจจากร้านนี้"}
      </button>
    </section>
  );
}
