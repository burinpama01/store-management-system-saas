import { requireSystemAccess } from "@/modules/auth/guards";
import { SubmitButton } from "@/shared/components/ui";
import { listMusicLicenses } from "@/modules/music-requests/license-repository";
import type { MusicLicenseStatus } from "@/modules/stores/types";
import { updateMusicLicenseAction } from "./actions";

export const dynamic = "force-dynamic";

const STATUS_LABELS: Record<MusicLicenseStatus, string> = {
  not_requested: "ยังไม่ขอ",
  pending: "รอตรวจ",
  approved: "อนุมัติแล้ว",
  rejected: "ปฏิเสธ",
  expired: "หมดอายุ",
};

const STATUS_BADGE: Record<MusicLicenseStatus, string> = {
  not_requested: "badge-warning",
  pending: "badge-brand",
  approved: "badge-success",
  rejected: "badge-warning",
  expired: "badge-warning",
};

function fmtDateTime(iso?: string) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleString("th-TH", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export default async function SystemMusicLicensesPage() {
  await requireSystemAccess();
  const { data: licenses } = await listMusicLicenses();
  const approvedCount = licenses.filter((l) => l.musicLicenseStatus === "approved").length;

  return (
    <div className="space-y-5">
      <div className="page-header">
        <div>
          <h1 className="page-title">ใบอนุญาตขอเพลง (Music License)</h1>
          <p className="page-kicker">อนุมัติ/เพิกถอนสิทธิ์ฟีเจอร์ขอเพลงของร้าน Enterprise</p>
        </div>
        <span className="badge badge-success">{approvedCount} ร้านอนุมัติแล้ว</span>
      </div>

      <section className="panel overflow-x-auto p-0">
        <h2 className="panel-title px-4 pt-4">ร้านทั้งหมด ({licenses.length})</h2>
        {licenses.length === 0 ? (
          <p className="p-4 text-sm text-[var(--muted)]">ยังไม่มีร้าน</p>
        ) : (
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--line)] text-left text-[var(--muted)]">
                <th className="px-4 py-2">ร้าน</th>
                <th className="px-4 py-2">สถานะ</th>
                <th className="px-4 py-2">เปิดใช้</th>
                <th className="px-4 py-2">อนุมัติเมื่อ</th>
                <th className="px-4 py-2">จัดการ</th>
              </tr>
            </thead>
            <tbody>
              {licenses.map((l) => (
                <tr key={l.storeId} className="border-b border-[var(--line)] align-top">
                  <td className="px-4 py-3">
                    <p className="font-semibold text-[var(--ink)]">{l.storeName}</p>
                    {l.musicLicenseNote && (
                      <p className="text-xs text-[var(--muted)]">📝 {l.musicLicenseNote}</p>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`badge ${STATUS_BADGE[l.musicLicenseStatus]}`}>
                      {STATUS_LABELS[l.musicLicenseStatus]}
                    </span>
                  </td>
                  <td className="px-4 py-3">{l.musicRequestEnabled ? "✅" : "—"}</td>
                  <td className="px-4 py-3 text-[var(--muted)]">{fmtDateTime(l.musicLicenseApprovedAt)}</td>
                  <td className="px-4 py-3">
                    <form action={updateMusicLicenseAction} className="flex flex-wrap items-center gap-2">
                      <input type="hidden" name="storeId" value={l.storeId} />
                      <select name="status" defaultValue={l.musicLicenseStatus} className="input h-9 text-xs">
                        <option value="pending">รอตรวจ</option>
                        <option value="approved">อนุมัติ</option>
                        <option value="rejected">ปฏิเสธ</option>
                        <option value="expired">หมดอายุ</option>
                      </select>
                      <input
                        name="note"
                        defaultValue={l.musicLicenseNote ?? ""}
                        placeholder="หมายเหตุ"
                        maxLength={200}
                        className="input h-9 w-32 text-xs"
                      />
                      <SubmitButton className="btn-primary h-9 px-3 text-xs">บันทึก</SubmitButton>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
