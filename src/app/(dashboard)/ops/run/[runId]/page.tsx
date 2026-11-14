import Link from "next/link";
import { notFound } from "next/navigation";
import { formatShiftDate, formatStoreDateTime } from "@/modules/operations/format";
import { createEvidenceSignedUrls, getChecklistRun } from "@/modules/operations/repository";
import { CHECKLIST_PHASE_LABELS } from "@/modules/operations/types";
import { loadMemberNames, loadOpsPageContext } from "../../shared";
import { ChecklistRunForm } from "./ChecklistRunForm";

export const dynamic = "force-dynamic";

export default async function ChecklistRunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const { user, ctx, enabled, isManager } = await loadOpsPageContext();
  const runRes = await getChecklistRun(ctx.storeId, runId);
  if (runRes.error) {
    return (
      <section className="page-shell max-w-3xl">
        <p className="alert-danger" role="alert">โหลดเช็กลิสต์ไม่สำเร็จ: {runRes.error}</p>
      </section>
    );
  }
  const run = runRes.data;
  if (!run) notFound();

  const [photoUrls, names] = await Promise.all([
    createEvidenceSignedUrls(run.items.map((item) => item.photoPath ?? "").filter(Boolean)),
    isManager ? loadMemberNames(ctx.organizationId, ctx.storeId) : Promise.resolve(new Map<string, string>()),
  ]);
  const nameOf = (userId: string | null) => {
    if (!userId) return "-";
    if (userId === user.id) return "คุณ";
    return names.get(userId) ?? "พนักงาน";
  };

  return (
    <section className="page-shell max-w-3xl">
      <div className="page-header">
        <div>
          <p className="text-xs text-gray-500"><Link href="/ops" className="underline">งานหน้าร้าน</Link></p>
          <h1 className="page-title">{run.templateName}</h1>
          <p className="page-kicker">
            {CHECKLIST_PHASE_LABELS[run.phase]}{run.area ? ` · ${run.area}` : ""} · {formatShiftDate(run.shiftDate)} · ฉบับที่ {run.templateVersion}
          </p>
          <p className="mt-1 text-xs text-gray-500">
            เริ่มโดย {nameOf(run.startedBy)} {formatStoreDateTime(run.startedAt, ctx.storeTimezone)}
            {run.status === "submitted" && ` · ส่งโดย ${nameOf(run.submittedBy)} ${formatStoreDateTime(run.submittedAt, ctx.storeTimezone)}`}
          </p>
        </div>
        {isManager && <Link className="btn-secondary" href={`/ops/history?date=${run.shiftDate}#run-${run.id}`}>ประวัติรอบนี้</Link>}
      </div>

      {!enabled && <p className="alert-danger" role="alert">สาขานี้ปิดระบบงานหน้าร้านอยู่ — แก้ไขคำตอบไม่ได้</p>}

      <ChecklistRunForm
        run={run}
        editable={enabled && run.status === "in_progress"}
        canReopen={isManager && run.status === "submitted"}
        photoUrls={Object.fromEntries(photoUrls)}
        answeredByLabels={Object.fromEntries(
          run.items.map((item) => [
            item.id,
            item.answeredBy ? `${nameOf(item.answeredBy)} · ${formatStoreDateTime(item.answeredAt, ctx.storeTimezone)}` : "",
          ]),
        )}
      />
    </section>
  );
}
