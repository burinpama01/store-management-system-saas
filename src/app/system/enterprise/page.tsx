import Link from "next/link";
import { requireSystemAccess } from "@/modules/auth/guards";
import {
  listEnterpriseRequests,
  type EnterpriseRequest,
  type EnterpriseRequestStatus,
} from "@/modules/enterprise/repository";
import { SubmitButton } from "@/shared/components/ui";
import { updateEnterpriseStatusAction } from "./actions";

export const dynamic = "force-dynamic";

const STATUS_LABELS: Record<EnterpriseRequestStatus, string> = {
  new: "ใหม่",
  contacted: "ติดต่อแล้ว",
  closed: "ปิดงาน",
};

const STATUS_BADGE: Record<EnterpriseRequestStatus, string> = {
  new: "badge-brand",
  contacted: "badge-success",
  closed: "badge-warning",
};

function fmtDateTime(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleString("th-TH", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export default async function SystemEnterprisePage() {
  await requireSystemAccess();
  const requests = await listEnterpriseRequests();
  const newCount = requests.filter((r) => r.status === "new").length;

  return (
    <div className="space-y-5">
      <div className="page-header">
        <div>
          <h1 className="page-title">คำขอใช้งาน Enterprise</h1>
          <p className="page-kicker">คำขอจากหน้า /enterprise — ติดตามและอัปเดตสถานะการติดต่อ</p>
        </div>
        {newCount > 0 && <span className="badge badge-brand">{newCount} คำขอใหม่</span>}
      </div>

      <section className="panel overflow-x-auto p-0">
        <h2 className="panel-title px-4 pt-4">คำขอทั้งหมด ({requests.length})</h2>
        {requests.length === 0 ? (
          <p className="p-4 text-sm text-[var(--muted)]">ยังไม่มีคำขอ</p>
        ) : (
          <table className="mt-3 w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-left text-xs text-[var(--muted)]">
                <th className="px-4 py-2 font-bold">บริษัท / ผู้ติดต่อ</th>
                <th className="px-4 py-2 font-bold">ช่องทางติดต่อ</th>
                <th className="px-4 py-2 text-right font-bold">สาขา</th>
                <th className="px-4 py-2 font-bold">รายละเอียด</th>
                <th className="px-4 py-2 font-bold">วันที่</th>
                <th className="px-4 py-2 font-bold">สถานะ</th>
                <th className="px-4 py-2 font-bold"></th>
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => (
                <EnterpriseRow key={r.id} request={r} />
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function EnterpriseRow({ request: r }: { request: EnterpriseRequest }) {
  return (
    <tr className="border-b border-[var(--border)] align-top last:border-0">
      <td className="px-4 py-3">
        <p className="font-bold text-[var(--ink)]">{r.companyName}</p>
        <p className="text-xs text-[var(--muted)]">{r.contactName}</p>
        {r.organizationId && (
          <Link
            href={`/system/tenants/${r.organizationId}`}
            className="text-xs font-bold text-[var(--color-brand)] hover:underline"
          >
            ดู tenant ที่เชื่อมโยง
          </Link>
        )}
      </td>
      <td className="px-4 py-3 text-xs text-[var(--ink-2)]">
        <a href={`mailto:${r.email}`} className="text-[var(--color-brand)] hover:underline">{r.email}</a>
        {r.phone && <p className="mt-0.5 text-[var(--muted)]">{r.phone}</p>}
      </td>
      <td className="px-4 py-3 text-right tabular-nums text-[var(--ink-2)]">{r.branchCount ?? "—"}</td>
      <td className="max-w-xs px-4 py-3 text-xs text-[var(--muted)]">
        {r.message ? <span className="whitespace-pre-wrap">{r.message}</span> : "—"}
      </td>
      <td className="px-4 py-3 whitespace-nowrap text-xs text-[var(--muted)]">{fmtDateTime(r.createdAt)}</td>
      <td className="px-4 py-3">
        <span className={`badge ${STATUS_BADGE[r.status]}`}>{STATUS_LABELS[r.status]}</span>
      </td>
      <td className="px-4 py-3">
        <div className="flex flex-wrap justify-end gap-1">
          {r.status !== "contacted" && (
            <StatusButton id={r.id} status="contacted" label="ติดต่อแล้ว" />
          )}
          {r.status !== "closed" && (
            <StatusButton id={r.id} status="closed" label="ปิดงาน" />
          )}
          {r.status !== "new" && (
            <StatusButton id={r.id} status="new" label="เปิดใหม่" />
          )}
        </div>
      </td>
    </tr>
  );
}

function StatusButton({ id, status, label }: { id: string; status: EnterpriseRequestStatus; label: string }) {
  return (
    <form action={updateEnterpriseStatusAction}>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="status" value={status} />
      <SubmitButton variant="secondary" className="text-xs">{label}</SubmitButton>
    </form>
  );
}
