import Link from "next/link";
import { redirect } from "next/navigation";
import { getStoreLocalDate } from "@/modules/attendance/date";
import { formatShiftDate, formatStoreDateTime, formatStoreTime } from "@/modules/operations/format";
import { listChecklistEventsForRuns, listChecklistRuns, listChecklistTemplates, listTemplateEvents } from "@/modules/operations/repository";
import { addDays, computeAreaReadiness } from "@/modules/operations/rules";
import { describeChecklistEvent } from "@/modules/operations/history";
import { CHECKLIST_PHASE_LABELS, READINESS_LABELS } from "@/modules/operations/types";
import { loadMemberNames, loadOpsPageContext, READINESS_TONE } from "../shared";

export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default async function ChecklistHistoryPage({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  const { ctx, isManager } = await loadOpsPageContext();
  if (!isManager) redirect("/ops");

  const today = getStoreLocalDate(ctx.storeTimezone, new Date());
  const requested = (await searchParams).date;
  const date = requested && DATE_RE.test(requested) && requested <= today ? requested : today;

  const [runsRes, templatesRes, templateEventsRes, names] = await Promise.all([
    listChecklistRuns(ctx.storeId, { from: date, to: date }),
    listChecklistTemplates(ctx.storeId, { includeInactive: true }),
    listTemplateEvents(ctx.storeId, 20),
    loadMemberNames(ctx.organizationId, ctx.storeId),
  ]);
  const runs = runsRes.data ?? [];
  const eventsRes = await listChecklistEventsForRuns(ctx.storeId, runs.map((run) => run.id));
  const events = eventsRes.data ?? [];
  const readiness = computeAreaReadiness(templatesRes.data ?? [], runs, date);
  const nameOf = (userId: string) => names.get(userId) ?? "ไม่พบบัญชี";
  const loadError = runsRes.error ?? templatesRes.error ?? eventsRes.error ?? templateEventsRes.error;

  return (
    <section className="page-shell max-w-3xl">
      <div className="page-header">
        <div>
          <p className="text-xs text-gray-500"><Link href="/ops" className="underline">งานหน้าร้าน</Link></p>
          <h1 className="page-title">ประวัติเช็กลิสต์</h1>
          <p className="page-kicker">ใคร ทำอะไร เมื่อไร — {formatShiftDate(date)}</p>
        </div>
      </div>

      <form className="mb-4 flex flex-wrap items-center gap-2" action="/ops/history">
        <Link className="btn-secondary" href={`/ops/history?date=${addDays(date, -1)}`}>‹</Link>
        <input type="date" name="date" defaultValue={date} max={today} className="rounded-md border border-gray-300 px-2 py-2 text-sm" />
        <button className="btn-secondary" type="submit">ดู</button>
        {date < today && <Link className="btn-secondary" href={`/ops/history?date=${addDays(date, 1)}`}>›</Link>}
      </form>

      {loadError && <p className="alert-danger" role="alert">โหลดไม่สำเร็จ: {loadError}</p>}

      {readiness.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {readiness.map((area) => (
            <div key={area.area} className={`rounded-lg border p-3 ${READINESS_TONE[area.readiness]}`}>
              <p className="text-xs font-semibold opacity-80">{area.area}</p>
              <p className="text-lg font-bold">{READINESS_LABELS[area.readiness]}</p>
            </div>
          ))}
        </div>
      )}

      <div className="mt-4 space-y-4">
        {runs.length === 0 && <p className="rounded-lg border border-gray-200 bg-white p-5 text-sm text-gray-600">วันนี้ยังไม่มีการทำเช็กลิสต์</p>}
        {runs.map((run) => {
          const runEvents = events.filter((event) => event.runId === run.id);
          const fails = run.items.filter((item) => item.answer === "fail");
          return (
            <div key={run.id} id={`run-${run.id}`} className="rounded-lg border border-gray-200 bg-white p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Link href={`/ops/run/${run.id}`} className="font-semibold text-gray-900 underline">{run.templateName}</Link>
                <span className="text-xs text-gray-500">{CHECKLIST_PHASE_LABELS[run.phase]}{run.area ? ` · ${run.area}` : ""} · ฉบับที่ {run.templateVersion}</span>
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${run.status === "submitted" ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}`}>
                  {run.status === "submitted" ? `ส่งแล้ว ${formatStoreTime(run.submittedAt, ctx.storeTimezone)}` : "ยังไม่ส่ง"}
                </span>
              </div>
              {fails.length > 0 && (
                <ul className="mt-2 space-y-1 text-sm text-red-800">
                  {fails.map((item) => (
                    <li key={item.id}>✗ {item.label}{item.critical ? " (สำคัญ)" : ""}{item.note ? ` — ${item.note}` : ""}</li>
                  ))}
                </ul>
              )}
              <ol className="mt-3 space-y-1 border-l-2 border-gray-200 pl-3">
                {runEvents.map((event) => (
                  <li key={event.id} className="text-xs text-gray-700">
                    <span className="font-mono text-gray-500">{formatStoreTime(event.createdAt, ctx.storeTimezone)}</span>{" "}
                    <span className="font-semibold">{nameOf(event.actorUserId)}</span>{" "}
                    {describeChecklistEvent(event)}
                  </li>
                ))}
              </ol>
            </div>
          );
        })}
      </div>

      <details className="mt-6 rounded-lg border border-gray-200 bg-white p-4">
        <summary className="cursor-pointer text-sm font-semibold text-gray-900">การแก้ไขเช็กลิสต์ล่าสุด</summary>
        <ol className="mt-2 space-y-1">
          {(templateEventsRes.data ?? []).map((event) => (
            <li key={event.id} className="text-xs text-gray-700">
              <span className="font-mono text-gray-500">{formatStoreDateTime(event.createdAt, ctx.storeTimezone)}</span>{" "}
              <span className="font-semibold">{nameOf(event.actorUserId)}</span> {describeChecklistEvent(event)}
            </li>
          ))}
        </ol>
      </details>
    </section>
  );
}
