import Link from "next/link";

export const metadata = {
  title: "แพ็กเกจและราคา · StoreOS",
  description: "เลือกแพ็กเกจ StoreOS สำหรับร้านอาหาร คาเฟ่ บุฟเฟต์ และร้านหลายสาขา",
};

const PLANS = [
  {
    name: "Starter",
    price: "490–690",
    target: "ร้านอาหารทั่วไป / คาเฟ่ขนาดเล็ก",
    highlights: ["POS พื้นฐาน", "รายรับ-รายจ่าย", "พิมพ์ใบเสร็จผ่าน Browser", "บันทึกประวัติลูกค้า"],
    featured: false,
  },
  {
    name: "Standard",
    price: "990–1,290",
    target: "ร้านบุฟเฟต์ / หมูกระทะ (ไม่มี QR)",
    highlights: ["ทุกอย่างใน Starter", "ระบบจัดการบุฟเฟต์", "ระบบสต็อกสินค้า", "พิมพ์ Bluetooth/USB/IP"],
    featured: false,
  },
  {
    name: "Premium",
    price: "1,590–2,290",
    target: "ร้านบุฟเฟต์ที่ต้องการลดพนักงาน",
    highlights: ["ทุกอย่างใน Standard", "QR Food Ordering", "LINE Notify", "ลงเวลา GPS + คอมมิชชั่น"],
    featured: true,
  },
  {
    name: "Enterprise",
    price: "Custom",
    target: "ร้านที่มีหลายสาขา",
    highlights: ["จัดการสาขาแบบศูนย์กลาง", "รายงานรวมหลายสาขา", "API Integration", "Support พิเศษ"],
    featured: false,
  },
];

export default function PricingPage() {
  return (
    <main className="min-h-screen bg-[var(--canvas)]">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <Link href="/pricing" className="brand p-0">
          <div className="brand-mark">S</div>
          <div>
            <div className="brand-name">StoreOS</div>
            <div className="brand-sub">ระบบจัดการร้าน</div>
          </div>
        </Link>
        <div className="flex items-center gap-2">
          <Link href="/login" className="btn-secondary text-sm">
            เข้าสู่ระบบ
          </Link>
          <Link href="/register" className="btn-primary text-sm">
            สมัครใช้งาน
          </Link>
        </div>
      </header>

      <section className="mx-auto max-w-3xl px-6 pt-8 text-center">
        <span className="badge badge-brand mb-3">แพ็กเกจและราคา</span>
        <h1 className="text-4xl font-extrabold leading-tight text-[var(--ink)] sm:text-5xl">
          เลือกแพ็กเกจที่เหมาะกับร้านของคุณ
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-lg text-[var(--ink-2)]">
          POS, QR ordering, รายงาน, ทีมงาน และระบบจัดการหลายสาขา เริ่มต้นได้ทันทีและอัปเกรดเมื่อร้านโต
        </p>
      </section>

      <section className="mx-auto grid max-w-6xl gap-4 px-6 py-10 md:grid-cols-2 xl:grid-cols-4">
        {PLANS.map((plan) => (
          <div
            key={plan.name}
            className={`flex flex-col rounded-[var(--radius-lg)] border p-5 ${
              plan.featured
                ? "border-[var(--tenant-primary)] bg-[var(--tenant-primary-soft)] shadow-sm"
                : "border-[var(--border)] bg-[var(--surface)]"
            }`}
          >
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-lg font-extrabold text-[var(--ink)]">{plan.name}</p>
              {plan.featured && <span className="badge badge-brand">แนะนำ</span>}
            </div>
            <p className="text-2xl font-extrabold text-[var(--tenant-primary-strong)]">
              {plan.price}
              {plan.price !== "Custom" && <span className="text-sm font-bold"> บาท/เดือน</span>}
            </p>
            <p className="mt-1 text-xs text-[var(--muted)]">{plan.target}</p>
            <ul className="mt-4 flex-1 space-y-2">
              {plan.highlights.map((h) => (
                <li key={h} className="text-sm text-[var(--ink-2)]">• {h}</li>
              ))}
            </ul>
            <Link
              href={plan.name === "Enterprise" ? "mailto:sales@storeos.app?subject=Enterprise%20Quote" : "/register"}
              className={`mt-5 w-full text-center text-sm ${plan.featured ? "btn-primary" : "btn-secondary"}`}
            >
              {plan.name === "Enterprise" ? "ติดต่อฝ่ายขาย" : "เริ่มใช้งาน"}
            </Link>
          </div>
        ))}
      </section>

      <footer className="mx-auto max-w-6xl px-6 py-10 text-center text-xs text-[var(--muted)]">
        ราคายังไม่รวมภาษีมูลค่าเพิ่ม · เปลี่ยน/ยกเลิกแพ็กเกจได้ทุกเมื่อผ่าน Customer Portal
      </footer>
    </main>
  );
}
