import Link from "next/link";
import { getPublicPricing } from "@/modules/billing/pricing-repository";
import { GlassPanel, MarketingFooter, MarketingHeader } from "@/shared/components/marketing/MarketingShell";
import { PricingPlans } from "./PricingPlans";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "แพ็กเกจและราคา - StoreOS",
  description: "เลือกแพ็กเกจ StoreOS สำหรับร้านอาหาร คาเฟ่ บุฟเฟต์ และร้านหลายสาขา",
};

export default async function PricingPage() {
  const plans = await getPublicPricing();

  return (
    <main className="marketing-page">
      <MarketingHeader active="pricing" />

      <section className="reference-pricing-hero">
        <div className="reference-section-heading">
          <h1>เลือกแพ็กเกจที่ใช่ สำหรับร้านของคุณ</h1>
          <p>ลูกค้าใหม่รับ Premium ฟรี 30 วันได้ 1 ครั้งต่อบัญชี แล้วเลือกอัปเกรดหรือยกเลิกได้</p>
        </div>
      </section>

      <PricingPlans plans={plans} />

      <GlassPanel id="enterprise-contact" className="reference-enterprise-contact">
        <div>
          <h2>ต้องการ Enterprise สำหรับหลายสาขา?</h2>
          <p>คุยกับทีม StoreOS เพื่อวางแพ็กเกจ รายปี การย้ายข้อมูล และการเชื่อมต่อระบบที่เหมาะกับองค์กร</p>
        </div>
        <Link href="mailto:support@storeos.app?subject=StoreOS%20Enterprise" className="btn-primary">
          ติดต่อฝ่ายขาย
        </Link>
      </GlassPanel>

      <MarketingFooter />
    </main>
  );
}
