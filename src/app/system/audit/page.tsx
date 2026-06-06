import { requireSystemAccess } from "@/modules/auth/guards";
import { listRecentAuditLogs } from "@/modules/system/repository";

export const dynamic = "force-dynamic";

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("th-TH");
}

export default async function SystemAuditPage() {
  await requireSystemAccess();
  const logs = await listRecentAuditLogs(100);

  return (
    <div className="space-y-5">
      <div className="page-header">
        <div>
          <h1 className="page-title">Audit / Security Events</h1>
          <p className="page-kicker">เหตุการณ์ด้านสิทธิ์และความปลอดภัยล่าสุดทั้งระบบ (อ่านอย่างเดียว)</p>
        </div>
      </div>

      <section className="panel overflow-x-auto p-0">
        {logs.length === 0 ? (
          <p className="p-6 text-sm text-[var(--muted)]">ยังไม่มีเหตุการณ์</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-left text-xs text-[var(--muted)]">
                <th className="px-4 py-3 font-bold">เวลา</th>
                <th className="px-4 py-3 font-bold">การกระทำ</th>
                <th className="px-4 py-3 font-bold">ผู้กระทำ</th>
                <th className="px-4 py-3 font-bold">เป้าหมาย</th>
                <th className="px-4 py-3 font-bold">เหตุผล</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr key={log.id} className="border-b border-[var(--border)] last:border-0">
                  <td className="whitespace-nowrap px-4 py-3 text-[var(--muted)]">{formatDateTime(log.createdAt)}</td>
                  <td className="px-4 py-3 font-bold text-[var(--ink)]">{log.action}</td>
                  <td className="px-4 py-3 text-[var(--muted)]">{log.actorUserId.slice(0, 8)}…</td>
                  <td className="px-4 py-3 text-[var(--muted)]">
                    {log.targetUserId ? `${log.targetUserId.slice(0, 8)}…` : "—"}
                  </td>
                  <td className="px-4 py-3 text-[var(--ink-2)]">{log.reason ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
