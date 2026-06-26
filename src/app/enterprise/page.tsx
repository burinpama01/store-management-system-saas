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

export default function EnterpriseRequestPage() {
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

        <GlassPanel className="p-6">
          <EnterpriseRequestForm />
        </GlassPanel>
      </section>

      <MarketingFooter />
    </main>
  );
}
