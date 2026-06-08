"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { MemberWithEmail } from "@/modules/settings/repository";
import type { EmployeeProfile, PayrollAdjustment, StoreHrSettings } from "@/modules/hr/types";
import { PAY_TYPE_LABEL, ADJUSTMENT_LABEL, DEDUCTION_TYPES, WEEKDAY_LABELS } from "@/modules/hr/types";
import type { PayrollLine } from "@/modules/hr/payroll";
import type { Role } from "@/modules/tenants/types";
import {
  saveEmployeeProfileAction,
  addStaffMemberAction,
  addAdjustmentAction,
  deleteAdjustmentAction,
  saveHrSettingsAction,
} from "./actions";

interface Props {
  members: MemberWithEmail[];
  profiles: EmployeeProfile[];
  payrollLines: PayrollLine[];
  adjustments: PayrollAdjustment[];
  hrSettings: StoreHrSettings;
  currency: string;
  dateFrom: string;
  dateTo: string;
  today: string;
  canAddStaff: boolean;
}

const ROLE_LABELS: Record<Role, string> = {
  super_admin: "Super Admin",
  owner: "Owner",
  admin: "Admin",
  manager: "Manager",
  cashier: "Cashier",
  staff: "Staff",
};

function fmt(amount: number, currency: string): string {
  return new Intl.NumberFormat("th-TH", { style: "currency", currency, maximumFractionDigits: 2 }).format(amount);
}

export function StaffManager({
  members,
  profiles,
  payrollLines,
  adjustments,
  hrSettings,
  currency,
  dateFrom,
  dateTo,
  today,
  canAddStaff,
}: Props) {
  const router = useRouter();
  const [tab, setTab] = useState<"employees" | "payroll" | "policy">("employees");
  const [error, setError] = useState<string | null>(null);
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [showAddStaff, setShowAddStaff] = useState(false);
  const [isPending, startTransition] = useTransition();

  const profileByUser = new Map(profiles.map((p) => [p.userId, p]));
  // Members scoped to actual employees (exclude platform super_admin rows).
  const staff = members.filter((m) => m.role !== "super_admin");

  function run(action: () => Promise<{ error: string | null }>, onOk?: () => void) {
    setError(null);
    startTransition(async () => {
      const res = await action();
      if (res.error) setError(res.error);
      else {
        onOk?.();
        router.refresh();
      }
    });
  }

  function applyPeriod(from: string, to: string) {
    const sp = new URLSearchParams({ dateFrom: from, dateTo: to });
    router.push(`/staff?${sp.toString()}`);
  }

  return (
    <div className="page-shell">
      <div className="page-header">
        <div>
          <h1 className="text-xl font-bold text-[var(--ink)]">พนักงาน &amp; เงินเดือน</h1>
          <p className="text-sm text-[var(--muted)]">จัดการพนักงาน ค่าจ้าง และคำนวณเงินเดือน/บทลงโทษ</p>
        </div>
      </div>

      <div className="flex gap-2">
        <button
          onClick={() => setTab("employees")}
          className={`min-h-11 rounded-lg px-4 text-sm font-semibold ${tab === "employees" ? "bg-[var(--tenant-primary)] text-white" : "bg-[var(--surface-muted)] text-[var(--ink-2)]"}`}
        >
          พนักงาน
        </button>
        <button
          onClick={() => setTab("payroll")}
          className={`min-h-11 rounded-lg px-4 text-sm font-semibold ${tab === "payroll" ? "bg-[var(--tenant-primary)] text-white" : "bg-[var(--surface-muted)] text-[var(--ink-2)]"}`}
        >
          เงินเดือน
        </button>
        <button
          onClick={() => setTab("policy")}
          className={`min-h-11 rounded-lg px-4 text-sm font-semibold ${tab === "policy" ? "bg-[var(--tenant-primary)] text-white" : "bg-[var(--surface-muted)] text-[var(--ink-2)]"}`}
        >
          นโยบาย HR
        </button>
      </div>

      {error && <p className="rounded-lg bg-red-50 px-4 py-2 text-sm text-red-600">{error}</p>}

      {tab === "employees" ? (
        <section className="space-y-3">
          {canAddStaff && (
            <div className="rounded-lg border border-gray-200 bg-white p-4">
              <button
                onClick={() => setShowAddStaff((v) => !v)}
                className="text-sm font-bold text-[var(--ink)]"
              >
                {showAddStaff ? "▼" : "▶"} เพิ่มพนักงานใหม่
              </button>
              {showAddStaff && (
                <form
                  action={(fd) => run(() => addStaffMemberAction(fd), () => setShowAddStaff(false))}
                  className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
                >
                  <label className="text-xs font-medium text-gray-600">
                    อีเมล
                    <input name="email" type="email" required className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 text-sm" />
                  </label>
                  <label className="text-xs font-medium text-gray-600">
                    รหัสผ่านชั่วคราว
                    <input name="password" type="text" minLength={8} required className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 text-sm" />
                  </label>
                  <label className="text-xs font-medium text-gray-600">
                    บทบาท
                    <select name="role" defaultValue="staff" className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 text-sm">
                      <option value="staff">Staff</option>
                      <option value="cashier">Cashier</option>
                      <option value="manager">Manager</option>
                      <option value="admin">Admin</option>
                    </select>
                  </label>
                  <div className="flex items-end">
                    <button type="submit" disabled={isPending} className="btn-primary min-h-11 w-full text-sm">
                      เพิ่มพนักงาน
                    </button>
                  </div>
                  <p className="text-xs text-gray-400 sm:col-span-2 lg:col-span-4">
                    ระบบจะสร้างบัญชีให้ทันที (ยืนยันอีเมลแล้ว) — แจ้งรหัสผ่านชั่วคราวให้พนักงานเปลี่ยนภายหลัง
                  </p>
                </form>
              )}
            </div>
          )}

          <div className="space-y-2">
            {staff.length === 0 ? (
              <p className="rounded-lg border border-dashed border-gray-300 bg-white p-6 text-center text-sm text-gray-400">
                ยังไม่มีพนักงาน
              </p>
            ) : (
              staff.map((m) => {
                const profile = profileByUser.get(m.userId);
                const isEditing = editingUserId === m.userId;
                return (
                  <div key={m.membershipId} className="rounded-lg border border-gray-200 bg-white p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-semibold text-gray-900 truncate">
                          {profile?.displayName || m.email}
                        </p>
                        <p className="text-xs text-gray-400">
                          {ROLE_LABELS[m.role]} ·{" "}
                          {profile
                            ? `${PAY_TYPE_LABEL[profile.payType]} ${fmt(
                                profile.payType === "monthly"
                                  ? profile.monthlySalary
                                  : profile.payType === "daily"
                                    ? profile.dailyRate
                                    : profile.hourlyRate,
                                currency,
                              )}`
                            : "ยังไม่ตั้งค่าจ้าง"}
                        </p>
                      </div>
                      <button
                        onClick={() => setEditingUserId(isEditing ? null : m.userId)}
                        className="btn-secondary min-h-11 shrink-0 px-3 text-xs"
                      >
                        {isEditing ? "ปิด" : "ตั้งค่าจ้าง"}
                      </button>
                    </div>

                    {isEditing && (
                      <form
                        action={(fd) => run(() => saveEmployeeProfileAction(fd), () => setEditingUserId(null))}
                        className="mt-4 grid gap-3 border-t border-gray-100 pt-4 sm:grid-cols-2 lg:grid-cols-3"
                      >
                        <input type="hidden" name="userId" value={m.userId} />
                        <label className="text-xs font-medium text-gray-600">
                          ชื่อแสดง
                          <input name="displayName" defaultValue={profile?.displayName ?? ""} className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 text-sm" />
                        </label>
                        <label className="text-xs font-medium text-gray-600">
                          ประเภทค่าจ้าง
                          <select name="payType" defaultValue={profile?.payType ?? "monthly"} className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 text-sm">
                            <option value="monthly">เงินเดือน</option>
                            <option value="daily">รายวัน</option>
                            <option value="hourly">รายชั่วโมง</option>
                          </select>
                        </label>
                        <label className="text-xs font-medium text-gray-600">
                          เงินเดือน (บาท)
                          <input name="monthlySalary" type="number" min={0} step="0.01" defaultValue={profile?.monthlySalary ?? 0} className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 text-sm" />
                        </label>
                        <label className="text-xs font-medium text-gray-600">
                          ค่าแรงรายวัน
                          <input name="dailyRate" type="number" min={0} step="0.01" defaultValue={profile?.dailyRate ?? 0} className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 text-sm" />
                        </label>
                        <label className="text-xs font-medium text-gray-600">
                          ค่าแรงรายชั่วโมง
                          <input name="hourlyRate" type="number" min={0} step="0.01" defaultValue={profile?.hourlyRate ?? 0} className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 text-sm" />
                        </label>
                        <label className="text-xs font-medium text-gray-600">
                          เวลาเข้างาน (HH:MM)
                          <input name="expectedStartTime" type="time" defaultValue={profile?.expectedStartTime?.slice(0, 5) ?? ""} className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 text-sm" />
                        </label>
                        <label className="text-xs font-medium text-gray-600">
                          ผ่อนผันสาย (นาที)
                          <input name="lateGraceMinutes" type="number" min={0} max={240} defaultValue={profile?.lateGraceMinutes ?? 0} className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 text-sm" />
                        </label>
                        <label className="text-xs font-medium text-gray-600">
                          ค่าปรับมาสาย/วัน
                          <input name="latePenaltyAmount" type="number" min={0} step="0.01" defaultValue={profile?.latePenaltyAmount ?? 0} className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 text-sm" />
                        </label>
                        <label className="text-xs font-medium text-gray-600">
                          ค่าปรับขาดงาน/วัน
                          <input name="absentPenaltyAmount" type="number" min={0} step="0.01" defaultValue={profile?.absentPenaltyAmount ?? 0} className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 text-sm" />
                        </label>
                        <div className="text-xs font-medium text-gray-600 lg:col-span-2">
                          วันทำงาน
                          <div className="mt-1 flex flex-wrap gap-1">
                            {WEEKDAY_LABELS.map((lbl, idx) => {
                              const checked = (profile?.workingDays ?? [1, 2, 3, 4, 5]).includes(idx);
                              return (
                                <label key={idx} className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-gray-300 px-2 py-1.5">
                                  <input type="checkbox" name="workingDays" value={idx} defaultChecked={checked} className="accent-orange-500" />
                                  <span>{lbl}</span>
                                </label>
                              );
                            })}
                          </div>
                        </div>
                        <label className="flex items-center gap-2 text-xs font-medium text-gray-600">
                          <input type="checkbox" name="otEligible" defaultChecked={profile?.otEligible ?? true} className="accent-orange-500" />
                          มีสิทธิ์ OT
                        </label>
                        <div className="flex items-end lg:col-span-3">
                          <button type="submit" disabled={isPending} className="btn-primary min-h-11 px-6 text-sm">
                            บันทึกค่าจ้าง
                          </button>
                        </div>
                      </form>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </section>
      ) : tab === "payroll" ? (
        <section className="space-y-4">
          {/* Period picker */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              applyPeriod(String(fd.get("dateFrom")), String(fd.get("dateTo")));
            }}
            className="flex flex-wrap items-end gap-3 rounded-lg border border-gray-200 bg-white p-3"
          >
            <label className="text-xs font-medium text-gray-600">
              ตั้งแต่
              <input name="dateFrom" type="date" defaultValue={dateFrom} className="mt-1 block min-h-11 rounded-lg border border-gray-300 px-3 text-sm" />
            </label>
            <label className="text-xs font-medium text-gray-600">
              ถึง
              <input name="dateTo" type="date" defaultValue={dateTo} className="mt-1 block min-h-11 rounded-lg border border-gray-300 px-3 text-sm" />
            </label>
            <button type="submit" className="btn-secondary min-h-11 px-4 text-sm">คำนวณ</button>
            <a
              href={`/payslip?mode=summary&dateFrom=${dateFrom}&dateTo=${dateTo}`}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-secondary min-h-11 px-4 text-sm"
            >
              ออก PDF สรุปทั้งงวด
            </a>
          </form>

          {/* Payroll table */}
          <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-left text-xs text-gray-500">
                  <th className="px-3 py-2 font-medium">พนักงาน</th>
                  <th className="px-3 py-2 font-medium">ประเภท</th>
                  <th className="px-3 py-2 font-medium text-right">วัน</th>
                  <th className="px-3 py-2 font-medium text-right">ชม.</th>
                  <th className="px-3 py-2 font-medium text-right">ฐาน</th>
                  <th className="px-3 py-2 font-medium text-right">OT</th>
                  <th className="px-3 py-2 font-medium text-right">สาย</th>
                  <th className="px-3 py-2 font-medium text-right">ขาด</th>
                  <th className="px-3 py-2 font-medium text-right">เพิ่ม</th>
                  <th className="px-3 py-2 font-medium text-right">หัก</th>
                  <th className="px-3 py-2 font-medium text-right">สุทธิ</th>
                  <th className="px-3 py-2 font-medium text-right">สลิป</th>
                </tr>
              </thead>
              <tbody>
                {payrollLines.length === 0 ? (
                  <tr>
                    <td colSpan={12} className="px-3 py-8 text-center text-gray-400">ไม่มีข้อมูลในช่วงนี้</td>
                  </tr>
                ) : (
                  payrollLines.map((l) => (
                    <tr key={l.userId} className="border-b border-gray-50 last:border-0">
                      <td className="px-3 py-2 text-gray-800">
                        {l.employeeName}
                        {!l.hasProfile && <span className="ml-1 text-xs text-amber-500">(ยังไม่ตั้งค่าจ้าง)</span>}
                      </td>
                      <td className="px-3 py-2 text-gray-500">{PAY_TYPE_LABEL[l.payType]}</td>
                      <td className="px-3 py-2 text-right text-gray-700">{l.totalDays}</td>
                      <td className="px-3 py-2 text-right text-gray-700">{l.totalHours}</td>
                      <td className="px-3 py-2 text-right text-gray-700">{fmt(l.basePay, currency)}</td>
                      <td className="px-3 py-2 text-right text-green-600">{l.otPay ? `+${fmt(l.otPay, currency)}` : "—"}<span className="block text-[10px] text-gray-400">{l.otHours ? `${l.otHours} ชม.` : ""}</span></td>
                      <td className="px-3 py-2 text-right text-red-600">{l.latePenalty ? `−${fmt(l.latePenalty, currency)}` : "—"}</td>
                      <td className="px-3 py-2 text-right text-red-600">{l.absentPenalty ? `−${fmt(l.absentPenalty, currency)}` : "—"}<span className="block text-[10px] text-gray-400">{l.absentDays ? `${l.absentDays} วัน` : ""}</span></td>
                      <td className="px-3 py-2 text-right text-green-600">{l.bonusTotal ? `+${fmt(l.bonusTotal, currency)}` : "—"}</td>
                      <td className="px-3 py-2 text-right text-red-600">{l.deductionTotal ? `−${fmt(l.deductionTotal, currency)}` : "—"}</td>
                      <td className="px-3 py-2 text-right font-bold text-gray-900">{fmt(l.netPay, currency)}</td>
                      <td className="px-3 py-2 text-right">
                        <a
                          href={`/payslip?userId=${l.userId}&dateFrom=${dateFrom}&dateTo=${dateTo}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-orange-600 hover:underline"
                        >
                          PDF
                        </a>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Add adjustment */}
          <div className="rounded-lg border border-gray-200 bg-white p-4">
            <h2 className="text-sm font-bold text-gray-900">เพิ่มรายการปรับ (โบนัส / หักโทษ / ขาด-ลา-สาย)</h2>
            <form
              action={(fd) => run(() => addAdjustmentAction(fd))}
              className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5"
            >
              <label className="text-xs font-medium text-gray-600 lg:col-span-2">
                พนักงาน
                <select
                  name="userId"
                  required
                  className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 text-sm"
                  onChange={(e) => {
                    const opt = e.target.selectedOptions[0];
                    const hidden = e.currentTarget.form?.elements.namedItem("employeeName") as HTMLInputElement | null;
                    if (hidden) hidden.value = opt?.dataset.name ?? "";
                  }}
                >
                  <option value="">— เลือก —</option>
                  {staff.map((m) => {
                    const name = profileByUser.get(m.userId)?.displayName || m.email;
                    return (
                      <option key={m.userId} value={m.userId} data-name={name}>
                        {name}
                      </option>
                    );
                  })}
                </select>
              </label>
              <input type="hidden" name="employeeName" />
              <label className="text-xs font-medium text-gray-600">
                ประเภท
                <select name="type" defaultValue="penalty" className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 text-sm">
                  {(Object.keys(ADJUSTMENT_LABEL) as Array<keyof typeof ADJUSTMENT_LABEL>).map((t) => (
                    <option key={t} value={t}>{ADJUSTMENT_LABEL[t]}</option>
                  ))}
                </select>
              </label>
              <label className="text-xs font-medium text-gray-600">
                วันที่
                <input name="date" type="date" defaultValue={today} className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 text-sm" />
              </label>
              <label className="text-xs font-medium text-gray-600">
                จำนวนเงิน
                <input name="amount" type="number" min={0} step="0.01" required className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 text-sm" />
              </label>
              <label className="text-xs font-medium text-gray-600 lg:col-span-4">
                หมายเหตุ
                <input name="note" maxLength={200} className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 text-sm" />
              </label>
              <div className="flex items-end">
                <button type="submit" disabled={isPending} className="btn-primary min-h-11 w-full text-sm">เพิ่ม</button>
              </div>
            </form>

            {adjustments.length > 0 && (
              <ul className="mt-4 divide-y divide-gray-100 border-t border-gray-100">
                {adjustments.map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <span className="min-w-0 truncate text-gray-700">
                      <span className="text-gray-400">{a.date}</span> · {a.employeeName} ·{" "}
                      <span className={DEDUCTION_TYPES.includes(a.type) ? "text-red-600" : "text-green-600"}>
                        {ADJUSTMENT_LABEL[a.type]} {DEDUCTION_TYPES.includes(a.type) ? "−" : "+"}
                        {fmt(a.amount, currency)}
                      </span>
                      {a.note ? ` · ${a.note}` : ""}
                    </span>
                    <button
                      onClick={() => run(() => deleteAdjustmentAction(a.id))}
                      disabled={isPending}
                      className="shrink-0 text-xs text-red-500 hover:underline"
                    >
                      ลบ
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      ) : (
        <section className="space-y-4">
          <div className="rounded-lg border border-gray-200 bg-white p-4">
            <h2 className="text-sm font-bold text-gray-900">นโยบายค่าจ้าง / บทลงโทษ (ทั้งร้าน)</h2>
            <p className="text-xs text-gray-500">ใช้คำนวณ OT มาสาย และขาดงานในแท็บเงินเดือนโดยอัตโนมัติ</p>
            <form
              action={(fd) => run(() => saveHrSettingsAction(fd))}
              className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
            >
              <label className="text-xs font-medium text-gray-600">
                ชั่วโมงทำงานปกติ/วัน
                <input name="regularHoursPerDay" type="number" min={1} max={24} step="0.5" defaultValue={hrSettings.regularHoursPerDay} className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 text-sm" />
              </label>
              <label className="text-xs font-medium text-gray-600">
                ตัวคูณ OT (เช่น 1.5)
                <input name="otMultiplier" type="number" min={1} max={5} step="0.1" defaultValue={hrSettings.otMultiplier} className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 text-sm" />
              </label>
              <label className="text-xs font-medium text-gray-600">
                OT สูงสุด/วัน (ชม.)
                <input name="otDailyCapHours" type="number" min={0} max={12} step="0.5" defaultValue={hrSettings.otDailyCapHours} className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 text-sm" />
              </label>
              <label className="text-xs font-medium text-gray-600">
                ค่าปรับมาสาย/นาที
                <input name="latePenaltyPerMinute" type="number" min={0} step="0.01" defaultValue={hrSettings.latePenaltyPerMinute} className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 text-sm" />
              </label>
              <label className="text-xs font-medium text-gray-600">
                ค่าปรับมาสายสูงสุด/วัน
                <input name="latePenaltyMaxPerDay" type="number" min={0} step="0.01" defaultValue={hrSettings.latePenaltyMaxPerDay} className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 text-sm" />
              </label>
              <label className="text-xs font-medium text-gray-600">
                ค่าปรับขาดงาน/วัน
                <input name="absentPenaltyPerDay" type="number" min={0} step="0.01" defaultValue={hrSettings.absentPenaltyPerDay} className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 text-sm" />
              </label>
              <label className="text-xs font-medium text-gray-600">
                สิทธิลงเวลาย้อนหลัง/เดือน
                <input name="backdatedRightsPerMonth" type="number" min={0} max={31} step="1" defaultValue={hrSettings.backdatedRightsPerMonth} className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 text-sm" />
              </label>
              <div className="flex items-end lg:col-span-3">
                <button type="submit" disabled={isPending} className="btn-primary min-h-11 px-6 text-sm">บันทึกนโยบาย</button>
              </div>
            </form>
          </div>
        </section>
      )}
    </div>
  );
}
