import Link from "next/link";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import {
  listEnterpriseRequestsForOrg,
  type EnterpriseRequest,
  type EnterpriseRequestStatus,
} from "@/modules/enterprise/repository";
import { GlassPanel, MarketingFooter, MarketingHeader } from "@/shared/components/marketing/MarketingShell";
import { EnterpriseRequestForm } from "./EnterpriseRequestForm";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "ขอใช้งาน Enterprise - StoreOS",
  description: "กรอกข้อมูลเพื่อขอใช้งานแพ็กเกจ Enterprise ของ StoreOS สำหรับธุรกิจหลายสาขา",
};

const BENEFITS = [
  "ไม่จำกัดสาขาและจำนวนสมาชิก",
  "Member QR + Loyalty + Coupons + จอลูกค้า",
  "รายงานหลายสาขา + API Integration",
  "ทีมงานช่วยย้ายข้อมูลและตั้งค่าให้",
  "Support พิเศษและเงื่อนไขรายปีที่ยืดหยุ่น",
];

const STATUS_LABELS: Record<EnterpriseRequestStatus, string> = {
  new: "รอดำเนินการ",
  contacted: "กำลังติดต่อกลับ",
  closed: "ปิดงานแล้ว",
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

export default async function EnterpriseRequestPage() {
  const { ctx, user } = await getResolvedCurrentPermissions();
  const requests = await listEnterpriseRequestsForOrg(ctx.organizationId);

  return (
    <main className="marketing-page">
      <MarketingHeader active="pricing" />

      <section className="reference-pricing-hero">
        <div className="reference-section-heading">
          <h1>ขอใช้งานแบบ Enterprise</h1>
          <p>กรอกข้อมูลด้านล่าง ทีม StoreOS จะติดต่อกลับเพื่อออกแบบแพ็กเกจให้เหมาะกับองค์กรของคุณ</p>
        </div>
      </section>

      <section className="mx-auto grid w-full max-w-5xl gap-6 px-4 pb-16 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <div className="space-y-6">
          <GlassPanel className="p-6">
            <h2 className="text-lg font-extrabold text-[var(--ink)]">สิ่งที่คุณจะได้รับ</h2>
            <ul className="mt-4 space-y-3 text-sm text-[var(--ink-2)]">
              {BENEFITS.map((b) => (
                <li key={b} className="flex items-start gap-2">
                  <span className="mt-0.5 text-[var(--tenant-primary-strong)]">✓</span>
                  <span>{b}</span>
                </li>
              ))}
            </ul>
          </GlassPanel>

          {requests.length > 0 && (
            <GlassPanel className="p-6">
              <h2 className="text-lg font-extrabold text-[var(--ink)]">คำขอของคุณ</h2>
              <p className="mt-1 text-xs text-[var(--muted)]">ติดตามสถานะคำขอ Enterprise ที่คุณส่งมา</p>
              <ul className="mt-4 space-y-3">
                {requests.map((r: EnterpriseRequest) => (
                  <li
                    key={r.id}
                    className="flex items-center justify-between gap-3 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-bold text-[var(--ink)]">{r.companyName}</p>
                      <p className="text-xs text-[var(--muted)]">ส่งเมื่อ {fmtDateTime(r.createdAt)}</p>
                    </div>
                    <span className={`badge ${STATUS_BADGE[r.status]} shrink-0`}>{STATUS_LABELS[r.status]}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-xs text-[var(--muted)]">
                เราจะส่งอีเมลแจ้งทุกครั้งที่สถานะเปลี่ยน และคุณดูสถานะได้ที่หน้านี้หรือหน้า{" "}
                <Link href="/settings/billing" className="font-bold text-[var(--color-brand)]">การเรียกเก็บเงิน</Link>
              </p>
            </GlassPanel>
          )}
        </div>

        <GlassPanel className="p-6">
          <EnterpriseRequestForm
            defaults={{ companyName: ctx.orgName, email: user.email ?? "" }}
          />
        </GlassPanel>
      </section>

      <MarketingFooter />
    </main>
  );
}
