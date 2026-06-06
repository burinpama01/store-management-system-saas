import Link from "next/link";

export const metadata = {
  title: "StoreOS — ระบบจัดการร้านครบวงจร POS, QR Ordering, รายงาน",
  description:
    "StoreOS ระบบจัดการร้านอาหาร คาเฟ่ บุฟเฟต์ และหลายสาขา — POS, QR ordering, สต็อก, ลงเวลา, รายงาน และชำระค่าบริการผ่าน PromptPay",
};

const FEATURES = [
  { title: "POS หน้าร้าน", desc: "ขายเร็ว ตัวเลือกสินค้า ใบเสร็จ คืนเงิน/ยกเลิกบิล" },
  { title: "QR Ordering", desc: "ลูกค้าสั่งเองที่โต๊ะ ลดพนักงาน รองรับบุฟเฟต์" },
  { title: "สต็อก & บัญชี", desc: "รายรับ-รายจ่าย เงินสด สต็อกสินค้า แจ้งเตือนของใกล้หมด" },
  { title: "ลงเวลา & คอมมิชชั่น", desc: "พนักงานลงเวลา GPS คำนวณค่าแรง/คอมมิชชั่น" },
  { title: "รายงานเรียลไทม์", desc: "ยอดขาย สินค้าขายดี วิธีชำระเงิน รายงานพนักงาน" },
  { title: "หลายสาขา", desc: "จัดการหลายร้านในที่เดียว สลับสาขา สิทธิ์รายคน" },
];

export default function LandingPage() {
  return (
    <main className="min-h-screen bg-[var(--canvas)]">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <div className="brand p-0">
          <div className="brand-mark">S</div>
          <div>
            <div className="brand-name">StoreOS</div>
            <div className="brand-sub">ระบบจัดการร้าน</div>
          </div>
        </div>
        <nav className="flex items-center gap-2">
          <Link href="/pricing" className="hidden text-sm font-bold text-[var(--ink-2)] hover:text-[var(--tenant-primary-strong)] sm:inline">
            แพ็กเกจ
          </Link>
          <Link href="/login" className="btn-secondary text-sm">เข้าสู่ระบบ</Link>
          <Link href="/register" className="btn-primary text-sm">สมัครใช้งาน</Link>
        </nav>
      </header>

      <section className="mx-auto max-w-4xl px-6 pb-6 pt-10 text-center">
        <span className="badge badge-brand mb-4">เน้นร้านไทย · ชำระผ่าน PromptPay</span>
        <h1 className="text-4xl font-extrabold leading-tight text-[var(--ink)] sm:text-6xl">
          ร้านเดียวก็สวยได้ หลายสาขาก็คุมง่าย
        </h1>
        <p className="mx-auto mt-5 max-w-2xl text-lg leading-8 text-[var(--ink-2)]">
          POS, QR ordering, สต็อก, ลงเวลา และรายงาน ครบในระบบเดียว ออกแบบใหม่เพื่อร้านอาหาร
          คาเฟ่ และบุฟเฟต์ เริ่มใช้งานได้ทันที จ่ายรายเดือนหรือรายปีตามที่เลือก
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link href="/register" className="btn-primary px-6 py-3 text-base">เริ่มใช้งานฟรี</Link>
          <Link href="/pricing" className="btn-secondary px-6 py-3 text-base">ดูแพ็กเกจและราคา</Link>
        </div>
      </section>

      <section className="mx-auto grid max-w-6xl gap-4 px-6 py-12 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((f) => (
          <div key={f.title} className="panel p-5">
            <h2 className="text-base font-extrabold text-[var(--ink)]">{f.title}</h2>
            <p className="mt-2 text-sm text-[var(--muted)]">{f.desc}</p>
          </div>
        ))}
      </section>

      <section className="mx-auto max-w-4xl px-6 pb-16 text-center">
        <div className="panel p-8">
          <h2 className="text-2xl font-extrabold text-[var(--ink)]">พร้อมเปิดร้านบนระบบเดียว?</h2>
          <p className="mt-2 text-[var(--ink-2)]">สมัครเป็นเจ้าของร้าน สร้างสาขาแรกได้ใน 1 นาที</p>
          <Link href="/register" className="btn-primary mt-5 inline-block px-6 py-3 text-base">
            สมัครใช้งาน
          </Link>
        </div>
      </section>

      <footer className="border-t border-[var(--border)] py-8 text-center text-xs text-[var(--muted)]">
        © StoreOS · ระบบจัดการร้านครบวงจร ·{" "}
        <Link href="/login" className="font-bold text-[var(--tenant-primary-strong)]">เข้าสู่ระบบ</Link>
      </footer>
    </main>
  );
}
