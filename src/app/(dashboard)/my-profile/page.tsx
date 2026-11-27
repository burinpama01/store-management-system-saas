/**
 * ข้อมูลของฉัน — พนักงานกรอกข้อมูลตัวเอง ยกเว้นช่องที่เจ้าของ/ผู้จัดการตั้งไว้แล้ว
 * อ่านผ่าน RLS (แถวตัวเอง) — เลขบัญชีเต็มไม่ส่งไป browser
 */
import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { listEmployeeProfiles } from "@/modules/hr/repository";
import { maskBankAccount } from "@/modules/hr/employee-identity";
import { lockedFields } from "@/modules/hr/self-info";
import { getMyLatestSelfInfoRequest, getMySelfInfo } from "@/modules/hr/self-info-repository";
import { getStoreLocalDate } from "@/modules/attendance/date";
import { MyProfileForm, type MyProfileView } from "./MyProfileForm";

export const dynamic = "force-dynamic";

export default async function MyProfilePage() {
  const { user, ctx, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("attendance.clock")) redirect("/dashboard");

  const [profiles, self, request] = await Promise.all([
    listEmployeeProfiles(ctx.storeId),
    getMySelfInfo(ctx.storeId, user.id),
    getMyLatestSelfInfoRequest(ctx.storeId, user.id),
  ]);
  const own = profiles.data?.find((p) => p.userId === user.id);
  const locked = lockedFields(own);
  const mine = self.data;

  // ช่องที่ล็อกแสดงค่าของเจ้าของ (อ่านอย่างเดียว) · ช่องอื่นแสดงค่าที่พนักงานกรอกไว้
  const view: MyProfileView = {
    locked: [...locked],
    fullName: (locked.has("fullName") ? own?.fullName : mine?.fullName) ?? "",
    bankName: (locked.has("bankName") ? own?.bankName : mine?.bankName) ?? "",
    bankAccountMasked: maskBankAccount(locked.has("bankAccountNo") ? own?.bankAccountNo : mine?.bankAccountNo),
    bankAccountName: (locked.has("bankAccountName") ? own?.bankAccountName : mine?.bankAccountName) ?? "",
    nickname: mine?.nickname ?? "",
    phone: mine?.phone ?? "",
    birthDate: mine?.birthDate ?? "",
    address: mine?.address ?? "",
    emergencyContactName: mine?.emergencyContactName ?? "",
    emergencyContactPhone: mine?.emergencyContactPhone ?? "",
    employeeCode: own?.employeeCode ?? "",
    position: own?.position ?? "",
  };

  return (
    <section className="page-shell max-w-3xl space-y-4">
      <div>
        <h1 className="text-xl font-bold text-[var(--ink)]">ข้อมูลของฉัน</h1>
        <p className="mt-1 text-sm text-gray-600">
          กรอกครั้งแรกบันทึกได้ทันที · ช่องที่กรอกแล้วถ้าแก้อีกต้องรอผู้จัดการอนุมัติ · ช่องที่มีป้าย “เจ้าของร้านตั้งไว้” แก้ได้ที่ผู้จัดการเท่านั้น
        </p>
        {self.error && <p className="mt-2 text-sm text-red-600">โหลดข้อมูลไม่สำเร็จ: {self.error}</p>}
      </div>
      <MyProfileForm view={view} today={getStoreLocalDate(ctx.storeTimezone)} request={request} />
    </section>
  );
}
