import Link from "next/link";
import { getPublicPricing } from "@/modules/billing/pricing-repository";
import { getFreeTrialCampaign } from "@/modules/billing/platform-settings";
import { isFreeTrialCampaignOpen } from "@/modules/billing/free-trial";
import { GlassPanel, MarketingFooter, MarketingHeader } from "@/shared/components/marketing/MarketingShell";
import { PricingPlans } from "./PricingPlans";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "แพ็กเกจและราคา - StoreOS",
  description: "เลือกแพ็กเกจ StoreOS สำหรับร้านอาหาร คาเฟ่ บุฟเฟต์ และร้านหลายสาขา",
};

export default async function PricingPage() {
  const [plans, campaign] = await Promise.all([getPublicPricing(), getFreeTrialCampaign()]);
  const freeTrialOpen = isFreeTrialCampaignOpen(campaign);

  return (
    <main className="marketing-page">
      <MarketingHeader active="pricing" />

      <section className="reference-pricing-hero">
        <div className="reference-section-heading">
          <h1>เลือกแพ็กเกจที่ใช่ สำหรับร้านของคุณ</h1>
          <p>
            {freeTrialOpen
              ? "โปรโมชั่นจำกัดเวลา: สมัครวันนี้ทดลองใช้ Enterprise ครบทุกฟีเจอร์ฟรี 30 วัน (1 ครั้งต่อบัญชี) แล้วค่อยเลือกแพ็กเกจที่ใช่"
              : "เลือกแพ็กเกจที่เหมาะกับร้าน อัปเกรดหรือเปลี่ยนแพ็กเกจได้ทุกเมื่อ"}
          </p>
        </div>
      </section>

      <PricingPlans plans={plans} freeTrialOpen={freeTrialOpen} />

      <GlassPanel id="enterprise-contact" className="reference-enterprise-contact">
        <div>
          <h2>ต้องการ Enterprise สำหรับหลายสาขา?</h2>
          <p>คุยกับทีม StoreOS เพื่อวางแพ็กเกจ รายปี การย้ายข้อมูล และการเชื่อมต่อระบบที่เหมาะกับองค์กร</p>
        </div>
        <Link href="/enterprise" className="btn-primary">
          กรอกฟอร์มขอใช้งาน
        </Link>
      </GlassPanel>

      <MarketingFooter />
    </main>
  );
}
