"use client";

/**
 * หน้าดูบันทึกการทำงานของระบบ — ออกแบบให้ "กวาดตาครั้งเดียวรู้ว่าวันนี้มีปัญหาไหม"
 *
 * ลำดับการอ่านที่ตั้งใจไว้:
 *   1. แถบสรุปบนสุด — แดง/เหลือง/เทา บอกทันทีว่าวันนี้โอเคหรือไม่
 *   2. รายการปัญหา (จัดกลุ่มแล้ว) — เรียงร้ายแรงก่อน แล้วตามจำนวนครั้ง
 *   3. กดขยายดูรายละเอียด/context เมื่ออยากเจาะ
 *   4. ปุ่มคัดลอกสำหรับ AI — ได้สรุปโครงสร้างคงที่ไปวางถาม AI ได้เลย
 */

import { useState } from "react";
import Link from "next/link";
import type { SystemLogDay, SystemLogGroup } from "@/modules/system/event-log-repository";
import type { SystemLogLevel } from "@/modules/system/event-log";

const LEVEL_LABEL: Record<SystemLogLevel, string> = {
  error: "ข้อผิดพลาด",
  warn: "คำเตือน",
  info: "ทั่วไป",
};

const LEVEL_STYLE: Record<SystemLogLevel, string> = {
  error: "bg-[var(--color-danger-soft,#fee2e2)] text-[var(--color-danger,#b91c1c)]",
  warn: "bg-[#fef3c7] text-[#b45309]",
  info: "bg-[var(--surface-2,#f1f5f9)] text-[var(--muted)]",
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("th-TH", {
    timeZone: "Asia/Bangkok",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(d);
}

function formatDayLabel(day: string): string {
  const d = new Date(`${day}T00:00:00+07:00`);
  if (Number.isNaN(d.getTime())) return day;
  return new Intl.DateTimeFormat("th-TH", {
    timeZone: "Asia/Bangkok",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(d);
}

function LevelBadge({ level }: { level: SystemLogLevel }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${LEVEL_STYLE[level]}`}>
      {LEVEL_LABEL[level]}
    </span>
  );
}

function GroupCard({ group, index }: { group: SystemLogGroup; index: number }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-lg border border-[var(--border)] bg-white">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-3 p-4 text-left"
        aria-expanded={open}
      >
        <span className="mt-0.5 text-sm font-bold text-[var(--muted)]">{index + 1}.</span>
        <span className="min-w-0 flex-1 space-y-1">
          <span className="flex flex-wrap items-center gap-2">
            <LevelBadge level={group.level} />
            <span className="font-bold text-[var(--ink)]">{group.source}</span>
            <span className="text-xs text-[var(--muted)]">→ {group.action}</span>
          </span>
          <span className="block break-words text-sm text-[var(--ink-2)]">{group.message}</span>
          <span className="block text-xs text-[var(--muted)]">
            เกิด {group.occurrences} ครั้ง · ล่าสุด {formatTime(group.lastAt)}
            {group.storeCount > 0 ? ` · ${group.storeCount} ร้าน` : ""}
            {group.errorCode ? ` · รหัส ${group.errorCode}` : ""}
          </span>
        </span>
        <span className="text-xs text-[var(--muted)]">{open ? "ซ่อน" : "ดู"}</span>
      </button>

      {open ? (
        <div className="space-y-2 border-t border-[var(--border)] px-4 py-3 text-xs">
          <p className="text-[var(--muted)]">
            ครั้งแรก {formatTime(group.firstAt)} · ครั้งล่าสุด {formatTime(group.lastAt)}
          </p>
          <p className="text-[var(--muted)]">
            รหัสกลุ่ม (fingerprint): <code className="break-all">{group.fingerprint}</code>
          </p>
          {group.sampleContext ? (
            <pre className="overflow-x-auto rounded-md bg-[var(--surface-2,#f8fafc)] p-3 text-[11px] leading-relaxed text-[var(--ink-2)]">
              {JSON.stringify(group.sampleContext, null, 2)}
            </pre>
          ) : (
            <p className="text-[var(--muted)]">ไม่มีรายละเอียดเพิ่มเติม</p>
          )}
        </div>
      ) : null}
    </li>
  );
}

function CopyForAiButton({ report }: { report: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-secondary"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(report);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 2000);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? "คัดลอกแล้ว ✓" : "คัดลอกสำหรับ AI"}
    </button>
  );
}

export function SystemLogView({
  data,
  level,
  today,
  prevDay,
  nextDay,
  loadError,
  aiReport,
}: {
  data: SystemLogDay;
  level: SystemLogLevel | "all";
  today: string;
  prevDay: string;
  nextDay: string;
  loadError: string | null;
  aiReport: string;
}) {
  const isToday = data.day === today;
  const isFuture = data.day >= today;
  const healthy = data.counts.error === 0 && data.counts.warn === 0;

  const levelHref = (next: SystemLogLevel | "all") =>
    `/system/logs?day=${data.day}${next === "all" ? "" : `&level=${next}`}`;

  return (
    <div className="space-y-5">
      <div className="page-header">
        <div>
          <h1 className="page-title">บันทึกการทำงานของระบบ</h1>
          <p className="page-kicker">
            ดูวันต่อวันว่าระบบมีอะไรผิดปกติบ้าง ย้อนหลังได้ 30 วัน (เวลาไทย)
          </p>
        </div>
        <CopyForAiButton report={aiReport} />
      </div>

      {/* เลือกวัน */}
      <div className="panel flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="flex items-center gap-2">
          <Link
            href={`/system/logs?day=${prevDay}${level === "all" ? "" : `&level=${level}`}`}
            className="btn btn-secondary"
          >
            ‹ วันก่อน
          </Link>
          <div className="px-2 text-center">
            <p className="font-bold text-[var(--ink)]">{formatDayLabel(data.day)}</p>
            <p className="text-xs text-[var(--muted)]">{isToday ? "วันนี้" : data.day}</p>
          </div>
          {isFuture ? (
            <span className="btn btn-secondary opacity-40">วันถัดไป ›</span>
          ) : (
            <Link
              href={`/system/logs?day=${nextDay}${level === "all" ? "" : `&level=${level}`}`}
              className="btn btn-secondary"
            >
              วันถัดไป ›
            </Link>
          )}
        </div>
        {!isToday ? (
          <Link href="/system/logs" className="btn btn-secondary">
            กลับมาวันนี้
          </Link>
        ) : null}
      </div>

      {loadError ? (
        <div className="panel border-[var(--color-danger,#b91c1c)] p-4 text-sm text-[var(--color-danger,#b91c1c)]">
          โหลดบันทึกไม่สำเร็จ: {loadError}
        </div>
      ) : null}

      {/* สรุปสถานะ — กวาดตาครั้งเดียวรู้เรื่อง */}
      <div className="grid gap-3 sm:grid-cols-3">
        {(["error", "warn", "info"] as const).map((key) => {
          const active = level === key;
          return (
            <Link
              key={key}
              href={levelHref(active ? "all" : key)}
              className={`panel p-4 transition-shadow hover:shadow-md ${
                active ? "ring-2 ring-[var(--color-brand)]" : ""
              }`}
            >
              <p className="text-xs font-bold text-[var(--muted)]">{LEVEL_LABEL[key]}</p>
              <p
                className={`text-3xl font-black ${
                  key === "error" && data.counts.error > 0
                    ? "text-[var(--color-danger,#b91c1c)]"
                    : key === "warn" && data.counts.warn > 0
                      ? "text-[#b45309]"
                      : "text-[var(--ink)]"
                }`}
              >
                {data.counts[key]}
              </p>
              <p className="text-xs text-[var(--muted)]">{active ? "แตะเพื่อดูทั้งหมด" : "แตะเพื่อกรอง"}</p>
            </Link>
          );
        })}
      </div>

      {healthy && data.counts.info === 0 ? (
        <div className="panel p-6 text-center">
          <p className="text-lg font-bold text-[var(--ink)]">ไม่มีเหตุการณ์ในวันนี้</p>
          <p className="text-sm text-[var(--muted)]">ระบบทำงานปกติ ไม่มีข้อผิดพลาดที่ถูกบันทึกไว้</p>
        </div>
      ) : null}

      {/* ปัญหาที่จัดกลุ่มแล้ว */}
      {data.groups.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-sm font-bold text-[var(--ink)]">
            สิ่งที่เกิดขึ้น ({data.groups.length} รายการ — เรียงจากร้ายแรงและถี่ที่สุด)
          </h2>
          <ul className="space-y-2">
            {data.groups.map((group, index) => (
              <GroupCard key={group.fingerprint} group={group} index={index} />
            ))}
          </ul>
        </section>
      ) : null}

      {/* เหตุการณ์ดิบล่าสุด — ไว้ไล่ลำดับเวลาเมื่อจำเป็น */}
      {data.recent.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-sm font-bold text-[var(--ink)]">ตามลำดับเวลา (ล่าสุด {data.recent.length} รายการ)</h2>
          <div className="panel overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] text-left text-xs text-[var(--muted)]">
                  <th className="px-4 py-3 font-bold">เวลา</th>
                  <th className="px-4 py-3 font-bold">ระดับ</th>
                  <th className="px-4 py-3 font-bold">จุดที่เกิด</th>
                  <th className="px-4 py-3 font-bold">รายละเอียด</th>
                </tr>
              </thead>
              <tbody>
                {data.recent.map((entry) => (
                  <tr key={entry.id} className="border-b border-[var(--border)] last:border-0 align-top">
                    <td className="whitespace-nowrap px-4 py-3 text-[var(--muted)]">{formatTime(entry.occurredAt)}</td>
                    <td className="px-4 py-3">
                      <LevelBadge level={entry.level} />
                    </td>
                    <td className="px-4 py-3">
                      <span className="font-bold text-[var(--ink)]">{entry.source}</span>
                      <span className="block text-xs text-[var(--muted)]">{entry.action}</span>
                    </td>
                    <td className="px-4 py-3 text-[var(--ink-2)]">
                      {entry.message}
                      {entry.durationMs !== null ? (
                        <span className="block text-xs text-[var(--muted)]">ใช้เวลา {entry.durationMs} มิลลิวินาที</span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}
