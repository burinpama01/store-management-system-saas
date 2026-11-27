"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { OwnerLockableField } from "@/modules/hr/self-info";
import type { SelfInfoRequestView } from "@/modules/hr/self-info-repository";
import { cancelMySelfInfoRequestAction, saveMySelfInfoAction } from "./actions";

export interface MyProfileView {
  locked: OwnerLockableField[];
  fullName: string;
  bankName: string;
  bankAccountMasked: string;
  bankAccountName: string;
  nickname: string;
  phone: string;
  birthDate: string;
  address: string;
  emergencyContactName: string;
  emergencyContactPhone: string;
  employeeCode: string;
  position: string;
}

// globals.css มี input { font: inherit } — ต้องตั้ง 16px ตรงนี้ ไม่งั้น iOS ซูมตอนแตะช่อง
const INPUT = "mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 disabled:bg-gray-100 disabled:text-gray-600";
const INPUT_STYLE = { fontSize: 16 } as const;
// พื้นเทาของช่องที่ล็อกต้อง inline เช่นกัน (สไตล์ input ส่วนกลางทับ class disabled:)
const LOCKED_STYLE = { fontSize: 16, background: "#f3f4f6", color: "#4b5563", cursor: "not-allowed" } as const;

function OwnerBadge() {
  return (
    <span className="ml-2 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-600">เจ้าของร้านตั้งไว้</span>
  );
}

export function MyProfileForm({ view, today, request }: { view: MyProfileView; today: string; request?: SelfInfoRequestView | null }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const isLocked = (f: OwnerLockableField) => view.locked.includes(f);

  const field = (name: OwnerLockableField, label: string, value: string, extra?: { placeholder?: string; maxLength?: number }) => (
    <label className="text-xs font-medium text-gray-600">
      {label}
      {isLocked(name) && <OwnerBadge />}
      <input
        name={name}
        defaultValue={value}
        disabled={isLocked(name)}
        maxLength={extra?.maxLength}
        placeholder={extra?.placeholder}
        className={INPUT}
        style={isLocked(name) ? LOCKED_STYLE : INPUT_STYLE}
      />
    </label>
  );

  return (
    <>
    {request?.status === "pending" && (
      <section className="rounded-xl border border-amber-300 bg-amber-50 p-4">
        <p className="text-sm font-bold text-amber-900">คำขอแก้ข้อมูลรอผู้จัดการอนุมัติ</p>
        <ul className="mt-1 space-y-0.5 text-sm text-gray-800">
          {request.changes.map((c) => (
            <li key={c.field}>
              {c.label}: <b>{c.value ?? "ขอลบค่านี้"}</b>
            </li>
          ))}
        </ul>
        <p className="mt-1 text-xs text-amber-900">ระหว่างรออนุมัติ ระบบยังใช้ค่าเดิม · ส่งคำขอใหม่จะแทนที่คำขอนี้</p>
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            setError(null);
            setNotice(null);
            startTransition(async () => {
              const res = await cancelMySelfInfoRequestAction(request.id);
              if (res.error) setError(res.error);
              else {
                setNotice("ยกเลิกคำขอแล้ว");
                router.refresh();
              }
            });
          }}
          className="btn-secondary mt-2 min-h-11 px-4 text-sm"
        >
          ยกเลิกคำขอ
        </button>
      </section>
    )}
    {request?.status === "rejected" && (
      <p className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">
        คำขอแก้ข้อมูลล่าสุดไม่ได้รับอนุมัติ{request.reviewNote ? `: ${request.reviewNote}` : ""}
      </p>
    )}
    <form
      ref={formRef}
      // ค่าจากเซิร์ฟเวอร์เปลี่ยน (เช่น ผู้จัดการอนุมัติ) ต้องสร้างช่องใหม่ เพราะ input เป็น uncontrolled
      key={JSON.stringify(view)}
      // ใช้ onSubmit แทน action: action ล้างฟอร์มเองแม้กรอกผิด ผู้ใช้จะเสียค่าที่พิมพ์
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        setError(null);
        setNotice(null);
        startTransition(async () => {
          const res = await saveMySelfInfoAction(fd);
          if (res.error) {
            setError(res.error);
            return;
          }
          const parts = [
            res.savedCount > 0 ? `บันทึกแล้ว ${res.savedCount} ช่อง` : "",
            res.requestedCount > 0 ? `ส่งคำขอแก้ ${res.requestedCount} ช่อง รอผู้จัดการอนุมัติ` : "",
          ].filter(Boolean);
          setNotice(parts.join(" · ") || "ไม่มีข้อมูลที่เปลี่ยน");
          // ช่องที่ส่งคำขอยังใช้ค่าเดิมจนกว่าจะอนุมัติ — คืนฟอร์มให้ตรงกับค่าจริง
          formRef.current?.reset();
          router.refresh();
        });
      }}
      className="space-y-4"
    >
      {(view.employeeCode || view.position) && (
        <div className="rounded-xl border border-gray-200 bg-white p-4 text-sm text-gray-700">
          {view.employeeCode && <span className="mr-4">รหัสพนักงาน <b>{view.employeeCode}</b></span>}
          {view.position && <span>ตำแหน่ง <b>{view.position}</b></span>}
        </div>
      )}

      <fieldset className="grid gap-3 rounded-xl border border-gray-200 bg-white p-4 sm:grid-cols-2">
        <legend className="px-1 text-sm font-bold text-gray-800">ข้อมูลส่วนตัว</legend>
        {field("fullName", "ชื่อ-สกุลจริง", view.fullName, { maxLength: 150 })}
        <label className="text-xs font-medium text-gray-600">
          ชื่อเล่น
          <input name="nickname" defaultValue={view.nickname} maxLength={50} className={INPUT} style={INPUT_STYLE} />
        </label>
        <label className="text-xs font-medium text-gray-600">
          เบอร์โทร
          <input name="phone" type="tel" inputMode="tel" defaultValue={view.phone} maxLength={20} placeholder="08xxxxxxxx" className={INPUT} style={INPUT_STYLE} />
        </label>
        <label className="text-xs font-medium text-gray-600">
          วันเกิด
          <input name="birthDate" type="date" max={today} defaultValue={view.birthDate} className={INPUT} style={INPUT_STYLE} />
        </label>
        <label className="text-xs font-medium text-gray-600 sm:col-span-2">
          ที่อยู่
          <textarea name="address" defaultValue={view.address} maxLength={400} rows={2} className={`${INPUT} py-2`} style={INPUT_STYLE} />
        </label>
      </fieldset>

      <fieldset className="grid gap-3 rounded-xl border border-gray-200 bg-white p-4 sm:grid-cols-2">
        <legend className="px-1 text-sm font-bold text-gray-800">ผู้ติดต่อฉุกเฉิน</legend>
        <label className="text-xs font-medium text-gray-600">
          ชื่อ
          <input name="emergencyContactName" defaultValue={view.emergencyContactName} maxLength={150} className={INPUT} style={INPUT_STYLE} />
        </label>
        <label className="text-xs font-medium text-gray-600">
          เบอร์โทร
          <input name="emergencyContactPhone" type="tel" inputMode="tel" defaultValue={view.emergencyContactPhone} maxLength={20} className={INPUT} style={INPUT_STYLE} />
        </label>
      </fieldset>

      <fieldset className="grid gap-3 rounded-xl border border-gray-200 bg-white p-4 sm:grid-cols-2">
        <legend className="px-1 text-sm font-bold text-gray-800">
          บัญชีรับเงินเดือน
          {view.bankAccountMasked && <span className="ml-2 font-normal text-gray-500">ปัจจุบัน {view.bankName} {view.bankAccountMasked}</span>}
        </legend>
        {field("bankName", "ธนาคาร", view.bankName, { maxLength: 80, placeholder: "เช่น กสิกรไทย" })}
        <label className="text-xs font-medium text-gray-600">
          เลขบัญชี
          {isLocked("bankAccountNo") && <OwnerBadge />}
          <input
            name="bankAccountNo"
            inputMode="numeric"
            autoComplete="off"
            maxLength={24}
            disabled={isLocked("bankAccountNo")}
            placeholder={view.bankAccountMasked ? `${view.bankAccountMasked}${isLocked("bankAccountNo") ? "" : " (เว้นว่าง = ไม่เปลี่ยน)"}` : ""}
            className={INPUT}
            style={isLocked("bankAccountNo") ? LOCKED_STYLE : INPUT_STYLE}
          />
          {view.bankAccountMasked && !isLocked("bankAccountNo") && (
            <span className="mt-1 flex items-center gap-1 text-[11px] font-normal text-gray-500">
              <input type="checkbox" name="clearBankAccount" className="accent-orange-500" />
              ลบเลขบัญชีนี้
            </span>
          )}
        </label>
        {field("bankAccountName", "ชื่อบัญชี", view.bankAccountName, { maxLength: 150 })}
      </fieldset>

      {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {notice && <p className="rounded-lg bg-green-50 p-3 text-sm text-green-700">{notice}</p>}
      <button type="submit" disabled={pending} className="btn-primary min-h-11 w-full px-5 sm:w-auto">
        {pending ? "กำลังบันทึก…" : "บันทึกข้อมูล"}
      </button>
    </form>
    </>
  );
}
