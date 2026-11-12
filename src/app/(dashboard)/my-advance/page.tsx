/**
 * เบิกเงินของฉัน (B2) — เห็นค่าแรงจากวันที่มาแล้ว ยอดเบิกได้อีก ส่งคำขอ และประวัติ
 */
import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { getAdvanceAvailability } from "@/modules/hr/advanced/salary-advance-service";
import { MyAdvanceView } from "./MyAdvanceView";

export const dynamic = "force-dynamic";

export default async function MyAdvancePage() {
  const { user, ctx, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("attendance.clock")) redirect("/dashboard");

  const av = await getAdvanceAvailability({ organizationId: ctx.organizationId, storeId: ctx.storeId, userId: user.id });
  if (!av.enabled) {
    return (
      <div className="page-shell">
        <h1 className="text-xl font-bold text-[var(--ink)]">เบิกเงิน</h1>
        <p className="mt-3 rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-600">ร้านนี้ยังไม่เปิดให้เบิกเงินผ่านระบบ — ติดต่อผู้จัดการ</p>
      </div>
    );
  }
  return (
    <MyAdvanceView
      cycle={av.cycle}
      today={av.today}
      hasProfile={av.hasProfile}
      workedDays={av.workedDays}
      earned={av.earned}
      weeklyPaidInCycle={av.weeklyPaidInCycle}
      available={av.cap.available}
      cashMax={av.cashMax}
      cashSessionOpen={av.cashSessionOpen}
      blockedReason={av.cap.blockedReason}
      advances={av.advances.map((a) => ({
        id: a.id,
        status: a.status,
        requestedAmount: a.requestedAmount,
        approvedAmount: a.approvedAmount,
        reason: a.reason,
        decisionNote: a.decisionNote,
        payMethod: a.payMethod,
        paidDate: a.paidDate,
        createdAt: a.createdAt,
        deducted: a.deducted,
      }))}
    />
  );
}
