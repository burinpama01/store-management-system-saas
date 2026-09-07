import Link from "next/link";
import { getPublicPricing } from "@/modules/billing/pricing-repository";
import { getFreeTrialCampaign } from "@/modules/billing/platform-settings";
import { isFreeTrialCampaignOpen } from "@/modules/billing/free-trial";
import { MarketingFooter, MarketingHeader } from "@/shared/components/marketing/MarketingShell";
import { PricingPlans } from "./PricingPlans";
import "../landing.css";
import "./pricing.css";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "แพ็กเกจและราคา - StoreOS",
  description: "เลือกแพ็กเกจ StoreOS สำหรับร้านอาหาร คาเฟ่ บุฟเฟต์ และร้านหลายสาขา",
};

export default async function PricingPage() {
  const [plans, campaign] = await Promise.all([getPublicPricing(), getFreeTrialCampaign()]);
  const freeTrialOpen = isFreeTrialCampaignOpen(campaign);

  return (
    <main className="marketing-page play-landing pricing-page">
      <MarketingHeader active="pricing" />

      <section className="pricing-hero">
        <span className="pricing-eyebrow">แพ็กเกจและราคา · STOREOS</span>
        <h1>ร้านมีจังหวะของตัวเอง<br/><em>แพ็กเกจก็เลือกได้</em></h1>
        <p>เริ่มจากงานขายที่ต้องใช้วันนี้ แล้วเลือกเครื่องมือที่ช่วยให้ร้านไปต่อ<br/>ดูราคา จำนวนสาขา และฟีเจอร์ในที่เดียว</p>
      </section>

      <PricingPlans plans={plans} freeTrialOpen={freeTrialOpen} />

      <section className="pricing-faq" aria-label="คำถามเกี่ยวกับแพ็กเกจ">
        <h2>ก่อนเลือกแพ็กเกจ</h2>
        <details><summary>30 วันกับ 1 ปี ต่างกันอย่างไร?</summary><p>รอบสั้นให้สิทธิ์ 30 วัน รอบรายปีให้สิทธิ์ 365 วัน ราคาที่แสดงเป็นยอดต่อรอบ ไม่ใช่ราคาเฉลี่ยต่อเดือน</p></details>
        <details><summary>Business เริ่มต้นรวมอะไรบ้าง?</summary><p>ราคาเริ่มต้นรวมค่าระบบ 1 สมาชิก และ 1 สาขา ยังไม่รวมฟีเจอร์เสริม คุณเลือกจำนวนและฟีเจอร์เพื่อดูยอดรวมได้ในหน้าตั้งค่าแพ็กเกจก่อนชำระเงิน</p></details>
        <details><summary>ทดลองฟรีแล้วเลือกแพ็กเกจอย่างไร?</summary><p>เมื่อแคมเปญเปิด ระบบจะตรวจสิทธิ์ทดลองหลังสมัครหรือเข้าสู่ระบบ เมื่อครบระยะทดลอง ให้เลือกซื้อแพ็กเกจในหน้าตั้งค่าแพ็กเกจ หรือติดต่อทีมงานเรื่อง Enterprise</p></details>
      </section>

      <section id="enterprise-contact" className="pricing-contact">
        <div>
          <h2>มีแผนสำหรับร้านที่ใหญ่ขึ้น?</h2>
          <p>บอกจำนวนสาขาและสิ่งที่ต้องใช้ เพื่อให้ทีม StoreOS เสนอรายละเอียด Enterprise</p>
        </div>
        <Link href="/enterprise" className="pricing-action is-primary">
          กรอกฟอร์มขอใช้งาน
        </Link>
      </section>

      <MarketingFooter />
    </main>
  );
}
