"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { MemberWithEmail } from "@/modules/settings/repository";
import type { EmployeeProfile, PayrollAdjustment, StoreHrSettings } from "@/modules/hr/types";
import {
  PAY_TYPE_LABEL,
  ADJUSTMENT_LABEL,
  DEDUCTION_TYPES,
  WEEKDAY_LABELS,
  EMPLOYMENT_TYPES,
  EMPLOYMENT_TYPE_LABEL,
} from "@/modules/hr/types";
import { defaultEmploymentType, seniorityLabel } from "@/modules/hr/employee-identity";
import type { PayrollLine } from "@/modules/hr/payroll";
import type { Role } from "@/modules/tenants/types";
import {
  saveEmployeeProfileAction,
  addStaffMemberAction,
  addAdjustmentAction,
  deleteAdjustmentAction,
  saveHrSettingsAction,
  savePayslipIdentityAction,
} from "./actions";
import { Button } from "@/shared/components/ui";
import type { AdvancedPayrollSettings } from "@/modules/hr/advanced/settings";
import type { PayrollPeriodRow, StoreSkill } from "@/modules/hr/advanced/repository";
import type { PayPeriod } from "@/modules/hr/advanced/pay-cycle";
import type { AdvancedPayrollLine } from "@/modules/hr/advanced/compute";
import { AdvancedPayrollPanel } from "./AdvancedPayrollPanel";
import { PayrollPeriodsPanel } from "./PayrollPeriodsPanel";

export interface StaffAdvancedProps {
  entitled: boolean;
  /** สวิตช์ที่มีผลจริง (แพ็กไม่มีสิทธิ์ = ปิดหมด) */
  settings: AdvancedPayrollSettings;
  /** ค่าที่ร้านตั้งไว้ (แสดงในฟอร์มตั้งค่า) */
  stored: AdvancedPayrollSettings;
  skills: StoreSkill[];
  /** ทักษะที่พนักงานมีตอนนี้ (ยังไม่ถูกถอน) */
  employeeSkillIds: Record<string, string[]>;
  periods: PayPeriod[];
  closedRows: PayrollPeriodRow[];
  businessToday: string;
}

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
  advanced: StaffAdvancedProps;
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
  advanced,
}: Props) {
  const asw = advanced.settings.switches;
  const advLines = payrollLines as AdvancedPayrollLine[];
  const router = useRouter();
  const [tab, setTab] = useState<"employees" | "payroll" | "policy" | "features">("employees");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [showAddStaff, setShowAddStaff] = useState(false);
  const [isPending, startTransition] = useTransition();

  const profileByUser = new Map(profiles.map((p) => [p.userId, p]));
  // Members scoped to actual employees (exclude platform super_admin rows).
  const staff = members.filter((m) => m.role !== "super_admin");

  function run(action: () => Promise<{ error: string | null }>, onOk?: () => void) {
    setError(null);
    setNotice(null);
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

  const payslipQuery = `dateFrom=${dateFrom}&dateTo=${dateTo}`;

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
        <button
          onClick={() => setTab("features")}
          className={`min-h-11 rounded-lg px-4 text-sm font-semibold ${tab === "features" ? "bg-[var(--tenant-primary)] text-white" : "bg-[var(--surface-muted)] text-[var(--ink-2)]"}`}
        >
          ฟีเจอร์เงินเดือน{advanced.entitled ? "" : " 🔒"}
        </button>
      </div>

      {error && <p className="rounded-lg bg-red-50 px-4 py-2 text-sm text-red-600">{error}</p>}
      {notice && <p className="rounded-lg bg-green-50 px-4 py-2 text-sm text-green-700" aria-live="polite">{notice}</p>}

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
                    <Button type="submit" variant="primary" loading={isPending} className="min-h-11 w-full text-sm">
                      เพิ่มพนักงาน
                    </Button>
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
                        {profile && (profile.employeeCode || profile.position || profile.seniorityStartDate) && (
                          <p className="text-xs text-gray-500 truncate">
                            {[
                              profile.employeeCode,
                              profile.position,
                              EMPLOYMENT_TYPE_LABEL[profile.employmentType],
                              seniorityLabel(profile.seniorityStartDate, today)
                                ? `อายุงาน ${seniorityLabel(profile.seniorityStartDate, today)}`
                                : "",
                              profile.employmentEndDate ? `ออกงาน ${profile.employmentEndDate}` : "",
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </p>
                        )}
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
                        {isEditing ? "ปิด" : profile ? "แก้ไขข้อมูล" : "ตั้งค่าจ้าง"}
                      </button>
                    </div>

                    {isEditing && (
                      <form
                        action={(fd) => run(() => saveEmployeeProfileAction(fd), () => setEditingUserId(null))}
                        className="mt-4 grid gap-3 border-t border-gray-100 pt-4 sm:grid-cols-2 lg:grid-cols-3"
                      >
                        <input type="hidden" name="userId" value={m.userId} />
                        <p className="text-xs font-bold text-gray-800 sm:col-span-2 lg:col-span-3">ข้อมูลพนักงาน (แสดงบนสลิป)</p>
                        <label className="text-xs font-medium text-gray-600">
                          รหัสพนักงาน
                          <input name="employeeCode" maxLength={30} defaultValue={profile?.employeeCode ?? ""} placeholder="เช่น EMP-001" className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 text-sm" />
                        </label>
                        <label className="text-xs font-medium text-gray-600">
                          ชื่อ-สกุลจริง
                          <input name="fullName" maxLength={150} defaultValue={profile?.fullName ?? ""} className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 text-sm" />
                        </label>
                        <label className="text-xs font-medium text-gray-600">
                          ตำแหน่ง
                          <input name="position" maxLength={80} defaultValue={profile?.position ?? ""} placeholder="เช่น พนักงานเสิร์ฟ" className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 text-sm" />
                        </label>
                        <label className="text-xs font-medium text-gray-600">
                          ประเภทการจ้าง
                          <select
                            name="employmentType"
                            defaultValue={profile?.employmentType ?? defaultEmploymentType(profile?.payType ?? "monthly")}
                            className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 text-sm"
                          >
                            {EMPLOYMENT_TYPES.map((t) => (
                              <option key={t} value={t}>{EMPLOYMENT_TYPE_LABEL[t]}</option>
                            ))}
                          </select>
                          <span className="mt-1 block text-[11px] font-normal text-gray-400">
                            ค่าทักษะ/ค่าอายุงาน/โบนัสยอดขาย ให้เฉพาะพนักงานประจำ (เริ่มงวดถัดไปหลังปรับ)
                          </span>
                        </label>
                        <label className="text-xs font-medium text-gray-600">
                          เป็นพนักงานประจำตั้งแต่
                          <input name="permanentSince" type="date" max={today} defaultValue={profile?.permanentSince ?? ""} className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 text-sm" />
                          <span className="mt-1 block text-[11px] font-normal text-gray-400">ว่าง + เลือกประจำ = วันนี้</span>
                        </label>
                        <label className="text-xs font-medium text-gray-600">
                          วันเริ่มงาน (นับอายุงาน)
                          <input name="seniorityStartDate" type="date" max={today} defaultValue={profile?.seniorityStartDate ?? ""} className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 text-sm" />
                          <span className="mt-1 block text-[11px] font-normal text-gray-400">
                            ระบบตั้งให้จากวันแรกที่ลงเวลา · แก้ย้อนหลังได้สำหรับพนักงานเดิม
                          </span>
                        </label>
                        <label className="text-xs font-medium text-gray-600">
                          วันออกงาน
                          <input name="employmentEndDate" type="date" defaultValue={profile?.employmentEndDate ?? ""} className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 text-sm" />
                          <span className="mt-1 block text-[11px] font-normal text-gray-400">ว่าง = ยังทำงานอยู่</span>
                        </label>
                        <p className="mt-2 text-xs font-bold text-gray-800 sm:col-span-2 lg:col-span-3">
                          บัญชีรับเงินเดือน
                          {profile?.bankAccountMasked ? (
                            <span className="ml-2 font-normal text-gray-400">
                              ปัจจุบัน {profile.bankName ?? ""} {profile.bankAccountMasked}
                            </span>
                          ) : null}
                        </p>
                        <label className="text-xs font-medium text-gray-600">
                          ธนาคาร
                          <input name="bankName" maxLength={80} defaultValue={profile?.bankName ?? ""} placeholder="เช่น กสิกรไทย" className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 text-sm" />
                        </label>
                        <label className="text-xs font-medium text-gray-600">
                          เลขบัญชี
                          <input
                            name="bankAccountNo"
                            inputMode="numeric"
                            autoComplete="off"
                            maxLength={24}
                            placeholder={profile?.bankAccountMasked ? `${profile.bankAccountMasked} (เว้นว่าง = ไม่เปลี่ยน)` : ""}
                            className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 text-sm"
                          />
                          {profile?.bankAccountMasked && (
                            <span className="mt-1 flex items-center gap-1 text-[11px] font-normal text-gray-500">
                              <input type="checkbox" name="clearBankAccount" className="accent-orange-500" />
                              ลบเลขบัญชีนี้
                            </span>
                          )}
                        </label>
                        <label className="text-xs font-medium text-gray-600">
                          ชื่อบัญชี
                          <input name="bankAccountName" maxLength={150} defaultValue={profile?.bankAccountName ?? ""} className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 text-sm" />
                        </label>
                        <p className="mt-2 text-xs font-bold text-gray-800 sm:col-span-2 lg:col-span-3">ค่าจ้างและเวลาทำงาน</p>
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
                          <span className="ml-1 font-normal text-gray-400">
                            (วันที่ไม่ติ๊ก = วันหยุดประจำของพนักงานคนนี้ ไม่ถูกนับเป็นขาดงาน)
                          </span>
                          <div className="mt-1 flex flex-wrap gap-1">
                            {WEEKDAY_LABELS.map((lbl, idx) => {
                              // ร้านที่เปิดทุกวันตั้งวันหยุดประจำรายคนได้ — ค่าเริ่มต้นจึงยึดวันเปิดร้าน
                              // ไม่ใช่ จ-ศ แล้วให้ผู้จัดการติ๊กวันหยุดของพนักงานคนนั้นออกเอง
                              const fallback = hrSettings.workingDays?.length ? hrSettings.workingDays : [1, 2, 3, 4, 5];
                              const checked = (profile?.workingDays?.length ? profile.workingDays : fallback).includes(idx);
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
                        {advanced.entitled && (
                          <label className="text-xs font-medium text-gray-600">
                            ถ้าเปลี่ยนค่าจ้าง: มีผลตั้งแต่
                            <input name="rateEffectiveFrom" type="date" defaultValue={today} className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 text-sm" />
                            <span className="mt-1 block text-[11px] font-normal text-gray-400">
                              งวดก่อนวันนี้ใช้ค่าจ้างเดิม · กลางงวดคิดตามจำนวนวันจริง
                            </span>
                          </label>
                        )}
                        {asw.skillPay && (
                          <div className="text-xs font-medium text-gray-600 sm:col-span-2 lg:col-span-3">
                            <input type="hidden" name="skillsSubmitted" value="1" />
                            ทักษะที่ทำได้
                            <span className="ml-1 font-normal text-gray-400">(ได้/ถอนวันนี้ มีผลงวดถัดไป · ค่าทักษะเฉพาะพนักงานประจำ)</span>
                            <div className="mt-1 flex flex-wrap gap-1">
                              {advanced.skills.length === 0 && (
                                <span className="text-gray-400">ยังไม่มีรายการทักษะ — เพิ่มที่แท็บฟีเจอร์เงินเดือน</span>
                              )}
                              {advanced.skills.map((sk) => (
                                <label key={sk.id} className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-gray-300 px-2 py-1.5">
                                  <input
                                    type="checkbox"
                                    name="skillIds"
                                    value={sk.id}
                                    defaultChecked={(advanced.employeeSkillIds[m.userId] ?? []).includes(sk.id)}
                                    className="accent-orange-500"
                                  />
                                  <span>{sk.name}</span>
                                </label>
                              ))}
                            </div>
                          </div>
                        )}
                        {asw.socialSecurity && (
                          <label className="flex items-center gap-2 text-xs font-medium text-gray-600">
                            <input type="checkbox" name="ssoEnabled" defaultChecked={profile?.ssoEnabled ?? true} className="accent-orange-500" />
                            หักประกันสังคม
                          </label>
                        )}
                        {asw.withholdingTax && advanced.settings.whtMode === "percent" && (
                          <label className="text-xs font-medium text-gray-600">
                            ภาษีหัก ณ ที่จ่าย (%)
                            <input name="withholdingTaxRate" type="number" min={0} max={35} step="0.01" defaultValue={profile?.withholdingTaxRate ?? 0} className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 text-sm" />
                          </label>
                        )}
                        <div className="flex items-end lg:col-span-3">
                          <Button type="submit" variant="primary" loading={isPending} className="min-h-11 px-6 text-sm">
                            บันทึกข้อมูลพนักงาน
                          </Button>
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
          {asw.payCycle && (
            <PayrollPeriodsPanel
              periods={advanced.periods}
              closedRows={advanced.closedRows}
              businessToday={advanced.businessToday}
              dateFrom={dateFrom}
              dateTo={dateTo}
              currency={currency}
            />
          )}
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
              href={`/payslip?mode=summary&${payslipQuery}`}
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
                  <th className="px-3 py-2 font-medium text-right">ครึ่งวัน</th>
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
                    <td colSpan={13} className="px-3 py-8 text-center text-gray-400">ไม่มีข้อมูลในช่วงนี้</td>
                  </tr>
                ) : (
                  advLines.map((l) => (
                    <tr key={l.userId} className="border-b border-gray-50 last:border-0">
                      <td className="px-3 py-2 text-gray-800">
                        {l.employeeName}
                        {!l.hasProfile && <span className="ml-1 text-xs text-amber-500">(ยังไม่ตั้งค่าจ้าง)</span>}
                      </td>
                      <td className="px-3 py-2 text-gray-500">{PAY_TYPE_LABEL[l.payType]}</td>
                      <td className="px-3 py-2 text-right text-gray-700">
                        {l.totalDays}
                        {l.halfDays > 0 || l.unpaidHolidayDays > 0 ? (
                          <span className="block text-[10px] text-gray-400">
                            {l.halfDays > 0 ? `จ่าย ${l.payableDays} วัน` : ""}
                            {l.unpaidHolidayDays > 0 ? ` · วันหยุดไม่คิดเงิน ${l.unpaidHolidayDays}` : ""}
                          </span>
                        ) : null}
                      </td>
                      <td className="px-3 py-2 text-right text-gray-700">{l.totalHours}</td>
                      <td className="px-3 py-2 text-right text-gray-700">{fmt(l.basePay, currency)}</td>
                      <td className="px-3 py-2 text-right text-green-600">{l.otPay ? `+${fmt(l.otPay, currency)}` : "—"}<span className="block text-[10px] text-gray-400">{l.otHours ? `${l.otHours} ชม.` : ""}</span></td>
                      <td className="px-3 py-2 text-right text-red-600">{l.latePenalty ? `−${fmt(l.latePenalty, currency)}` : "—"}</td>
                      <td className="px-3 py-2 text-right text-yellow-700">
                        {l.halfDayDeduction ? `−${fmt(l.halfDayDeduction, currency)}` : l.halfDays ? "จ่ายครึ่ง" : "—"}
                        <span className="block text-[10px] text-gray-400">{l.halfDayDeduction ? `${l.halfDayDeductionDays} วัน` : l.halfDays ? `${l.halfDays} วัน` : ""}</span>
                      </td>
                      <td className="px-3 py-2 text-right text-red-600">{l.absentPenalty ? `−${fmt(l.absentPenalty, currency)}` : "—"}<span className="block text-[10px] text-gray-400">{l.absentDays ? `${l.absentDays} วัน` : ""}</span></td>
                      <td className="px-3 py-2 text-right text-green-600">
                        {(() => {
                          const extra = l.bonusTotal + (l.skillPay ?? 0) + (l.seniorityPay ?? 0) + (l.salesBonus ?? 0);
                          return extra ? `+${fmt(extra, currency)}` : "—";
                        })()}
                        <span className="block text-[10px] text-gray-400">
                          {[
                            l.skillPay ? `ทักษะ ${l.skillPay}` : "",
                            l.seniorityPay ? `อายุงาน ${l.seniorityPay}` : "",
                            l.salesBonus ? `ยอดขาย ${l.salesBonus}` : "",
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right text-red-600">
                        {(() => {
                          const ded = l.deductionTotal + (l.socialSecurity ?? 0) + (l.withholdingTax ?? 0);
                          return ded ? `−${fmt(ded, currency)}` : "—";
                        })()}
                        <span className="block text-[10px] text-gray-400">
                          {[l.socialSecurity ? `ปกส. ${l.socialSecurity}` : "", l.withholdingTax ? `ภาษี ${l.withholdingTax}` : ""].filter(Boolean).join(" · ")}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right font-bold text-gray-900">{fmt(l.netPay, currency)}</td>
                      <td className="px-3 py-2 text-right">
                        <a
                          href={`/payslip?userId=${l.userId}&${payslipQuery}`}
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
                  {(Object.keys(ADJUSTMENT_LABEL) as Array<keyof typeof ADJUSTMENT_LABEL>)
                    .filter((t) => t !== "withholding_tax" || (asw.withholdingTax && advanced.settings.whtMode === "manual"))
                    .map((t) => (
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
                <Button type="submit" variant="primary" loading={isPending} className="min-h-11 w-full text-sm">เพิ่ม</Button>
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
                    <Button
                      onClick={() => run(() => deleteAdjustmentAction(a.id))}
                      loading={isPending}
                      className="shrink-0 text-xs text-red-500 hover:underline"
                    >
                      ลบ
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      ) : tab === "features" ? (
        <AdvancedPayrollPanel entitled={advanced.entitled} settings={advanced.stored} skills={advanced.skills} />
      ) : (
        <section className="space-y-4">
          <div className="rounded-lg border border-gray-200 bg-white p-4">
            <h2 className="text-sm font-bold text-gray-900">นโยบายค่าจ้าง / บทลงโทษ (ทั้งร้าน)</h2>
            <p className="text-xs text-gray-500">ใช้คำนวณ OT มาสาย และขาดงานในแท็บเงินเดือนโดยอัตโนมัติ</p>
            <form
              action={(fd) => run(() => saveHrSettingsAction(fd), () => setNotice("บันทึกนโยบายเรียบร้อยแล้ว"))}
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
                ค่าปรับขาดงาน/วัน (รายเดือนใช้เงินเดือน ÷ จำนวนวัน)
                <input name="absentPenaltyPerDay" type="number" min={0} step="0.01" defaultValue={hrSettings.absentPenaltyPerDay} className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 text-sm" />
              </label>
              <label className="text-xs font-medium text-gray-600">
                ทำงานครึ่งวันไม่เกิน (ชม.) — จ่ายครึ่งเดียว
                <input name="halfDayMaxHours" type="number" min={0} max={24} step="0.5" defaultValue={hrSettings.halfDayMaxHours} className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 text-sm" />
                <span className="mt-1 block text-[11px] font-normal text-gray-400">
                  วันที่ทำงานจริงไม่เกินค่านี้จะนับเป็นครึ่งวัน · 0 = ปิด (ค่าเริ่มต้น — นับเต็มวันทุกวันที่มาทำงาน)
                </span>
              </label>
              <label className="text-xs font-medium text-gray-600">
                สิทธิลงเวลาย้อนหลัง/เดือน
                <input name="backdatedRightsPerMonth" type="number" min={0} max={31} step="1" defaultValue={hrSettings.backdatedRightsPerMonth} className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 text-sm" />
              </label>
              <div className="flex items-end lg:col-span-3">
                <Button type="submit" variant="primary" loading={isPending} loadingText="กำลังบันทึก..." className="min-h-11 px-6 text-sm">บันทึกนโยบาย</Button>
              </div>
            </form>
          </div>
          <div className="rounded-lg border border-gray-200 bg-white p-4">
            <h2 className="text-sm font-bold text-gray-900">ข้อมูลบริษัท/ร้านบนสลิปเงินเดือน</h2>
            <p className="text-xs text-gray-500">เว้นว่าง = ใช้ชื่อร้าน ที่อยู่ และเลขผู้เสียภาษีจากตั้งค่าใบเสร็จ</p>
            <form
              action={(fd) => run(() => savePayslipIdentityAction(fd), () => setNotice("บันทึกข้อมูลบนสลิปเรียบร้อยแล้ว"))}
              className="mt-4 grid gap-3 sm:grid-cols-2"
            >
              <label className="text-xs font-medium text-gray-600">
                ชื่อนิติบุคคล / ชื่อบนสลิป
                <input name="payslipLegalName" maxLength={200} defaultValue={hrSettings.payslipLegalName ?? ""} placeholder="เช่น บริษัท ตัวอย่าง จำกัด" className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 text-sm" />
              </label>
              <label className="text-xs font-medium text-gray-600">
                เลขประจำตัวผู้เสียภาษี (13 หลัก)
                <input name="payslipTaxId" inputMode="numeric" maxLength={17} defaultValue={hrSettings.payslipTaxId ?? ""} className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 text-sm" />
              </label>
              <label className="text-xs font-medium text-gray-600 sm:col-span-2">
                ที่อยู่
                <input name="payslipAddress" maxLength={400} defaultValue={hrSettings.payslipAddress ?? ""} className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 text-sm" />
              </label>
              <div className="flex items-end sm:col-span-2">
                <Button type="submit" variant="primary" loading={isPending} loadingText="กำลังบันทึก..." className="min-h-11 px-6 text-sm">บันทึกข้อมูลบนสลิป</Button>
              </div>
            </form>
          </div>
        </section>
      )}
    </div>
  );
}
