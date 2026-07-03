import Link from "next/link";
import { LandingWorkflow } from "@/shared/components/marketing/LandingWorkflow";
import { MarketingFooter, MarketingHeader } from "@/shared/components/marketing/MarketingShell";
import { MarketingProductShowcase } from "@/shared/components/marketing/MarketingProductShowcase";

export const metadata = {
  title: "StoreOS - ระบบจัดการร้านครบวงจร POS, QR Ordering, รายงาน",
  description:
    "StoreOS ระบบจัดการร้านอาหาร คาเฟ่ บุฟเฟต์ และหลายสาขา ครบทั้ง POS, QR ordering, สต็อก, ลงเวลา, รายงาน และการชำระเงิน",
};

const FEATURE_CHIPS = ["POS", "QR Ordering", "สต็อก", "ลงเวลา", "รายงาน", "หลายสาขา"];

const FLOW_STEPS = [
  {
    title: "POS",
    detail: "ขายหน้าร้าน รวดเร็ว แม่นยำ",
    bullets: ["สั่งอาหารและชำระเงิน", "พิมพ์ใบเสร็จ", "แยกการชำระเงิน", "ส่วนลดและโปรโมชัน"],
    image: {
      desktop: "/marketing/workflow/pos-desktop.png",
      mobile: "/marketing/workflow/pos-mobile.png",
    },
  },
  {
    title: "QR Ordering",
    detail: "ลูกค้าสั่งเอง ลดงานหน้าร้าน",
    bullets: ["เปิดเมนูผ่าน QR", "รับออเดอร์เข้าระบบทันที", "ลดการจดผิด", "เชื่อมต่อโต๊ะและสถานะอาหาร"],
    image: {
      desktop: "/marketing/workflow/qr-ordering-desktop.png",
      mobile: "/marketing/workflow/qr-ordering-mobile.png",
    },
  },
  {
    title: "สต็อกสินค้า",
    detail: "รู้ของคงเหลือและจุดสั่งเพิ่ม",
    bullets: ["ตั้งจุดเตือนสต็อกต่ำ", "เชื่อมการขายกับวัตถุดิบ", "ดูรายการที่ต้องเติม", "ลดของขาดช่วงขายจริง"],
    image: {
      desktop: "/marketing/workflow/stock-desktop.png",
      mobile: "/marketing/workflow/stock-mobile.png",
    },
  },
  {
    title: "ลงเวลา",
    detail: "เช็กอินพนักงานและวันหยุดร้าน",
    bullets: ["บันทึกเวลาเข้างาน", "รองรับกะและวันหยุด", "ดูสถานะวันนี้", "ลดงานเอกสารของผู้จัดการ"],
    image: {
      desktop: "/marketing/workflow/attendance-desktop.png",
      mobile: "/marketing/workflow/attendance-mobile.png",
    },
  },
  {
    title: "รายงาน",
    detail: "ยอดขาย กำไร สลิป และสินค้าเด่น",
    bullets: ["สรุปยอดขายรายวัน", "ติดตามกำไรและต้นทุน", "ตรวจสลิปและการชำระเงิน", "เห็นเมนูขายดีเร็วขึ้น"],
    image: {
      desktop: "/marketing/workflow/reports-desktop.png",
      mobile: "/marketing/workflow/reports-mobile.png",
    },
  },
  {
    title: "หลายสาขา",
    detail: "บริหารทุกสาขาจากศูนย์กลาง",
    bullets: ["แยกข้อมูลตามสาขา", "ดูภาพรวมรวมศูนย์", "ตั้งสิทธิ์ทีมตามหน้าที่", "ขยายร้านโดยไม่เปลี่ยนระบบ"],
    image: {
      desktop: "/marketing/workflow/branches-desktop.png",
      mobile: "/marketing/workflow/branches-mobile.png",
    },
  },
];

const TRUST_ITEMS = [
  { title: "ใช้งานง่าย", detail: "ออกแบบเพื่อร้านอาหารจริง" },
  { title: "ปลอดภัย", detail: "แยกข้อมูลตาม tenant" },
  { title: "เชื่อมต่อครบ", detail: "POS, QR, PromptPay, รายงาน" },
  { title: "ทีมเห็นข้อมูลตรงกัน", detail: "เจ้าของ แอดมิน และพนักงาน" },
];

export default function LandingPage() {
  return (
    <main className="marketing-page">
      <MarketingHeader />

      <section className="reference-hero">
        <div className="reference-hero-copy">
          <h1>
            StoreOS
            <span>ระบบจัดการร้าน</span>
          </h1>
          <p className="reference-hero-lead">ครบ จบ ในระบบเดียว</p>
          <div className="reference-chip-row" aria-label="ฟีเจอร์หลัก">
            {FEATURE_CHIPS.map((chip) => (
              <span key={chip}>{chip}</span>
            ))}
          </div>
          <p className="reference-hero-sub">
            เพิ่มประสิทธิภาพร้านอาหาร คาเฟ่ และบุฟเฟต์ จัดการทุกงานหลังร้าน ให้คุณโฟกัสที่ลูกค้าได้มากขึ้น
          </p>
          <div className="reference-actions">
            <Link href="/register" className="btn-primary reference-primary-cta">
              ทดลอง Premium ฟรี 30 วัน
              <span aria-hidden="true">→</span>
            </Link>
            <Link href="/pricing" className="btn-secondary reference-secondary-cta">
              ดูแพ็กเกจและราคา
            </Link>
          </div>
          <small className="reference-note">สำหรับลูกค้าใหม่ ใช้ได้ 1 ครั้งต่อบัญชี</small>
        </div>

        <MarketingProductShowcase variant="hero" className="reference-hero-visual" />
        <div className="reference-scroll-hint" aria-hidden="true">
          <span>เลื่อนลงเพื่อดูฟีเจอร์ทั้งหมด</span>
          <i>⌄</i>
        </div>
      </section>

      <section className="reference-flow" id="features">
        <div className="reference-section-heading">
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
