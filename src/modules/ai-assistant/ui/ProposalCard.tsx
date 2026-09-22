"use client";

import { useState } from "react";
import type { AssistantProposal } from "./text-assistant-ui";

/**
 * การ์ดยืนยัน — จอเป็นด่านสุดท้ายก่อนข้อมูลจริงของร้านถูกแก้
 *
 * เสียงใช้ "สั่ง" ไม่ใช่ "ยืนยัน": ASR ฟังตัวเลขผิดได้ในร้านเสียงดัง และการเลือก
 * สถานี/หมวดหลายรายการทำด้วยเสียงล้วนไม่ไหวอยู่แล้ว — การให้ตาเห็นก่อนกดคือด่านกัน
 * ความผิดพลาดที่ถูกที่สุดที่เรามี
 *
 * ปุ่มยืนยันถูกปิดจนกว่าสิ่งที่ขาดจะถูกตอบครบ (แบบ create/blocked ตอบไม่ได้เลย)
 * ซึ่งสะท้อนกติกาเดียวกับฝั่ง server ไม่ใช่ตรวจซ้ำแบบหลวม ๆ
 *
 * ## ทุกขนาดจอ
 * ใช้ที่เดียวกันทั้งแผงผู้ช่วยในหน้าขาย (กว้างไม่กี่ร้อย px) และแผงหลังร้านบนจอใหญ่
 * จึงต้องอ่านออกตั้งแต่ ~320px: แถวรายการ diff ซ้อนลงเป็นสองบรรทัดบนจอแคบแล้วค่อย
 * เรียงเป็นคอลัมน์บนจอกว้าง, dropdown ยืดเต็มความกว้างบนมือถือแล้วค่อยตรึงความกว้าง
 * บน sm ขึ้นไป, ชื่อยาวถูกตัดด้วย truncate ไม่ให้ดันปุ่มหลุดขอบ และปุ่มยืนยัน/ยกเลิก
 * สูงอย่างน้อย 44px ตามขนาดนิ้วเสมอ
 */
export function ProposalCard({
  proposal,
  busy,
  onConfirm,
  onCancel,
}: {
  proposal: AssistantProposal;
  busy: boolean;
  onConfirm: (answers: Record<string, string>) => void;
  onCancel: () => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const chooses = proposal.prerequisites.filter((prerequisite) => prerequisite.kind === "choose");
  const blockers = proposal.prerequisites.filter((prerequisite) => prerequisite.kind !== "choose");
  const answeredAll = chooses.every((prerequisite) =>
    prerequisite.subjects.every((subject) => {
      const picked = answers[subject.id];
      return picked !== undefined && prerequisite.options.some((option) => option.id === picked);
    }),
  );
  const canConfirm = !busy && blockers.length === 0 && answeredAll;

  return (
    <section
      aria-label="ยืนยันก่อนลงมือ"
      className="w-full min-w-0 rounded-lg border border-orange-300 bg-orange-50 p-3 text-sm sm:p-4"
    >
      <p className="font-semibold break-words text-gray-900">{proposal.summary}</p>

      <dl className="mt-2 space-y-1">
        {proposal.changes.map((change) => (
          <div key={change.label} className="flex flex-col gap-0 sm:flex-row sm:gap-2">
            <dt className="text-xs text-gray-500 sm:w-28 sm:shrink-0 sm:text-sm">{change.label}</dt>
            <dd className="min-w-0 break-words text-gray-900">
              {change.before === null ? change.after : `${change.before} → ${change.after}`}
            </dd>
          </div>
        ))}
      </dl>

      {proposal.affectedCount > 1 ? (
        <p className="mt-2 font-medium text-gray-700">กระทบทั้งหมด {proposal.affectedCount} รายการ</p>
      ) : null}

      {proposal.warnings.map((warning) => (
        <p key={warning} className="mt-2 break-words text-amber-800">⚠ {warning}</p>
      ))}

      {blockers.map((prerequisite) => (
        <p key={prerequisite.need} className="mt-2 break-words text-red-700">
          {prerequisite.kind === "create"
            ? `ต้องสร้าง${prerequisite.need}ก่อน — ${prerequisite.reason}`
            : `แพ็กเกจยังไม่รองรับ${prerequisite.need} — ติดต่อผู้ดูแลระบบ`}
        </p>
      ))}

      {chooses.map((prerequisite) => (
        <div key={prerequisite.need} className="mt-3">
          <p className="text-gray-700">
            เลือก{prerequisite.need}ให้ {prerequisite.subjects.length} รายการ
          </p>

          {/* 12 รายการต้องไม่กด 12 ครั้ง */}
          {prerequisite.subjects.length > 1 ? (
            <label className="mt-1 flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
              <span className="text-xs text-gray-500 sm:shrink-0">ใช้ค่าเดียวกันทั้งหมด</span>
              <select
                className="min-h-11 w-full rounded-lg border border-gray-300 px-2 text-sm sm:flex-1"
                value=""
                onChange={(event) => {
                  const picked = event.target.value;
                  if (!picked) return;
                  setAnswers((previous) => ({
                    ...previous,
                    ...Object.fromEntries(prerequisite.subjects.map((subject) => [subject.id, picked])),
                  }));
                }}
              >
                <option value="">— เลือก —</option>
                {prerequisite.options.map((option) => (
                  <option key={option.id} value={option.id}>{option.label}</option>
                ))}
              </select>
            </label>
          ) : null}

          {/* รายการยาวเลื่อนในกรอบ ไม่ดันการ์ดจนปุ่มยืนยันหลุดจอ */}
          <div className="mt-1 max-h-56 space-y-2 overflow-y-auto sm:max-h-64">
            {prerequisite.subjects.map((subject) => (
              <label key={subject.id} className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
                <span className="min-w-0 flex-1 truncate text-gray-800" title={subject.label}>{subject.label}</span>
                <select
                  aria-label={`${prerequisite.need}ของ ${subject.label}`}
                  className="min-h-11 w-full rounded-lg border border-gray-300 px-2 text-sm sm:w-44 sm:shrink-0"
                  value={answers[subject.id] ?? ""}
                  onChange={(event) => setAnswers((previous) => ({ ...previous, [subject.id]: event.target.value }))}
                >
                  <option value="">— เลือก —</option>
                  {prerequisite.options.map((option) => (
                    <option key={option.id} value={option.id}>{option.label}</option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        </div>
      ))}

      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <button
          type="button"
          disabled={!canConfirm}
          onClick={() => onConfirm(answers)}
          className="min-h-11 rounded-lg bg-orange-600 px-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-gray-300 sm:order-2 sm:flex-1"
        >
          ยืนยัน
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="min-h-11 rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-700 sm:order-1"
        >
          ยกเลิก
        </button>
      </div>
    </section>
  );
}
