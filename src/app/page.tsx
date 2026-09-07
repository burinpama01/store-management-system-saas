import Link from "next/link";
import { LandingWorkflow } from "@/shared/components/marketing/LandingWorkflow";
import { MarketingFooter, MarketingHeader } from "@/shared/components/marketing/MarketingShell";
import { LandingPlayground } from "@/shared/components/marketing/LandingPlayground";
import { LandingStoreLogos } from "@/shared/components/marketing/LandingStoreLogos";
import { listLandingStores } from "@/modules/stores/landing-repository";
import "./landing.css";
import { getFreeTrialCampaign } from "@/modules/billing/platform-settings";
import { isFreeTrialCampaignOpen } from "@/modules/billing/free-trial";
import { LAUNCHER_VERSION } from "@/modules/launcher/version";

// อ่านสถานะแคมเปญทดลองฟรีจาก platform_settings ทุกครั้ง เพื่อให้ CTA ตรงกับที่ super-admin ตั้งไว้
export const dynamic = "force-dynamic";

export const metadata = {
  title: "StoreOS - ระบบจัดการร้านครบวงจร POS, QR Ordering, รายงาน",
  description:
    "StoreOS ระบบจัดการร้านอาหาร คาเฟ่ บุฟเฟต์ และหลายสาขา ครบทั้ง POS, QR ordering, สต็อก, ลงเวลา, รายงาน และการชำระเงิน",
};

const FEATURE_CHIPS = ["POS", "QR Ordering", "สต็อก", "ลงเวลา", "รายงาน", "หลายสาขา"];

const FLOW_STEPS = [
  {
    title: "POS",
    detail: "รับออเดอร์ จัดการบิล และชำระเงิน",
    bullets: ["เลือกสินค้าและรับออเดอร์", "จัดการโต๊ะและบิล", "รับชำระเงินและพิมพ์ใบเสร็จ", "ใช้ส่วนลดและคูปอง"],
  },
  {
    title: "QR Ordering",
    detail: "ลูกค้าสั่งเอง ลดงานหน้าร้าน",
    bullets: ["เปิดเมนูของร้านผ่าน QR โต๊ะ", "เลือกเมนูและส่งออร์เดอร์", "ดูออร์เดอร์ของโต๊ะ", "เรียกพนักงานและขอเช็คบิล"],
  },
  {
    title: "สต็อกสินค้า",
    detail: "จัดการ Stock Pool และจำนวนคงเหลือ",
    bullets: ["ใช้สต็อกกลางร่วมกันหลายตัวเลือกสินค้า", "กำหนดจำนวนที่ตัดต่อการขาย", "เพิ่มและปรับยอดคงเหลือ", "ตั้งเกณฑ์เตือนสต็อกต่ำ"],
  },
  {
    title: "ลงเวลา",
    detail: "เช็กอินพนักงานและวันหยุดร้าน",
    bullets: ["ลงชื่อเข้าและออกงาน", "ดูปฏิทินและสถานะการลงเวลา", "จัดการวันลาและวันหยุดร้าน", "ตั้งค่า GPS ยืนยันพื้นที่เข้างาน"],
  },
  {
    title: "รายงาน",
    detail: "ยอดขาย ช่องทางชำระเงิน และสินค้าขายดี",
    bullets: ["เลือกช่วงเวลาและดูยอดขายรายวัน", "ดูจำนวนออร์เดอร์และค่าเฉลี่ยต่อบิล", "เปรียบเทียบช่องทางชำระเงินและสินค้าขายดี", "ส่งออกรายงาน CSV"],
  },
  {
    title: "หลายสาขา",
    detail: "จัดการสาขาภายในองค์กรเดียวกัน",
    bullets: ["เพิ่มสาขาตามสิทธิ์แพ็กเกจ", "เลือกสาขาจากแถบด้านข้าง", "ระบบจำสาขาที่กำลังใช้งาน", "แยกข้อมูลของแต่ละสาขา"],
  },
];

const TRUST_ITEMS = [
  { title: "ใช้งานง่าย", detail: "ออกแบบเพื่อร้านอาหารจริง" },
  { title: "ข้อมูลเป็นสัดส่วน", detail: "แยกข้อมูลตามองค์กรและสาขา" },
  { title: "เชื่อมต่อครบ", detail: "POS, QR, PromptPay, รายงาน" },
  { title: "ทีมเห็นข้อมูลตรงกัน", detail: "เจ้าของ แอดมิน และพนักงาน" },
];

export default async function LandingPage() {
  const [campaign, stores] = await Promise.all([getFreeTrialCampaign(), listLandingStores()]);
  const freeTrialOpen = isFreeTrialCampaignOpen(campaign);

  return (
    <main className="marketing-page play-landing">
      <a className="play-skip-link" href="#features">ข้ามไปดูฟีเจอร์</a>
      <MarketingHeader />

      <section className="reference-hero">
        <div className="reference-hero-copy">
          <p className="play-eyebrow"><span aria-hidden="true">✳</span> ผู้ช่วยร้านเก่ง ๆ ที่อยู่ข้างคุณ</p>
          <h1>
            StoreOS
            <span>ระบบจัดการร้าน</span>
          </h1>
          <p className="reference-hero-lead">ครบ จบ <em>ในระบบเดียว</em></p>
          <div className="reference-chip-row" aria-label="ฟีเจอร์หลัก">
            {FEATURE_CHIPS.map((chip) => (
              <span key={chip}>{chip}</span>
            ))}
          </div>
          <p className="reference-hero-sub">
            จัดการงานขายและหลังร้านสำหรับร้านอาหาร คาเฟ่ และบุฟเฟต์ ให้คุณโฟกัสที่ลูกค้าได้มากขึ้น
          </p>
          <div className="reference-actions">
            <Link href="/register" className="btn-primary reference-primary-cta">
              {freeTrialOpen ? "ทดลอง Enterprise ฟรี 30 วัน" : "เริ่มใช้งาน StoreOS"}
              <span aria-hidden="true">→</span>
            </Link>
            <Link href="/pricing" className="btn-secondary reference-secondary-cta">
              ดูแพ็กเกจและราคา
            </Link>
            <a
              href="/download/android"
              className="btn-secondary reference-secondary-cta"
              rel="nofollow"
            >
              <span aria-hidden="true">📱</span> ดาวน์โหลดแอป (Android)
            </a>
            <a
              href="/download/windows-launcher"
              className="btn-secondary reference-secondary-cta"
              rel="nofollow"
            >
              <span aria-hidden="true">🖥️</span> ตัวช่วยติดตั้งบน Windows (v{LAUNCHER_VERSION})
            </a>
          </div>
          <small className="reference-note">
            {freeTrialOpen
              ? "โปรจำกัดเวลา ครบทุกฟีเจอร์ ใช้ได้ 1 ครั้งต่อบัญชี · แอป Android รองรับแจ้งเตือนและเชื่อมเครื่องพิมพ์ · ตัวช่วยติดตั้งบน Windows ลงเครื่องพิมพ์ให้อัตโนมัติ"
              : "แอป Android รองรับแจ้งเตือนและเชื่อมเครื่องพิมพ์ · ตัวช่วยติดตั้งบน Windows ลงเครื่องพิมพ์ให้อัตโนมัติ"}
          </small>
        </div>

        <LandingPlayground />
        <div className="reference-scroll-hint" aria-hidden="true">
          <span>เลื่อนลงเพื่อดูฟีเจอร์ทั้งหมด</span>
          <i>⌄</i>
        </div>
      </section>

      <div className="play-capabilities" aria-label="ประเภทร้านและอุปกรณ์ที่รองรับ">
        <span>ออกแบบมาสำหรับร้านของคุณ</span><strong>ร้านอาหาร</strong><i aria-hidden="true">✳</i><strong>คาเฟ่</strong><i aria-hidden="true">✳</i><strong>บุฟเฟต์</strong><i aria-hidden="true">✳</i><strong>หลายสาขา</strong><span className="play-device-note">ใช้ได้ทั้งคอมพิวเตอร์และมือถือ</span>
      </div>

      <LandingStoreLogos stores={stores} />

      <section className="reference-flow" id="features">
        <div className="reference-section-heading">
          <span className="play-eyebrow">หนึ่งระบบ ดูแลทั้งร้าน</span>
          <h2>ทำงานลื่นไหล เชื่อมต่อทุกกระบวนการ</h2>
          <p>ตั้งแต่หน้าร้านถึงหลังร้าน ข้อมูลอัปเดตเรียลไทม์</p>
        </div>

        <LandingWorkflow steps={FLOW_STEPS} />

        <div className="reference-trust-bar" id="guide">
          {TRUST_ITEMS.map((item) => (
            <div key={item.title}>
              <strong>{item.title}</strong>
              <span>{item.detail}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="reference-final" id="customers">
        <span className="play-eyebrow">ให้เรื่องจัดการร้าน เป็นเรื่องง่าย</span>
        <h2>พร้อมให้เจ้าของร้านเห็นภาพรวมในที่เดียว</h2>
        <p>เริ่มจากร้านเดียว แล้วขยายเป็นหลายสาขาได้โดยไม่ต้องเปลี่ยนระบบ</p>
        <Link href="/register" className="btn-primary reference-primary-cta">
          เริ่มใช้งาน StoreOS
        </Link>
      </section>

      <MarketingFooter />
    </main>
  );
}
