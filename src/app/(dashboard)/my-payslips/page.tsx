/**
 * สลิปของฉัน (แผนสลิป v4 · P6 — R17, R23, R27, R32, R33)
 * พนักงานทุกตำแหน่งเห็นสลิปของตัวเอง เฉพาะงวดที่ปิดแล้ว ตั้งแต่วันจ่าย · ลาออกแล้วดูเองไม่ได้
 * การอ่านผ่าน RLS (payslips: own visible current read) — ไม่ใช้ service client
 */
import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { getAdvancedPayrollAccess } from "@/modules/hr/advanced/store-payroll";
import { listMyVisiblePayslips } from "@/modules/hr/advanced/repository";
import type { PayslipSnapshotData } from "@/modules/hr/advanced/close-period";
import { listEmployeeProfiles } from "@/modules/hr/repository";
import { getStoreLocalDate } from "@/modules/attendance/date";
import { logSystemEvent } from "@/modules/system/event-log";
import { PayslipCard, money } from "@/app/payslip/PayslipCard";
import { PrintButton } from "@/app/payslip/PrintButton";
import { SaveImageButton } from "@/app/payslip/SaveImageButton";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function MyPayslipsPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const { user, ctx, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("attendance.clock")) redirect("/dashboard");

  const access = await getAdvancedPayrollAccess(ctx.organizationId, ctx.storeId);
  if (!access.settings.switches.myPayslip) {
    return (
      <div className="page-shell">
        <h1 className="text-xl font-bold text-[var(--ink)]">สลิปของฉัน</h1>
        <p className="mt-3 rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-600">
          ร้านนี้ยังไม่เปิดให้พนักงานดูสลิปเอง — ขอสลิปจากผู้จัดการได้
        </p>
      </div>
    );
  }

  const today = getStoreLocalDate(ctx.storeTimezone);
  const own = (await listEmployeeProfiles(ctx.storeId)).data?.find((p) => p.userId === user.id);
  if (own?.employmentEndDate && own.employmentEndDate < today) {
    return (
      <div className="page-shell">
        <h1 className="text-xl font-bold text-[var(--ink)]">สลิปของฉัน</h1>
        <p className="mt-3 rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-600">
          คุณออกงานแล้วเมื่อ {own.employmentEndDate} — ขอสลิปย้อนหลังได้ที่ผู้จัดการหรือเจ้าของร้าน
        </p>
      </div>
    );
  }

  const slips = await listMyVisiblePayslips(ctx.storeId);
  const params = await searchParams;
  const selectedId = params.slip && UUID_RE.test(params.slip) ? params.slip : null;
  const selected = selectedId ? slips.find((s) => s.id === selectedId) : null;

  if (selected) {
    const data = selected.data as PayslipSnapshotData;
    await logSystemEvent({
      level: "info",
      source: "hr.my-payslip",
      action: "viewPayslip",
      message: "พนักงานเปิดดูสลิปของตัวเอง",
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      actorUserId: user.id,
      context: { payslipId: selected.id, docNo: selected.docNo, revision: selected.revision },
    });
    return (
      <main className="mx-auto max-w-3xl bg-white p-4 text-gray-900 sm:p-6">
        <style>{`@media print { @page { margin: 12mm; } body { background: white; } }`}</style>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 print:hidden">
          <a href="/my-payslips" className="btn-secondary inline-flex min-h-11 items-center px-4 text-sm">← สลิปทั้งหมด</a>
          <div className="flex flex-wrap gap-2">
            <PrintButton />
            <SaveImageButton fileName={`payslip_${data.period.start}_${data.period.end}.png`} />
          </div>
        </div>
        <div id="payslip-image-content" className="bg-white">
          <PayslipCard
            line={data.line}
            currency={data.currency}
            issuer={data.issuer}
            employee={data.employee}
            dateFrom={data.period.start}
            dateTo={data.period.end}
            payDate={data.period.payDate}
            timeZone={data.timezone}
            otMultiplier={data.otMultiplier}
            docNo={selected.docNo}
            revision={selected.revision}
            issuedAt={selected.createdAt}
          />
        </div>
      </main>
    );
  }

  return (
    <div className="page-shell space-y-4">
      <div>
        <h1 className="text-xl font-bold text-[var(--ink)]">สลิปของฉัน</h1>
        <p className="text-sm text-[var(--muted)]">เฉพาะงวดที่ปิดแล้ว · เปิดให้ดูตั้งแต่วันจ่ายเงิน</p>
      </div>
      {slips.length === 0 ? (
        <p className="rounded-lg border border-dashed border-gray-300 bg-white p-6 text-center text-sm text-gray-400">
          ยังไม่มีสลิปที่ถึงวันจ่าย
        </p>
      ) : (
        <ul className="space-y-2">
          {slips.map((s) => {
            const data = s.data as PayslipSnapshotData;
            return (
              <li key={s.id}>
                <a
                  href={`/my-payslips?slip=${s.id}`}
                  className="flex min-h-14 items-center justify-between gap-3 rounded-lg border border-gray-200 bg-white px-4 py-3 hover:border-orange-300"
                >
                  <span>
                    <span className="block font-semibold text-gray-900">
                      งวด {data.period.start} – {data.period.end}
                    </span>
                    <span className="block text-xs text-gray-500">
                      จ่าย {data.period.payDate} · เลขที่ {s.docNo}
                      {s.revision > 1 ? ` · แก้ไขครั้งที่ ${s.revision}` : ""}
                    </span>
                  </span>
                  <span className="text-right font-bold tabular-nums text-gray-900">{money(s.netPay, data.currency)}</span>
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
