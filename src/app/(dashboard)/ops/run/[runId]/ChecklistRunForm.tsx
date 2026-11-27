"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { formatMeasuredValue } from "@/modules/operations/rules";
import { CHECKLIST_ANSWER_LABELS, type ChecklistAnswer, type ChecklistRun, type ChecklistRunItem } from "@/modules/operations/types";
import {
  answerChecklistItemAction,
  reopenChecklistRunAction,
  submitChecklistRunAction,
  uploadChecklistPhotoAction,
} from "../../actions";

const ANSWER_TONE: Record<ChecklistAnswer, string> = {
  pass: "border-emerald-300 bg-emerald-50 text-emerald-800",
  fail: "border-red-300 bg-red-50 text-red-800",
  na: "border-gray-300 bg-gray-50 text-gray-700",
};

function needsPhoto(item: ChecklistRunItem): boolean {
  return item.photoRule === "always" || (item.photoRule === "on_fail" && item.answer === "fail");
}

export function ChecklistRunForm({
  run,
  editable,
  canReopen,
  photoUrls,
  answeredByLabels,
}: {
  run: ChecklistRun;
  editable: boolean;
  canReopen: boolean;
  photoUrls: Record<string, string>;
  answeredByLabels: Record<string, string>;
}) {
  const router = useRouter();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, startSubmit] = useTransition();
  const answered = run.items.filter((item) => item.answer !== null).length;
  const missingPhotos = run.items.filter((item) => needsPhoto(item) && !item.photoPath).length;
  const ready = answered === run.items.length && missingPhotos === 0;

  return (
    <div className="space-y-3">
      {run.items.map((item, index) => (
        <ChecklistItemCard
          key={item.id}
          runId={run.id}
          index={index + 1}
          item={item}
          editable={editable}
          photoUrl={item.photoPath ? photoUrls[item.photoPath] : undefined}
          answeredByLabel={answeredByLabels[item.id]}
          onSaved={() => router.refresh()}
        />
      ))}

      {editable && (
        <div className="sticky bottom-0 z-10 -mx-4 border-t border-gray-200 bg-white/95 py-3 pl-4 pr-24 backdrop-blur sm:mx-0 sm:rounded-lg sm:border">
          <div className="flex flex-wrap items-center gap-3">
            <p className="min-w-0 flex-1 text-sm text-gray-700">
              ตอบแล้ว {answered}/{run.items.length} ข้อ
              {missingPhotos > 0 && <span className="ml-2 text-red-700">ขาดรูป {missingPhotos} ข้อ</span>}
            </p>
            <button
              type="button"
              className="btn-primary"
              disabled={!ready || submitting}
              onClick={() => {
                setSubmitError(null);
                startSubmit(async () => {
                  const result = await submitChecklistRunAction(run.id);
                  if (!result.ok) setSubmitError(result.error);
                  else router.push("/ops");
                });
              }}
            >
              {submitting ? "กำลังส่ง…" : "ส่งเช็กลิสต์"}
            </button>
          </div>
          {submitError && <p className="mt-2 text-sm text-red-700" role="alert">{submitError}</p>}
        </div>
      )}

      {canReopen && <ReopenPanel runId={run.id} onDone={() => router.refresh()} />}
    </div>
  );
}

function ChecklistItemCard({
  runId,
  index,
  item,
  editable,
  photoUrl,
  answeredByLabel,
  onSaved,
}: {
  runId: string;
  index: number;
  item: ChecklistRunItem;
  editable: boolean;
  photoUrl?: string;
  answeredByLabel?: string;
  onSaved: () => void;
}) {
  const [value, setValue] = useState(item.value === null ? "" : String(item.value));
  const [note, setNote] = useState(item.note ?? "");
  const [showNote, setShowNote] = useState(Boolean(item.note));
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);

  const range = item.minValue !== null || item.maxValue !== null
    ? `ช่วงที่ร้านกำหนด ${item.minValue ?? "…"}–${item.maxValue ?? "…"}${item.unit ? ` ${item.unit}` : ""}`
    : null;

  function save(answer: ChecklistAnswer) {
    setError(null);
    setMessage(null);
    let numeric: number | null = null;
    if (item.valueType === "number" && answer !== "na") {
      if (value.trim() === "") {
        setError("กรอกค่าที่วัดได้ก่อน");
        return;
      }
      numeric = Number(value);
      if (!Number.isFinite(numeric)) {
        setError("ค่าที่กรอกต้องเป็นตัวเลข");
        return;
      }
    }
    const noteRequired = answer === "na" || (answer === "fail" && item.critical);
    if (noteRequired && !note.trim()) {
      setShowNote(true);
      setError(answer === "na" ? "ใส่เหตุผลที่ไม่เกี่ยวก่อน" : "ข้อสำคัญไม่ผ่าน — ใส่หมายเหตุว่าเกิดอะไรขึ้นและทำอะไรไปแล้ว");
      return;
    }
    startTransition(async () => {
      const result = await answerChecklistItemAction({ runId, runItemId: item.id, answer, value: numeric, note: note.trim() || null });
      if (!result.ok) {
        // ค่าเกินช่วงของข้อสำคัญ = server ต้องการหมายเหตุ เปิดช่องให้กรอก
        setShowNote(true);
        setError(result.error);
        return;
      }
      if (result.outOfRange) setMessage("ค่าเกินช่วงที่ร้านกำหนด — บันทึกเป็นไม่ผ่าน");
      onSaved();
    });
  }

  function upload(file: File) {
    setError(null);
    const formData = new FormData();
    formData.set("runId", runId);
    formData.set("runItemId", item.id);
    formData.set("file", file);
    startTransition(async () => {
      const result = await uploadChecklistPhotoAction(formData);
      if (!result.ok) setError(result.error);
      else onSaved();
      if (fileRef.current) fileRef.current.value = "";
    });
  }

  return (
    <div className={`rounded-lg border bg-white p-4 ${item.answer ? ANSWER_TONE[item.answer].split(" ")[0] : "border-gray-200"}`}>
      <div className="flex items-start gap-3">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-gray-100 text-xs font-bold text-gray-700">{index}</span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-gray-900">
            {item.label}
            {item.critical && <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-bold text-red-700">สำคัญ</span>}
          </p>
          {item.description && <p className="mt-0.5 text-xs text-gray-600">{item.description}</p>}
          {range && <p className="mt-0.5 text-xs text-gray-600">{range}</p>}
          {item.photoRule !== "never" && (
            <p className="mt-0.5 text-xs text-gray-500">{item.photoRule === "always" ? "ต้องแนบรูปทุกครั้ง" : "ไม่ผ่านต้องแนบรูป"}</p>
          )}
        </div>
        {item.answer && (
          <span className={`shrink-0 rounded-full border px-2 py-0.5 text-xs font-semibold ${ANSWER_TONE[item.answer]}`}>
            {CHECKLIST_ANSWER_LABELS[item.answer]}
          </span>
        )}
      </div>

      {!editable && (
        <div className="mt-2 space-y-1 pl-10 text-sm text-gray-700">
          {item.valueType === "number" && item.answer !== "na" && (
            <p>ค่าที่วัด: {formatMeasuredValue(item.value, item.unit, item.minValue, item.maxValue)}</p>
          )}
          {item.note && <p>หมายเหตุ: {item.note}</p>}
          {!item.answer && <p className="text-red-700">ยังไม่ตอบ</p>}
        </div>
      )}

      {editable && (
        <div className="mt-3 space-y-2 pl-10">
          {item.valueType === "number" && (
            <label className="flex items-center gap-2 text-sm">
              <span className="text-gray-700">ค่าที่วัดได้</span>
              <input
                type="number"
                inputMode="decimal"
                step="0.1"
                className="w-28 rounded-md border border-gray-300 px-2 py-2 text-base"
                value={value}
                onChange={(event) => setValue(event.target.value)}
                disabled={pending}
              />
              {item.unit && <span className="text-gray-600">{item.unit}</span>}
            </label>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-secondary !text-emerald-700" disabled={pending} onClick={() => save("pass")}>
              {item.valueType === "number" ? "บันทึกค่า" : "✓ ผ่าน"}
            </button>
            <button type="button" className="btn-secondary !text-red-700" disabled={pending} onClick={() => save("fail")}>✗ ไม่ผ่าน</button>
            <button type="button" className="btn-secondary" disabled={pending} onClick={() => save("na")}>ไม่เกี่ยว</button>
            {!showNote && (
              <button type="button" className="text-xs text-gray-600 underline" onClick={() => setShowNote(true)}>+ หมายเหตุ</button>
            )}
          </div>
          {showNote && (
            <textarea
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              rows={2}
              maxLength={1000}
              placeholder="เกิดอะไรขึ้น / ทำอะไรไปแล้ว"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              disabled={pending}
            />
          )}
          {item.photoRule !== "never" || item.photoPath ? (
            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) upload(file);
                }}
              />
              <button type="button" className="btn-secondary" disabled={pending} onClick={() => fileRef.current?.click()}>
                📷 {item.photoPath ? "ถ่ายใหม่" : "แนบรูป"}
              </button>
              {needsPhoto(item) && !item.photoPath && <span className="text-xs text-red-700">ต้องแนบรูป</span>}
            </div>
          ) : null}
        </div>
      )}

      {photoUrl && (
        // eslint-disable-next-line @next/next/no-img-element -- signed URL อายุสั้นจาก storage ส่วนตัว
        <img src={photoUrl} alt={`รูปหลักฐาน ${item.label}`} className="mt-2 ml-10 max-h-48 rounded-md border border-gray-200 object-contain" />
      )}
      {answeredByLabel && <p className="mt-2 pl-10 text-[11px] text-gray-500">{answeredByLabel}</p>}
      {pending && <p className="mt-1 pl-10 text-xs text-gray-500">กำลังบันทึก…</p>}
      {message && <p className="mt-1 pl-10 text-xs text-amber-700">{message}</p>}
      {error && <p className="mt-1 pl-10 text-xs text-red-700" role="alert">{error}</p>}
    </div>
  );
}

function ReopenPanel({ runId, onDone }: { runId: string; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <p className="text-sm font-semibold text-gray-900">เปิดให้แก้ใหม่</p>
      <p className="text-xs text-gray-600">พนักงานจะแก้คำตอบและส่งใหม่ได้ ระบบเก็บเหตุผลและคำตอบเดิมไว้ในประวัติ</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <input
          className="min-w-0 flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm"
          maxLength={500}
          placeholder="เหตุผล เช่น ให้วัดอุณหภูมิใหม่"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
        <button
          type="button"
          className="btn-secondary"
          disabled={pending || !reason.trim()}
          onClick={() => {
            setError(null);
            startTransition(async () => {
              const result = await reopenChecklistRunAction(runId, reason);
              if (!result.ok) setError(result.error);
              else onDone();
            });
          }}
        >
          {pending ? "กำลังเปิด…" : "เปิดให้แก้"}
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-red-700" role="alert">{error}</p>}
    </div>
  );
}
