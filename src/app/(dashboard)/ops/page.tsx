import Link from "next/link";
import { getStoreLocalDate } from "@/modules/attendance/date";
import { formatShiftDate, formatStoreTime, getStoreLocalTime } from "@/modules/operations/format";
import { listChecklistRuns, listChecklistTemplates } from "@/modules/operations/repository";
import { computeAreaReadiness, isChecklistOverdue, templateAppliesOn } from "@/modules/operations/rules";
import { CHECKLIST_PHASE_LABELS, READINESS_LABELS } from "@/modules/operations/types";
import { loadOpsPageContext, READINESS_TONE } from "./shared";
import { StartRunButton } from "./StartRunButton";

export const dynamic = "force-dynamic";


export default async function OpsTodayPage() {
  const { user, ctx, enabled, isManager } = await loadOpsPageContext();

  if (!enabled) {
    return (
      <section className="page-shell max-w-3xl">
        <div className="page-header">
          <div>
            <h1 className="page-title">งานหน้าร้าน</h1>
            <p className="page-kicker">เช็กลิสต์เปิด-ปิดร้านของครัวและบาร์</p>
          </div>
        </div>
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900">
          สาขานี้ยังไม่ได้เปิดระบบงานหน้าร้าน
          {isManager && (
            <p className="mt-3">
              <Link className="btn-primary" href="/ops/templates">ตั้งค่าเช็กลิสต์และเปิดใช้</Link>
            </p>
          )}
        </div>
      </section>
    );
  }

  const now = new Date();
  const today = getStoreLocalDate(ctx.storeTimezone, now);
  const nowLocal = { date: today, time: getStoreLocalTime(ctx.storeTimezone, now) };
  const [templatesRes, runsRes] = await Promise.all([
    listChecklistTemplates(ctx.storeId),
    listChecklistRuns(ctx.storeId, { from: today, to: today }),
  ]);
  const loadError = templatesRes.error ?? runsRes.error;
  const templates = (templatesRes.data ?? []).filter((template) => templateAppliesOn(template, today));
  const runs = runsRes.data ?? [];
  const readiness = computeAreaReadiness(templatesRes.data ?? [], runs, today);
  const sorted = [...templates].sort((a, b) => {
    const mineA = a.assigneeUserIds.includes(user.id) ? 0 : 1;
    const mineB = b.assigneeUserIds.includes(user.id) ? 0 : 1;
    return mineA - mineB || a.sortOrder - b.sortOrder;
  });

  return (
    <section className="page-shell max-w-3xl">
      <div className="page-header">
        <div>
          <h1 className="page-title">งานหน้าร้าน</h1>
          <p className="page-kicker">{formatShiftDate(today)} · อัปเดต {nowLocal.time} น.</p>
        </div>
        {isManager && (
          <div className="flex flex-wrap gap-2">
            <Link className="btn-secondary" href="/ops/history">ประวัติ</Link>
            <Link className="btn-secondary" href="/ops/templates">ตั้งค่าเช็กลิสต์</Link>
          </div>
        )}
      </div>

      {loadError && <p className="alert-danger" role="alert">โหลดข้อมูลไม่สำเร็จ: {loadError}</p>}

      {readiness.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {readiness.map((area) => (
            <div key={area.area} className={`rounded-lg border p-3 ${READINESS_TONE[area.readiness]}`}>
              <p className="text-xs font-semibold opacity-80">{area.area}</p>
              <p className="text-lg font-bold">{READINESS_LABELS[area.readiness]}</p>
              {area.reasons.slice(0, 2).map((reason) => (
                <p key={reason} className="mt-1 text-xs leading-snug">{reason}</p>
              ))}
            </div>
          ))}
        </div>
      )}

      <div className="mt-4 space-y-3">
        {sorted.length === 0 && (
          <p className="rounded-lg border border-gray-200 bg-white p-5 text-sm text-gray-600">วันนี้ไม่มีเช็กลิสต์ที่ต้องทำ</p>
        )}
        {sorted.map((template) => {
          const run = runs.find((entry) => entry.templateId === template.id);
          const answered = run ? run.items.filter((item) => item.answer !== null).length : 0;
          const failCount = run ? run.items.filter((item) => item.answer === "fail").length : 0;
          const mine = template.assigneeUserIds.includes(user.id);
          const overdue = run?.status !== "submitted" && isChecklistOverdue(template.dueTime, today, nowLocal);
          return (
            <div key={template.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-gray-200 bg-white p-4">
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-gray-900">
                  {template.name}
                  {template.area && <span className="ml-2 text-xs font-normal text-gray-500">{template.area}</span>}
                </p>
                <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-600">
                  <span>{CHECKLIST_PHASE_LABELS[template.phase]}</span>
                  {template.dueTime && <span className={overdue ? "font-semibold text-red-700" : ""}>กำหนด {template.dueTime} น.{overdue ? " · เลยกำหนด" : ""}</span>}
                  {mine && <span className="font-semibold text-emerald-700">คุณรับผิดชอบ</span>}
                  {mine && template.requireBeforeClockOut && <span className="text-amber-700">ต้องเสร็จก่อนออกงาน</span>}
                </p>
                <p className="mt-1 text-xs text-gray-500">
                  {!run && "ยังไม่เริ่ม"}
                  {run?.status === "in_progress" && `กำลังทำ ${answered}/${run.items.length} ข้อ`}
                  {run?.status === "submitted" && `ส่งแล้ว ${formatStoreTime(run.submittedAt, ctx.storeTimezone)} น.`}
                  {failCount > 0 && <span className="ml-2 font-semibold text-red-700">ไม่ผ่าน {failCount} ข้อ</span>}
                </p>
              </div>
              {run ? (
                <Link className={run.status === "submitted" ? "btn-secondary" : "btn-primary"} href={`/ops/run/${run.id}`}>
                  {run.status === "submitted" ? "ดู" : "ทำต่อ"}
                </Link>
              ) : (
                <StartRunButton templateId={template.id} label="เริ่ม" />
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
