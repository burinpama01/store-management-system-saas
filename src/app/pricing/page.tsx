import Link from "next/link";
import { getPublicPricing } from "@/modules/billing/pricing-repository";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "แพ็กเกจและราคา · StoreOS",
  description: "เลือกแพ็กเกจ StoreOS สำหรับร้านอาหาร คาเฟ่ บุฟเฟต์ และร้านหลายสาขา",
};

export default async function PricingPage() {
  const plans = await getPublicPricing();

  return (
    <main className="min-h-screen bg-[var(--canvas)]">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <Link href="/" className="brand p-0">
          <div className="brand-mark">S</div>
          <div>
            <div className="brand-name">StoreOS</div>
            <div className="brand-sub">ระบบจัดการร้าน</div>
          </div>
        </Link>
        <div className="flex items-center gap-2">
          <Link href="/login" className="btn-secondary text-sm">เข้าสู่ระบบ</Link>
          <Link href="/register" className="btn-primary text-sm">สมัครใช้งาน</Link>
        </div>
      </header>

      <section className="mx-auto max-w-3xl px-6 pt-8 text-center">
        <span className="badge badge-brand mb-3">แพ็กเกจและราคา</span>
        <h1 className="text-4xl font-extrabold leading-tight text-[var(--ink)] sm:text-5xl">
          เลือกแพ็กเกจที่เหมาะกับร้านของคุณ
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-lg text-[var(--ink-2)]">
          ลูกค้าใหม่รับ Premium ฟรี 30 วันได้ 1 ครั้ง · POS, QR ordering, รายงาน, ทีมงาน และระบบจัดการหลายสาขา ครบในที่เดียว
        </p>
      </section>

      <section className="mx-auto grid max-w-6xl gap-4 px-6 py-10 md:grid-cols-2 xl:grid-cols-4">
        {plans.map((plan) => {
          const isEnterprise = plan.price30d == null;
          const isPremium = plan.tier === "premium";
          return (
            <div
              key={plan.tier}
              className={`flex flex-col rounded-[var(--radius-lg)] border p-5 ${
                plan.highlight
                  ? "border-[var(--tenant-primary)] bg-[var(--tenant-primary-soft)] shadow-sm"
                  : "border-[var(--border)] bg-[var(--surface)]"
              }`}
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="text-lg font-extrabold text-[var(--ink)]">{plan.displayName}</p>
                {plan.highlight && <span className="badge badge-brand">แนะนำ</span>}
              </div>
              <p className="text-2xl font-extrabold text-[var(--tenant-primary-strong)]">
                {isEnterprise ? "Custom" : isPremium ? "0" : plan.price30d?.toLocaleString()}
                {!isEnterprise && (
                  <span className="text-sm font-bold">
                    {isPremium ? " บาท / 30 วันแรก" : " บาท/เดือน"}
                  </span>
                )}
              </p>
              {isPremium && plan.price30d != null && (
                <p className="mt-1 text-xs font-bold text-[var(--tenant-primary-strong)]">
                  หลังใช้โปรแล้ว {plan.price30d.toLocaleString()} บาท/เดือน
                </p>
              )}
              {!isEnterprise && plan.price1y != null && (
                <p className="mt-1 text-xs text-[var(--muted)]">หรือ {plan.price1y.toLocaleString()} บาท/ปี</p>
              )}
              <ul className="mt-4 flex-1 space-y-2">
                {plan.featureLines.map((f) => (
                  <li key={f} className="text-sm text-[var(--ink-2)]">• {f}</li>
                ))}
              </ul>
              <Link
                href={isEnterprise ? "mailto:sales@storeos.app?subject=Enterprise%20Quote" : "/register"}
                className={`mt-5 w-full text-center text-sm ${plan.highlight ? "btn-primary" : "btn-secondary"}`}
              >
                {isEnterprise ? "ติดต่อฝ่ายขาย" : "เริ่มใช้งาน"}
              </Link>
            </div>
          );
        })}
      </section>

      <footer className="mx-auto max-w-6xl px-6 py-10 text-center text-xs text-[var(--muted)]">
        ราคายังไม่รวมภาษีมูลค่าเพิ่ม · โปร Premium ฟรี 30 วันใช้ได้ 1 ครั้งต่อบัญชี · เปลี่ยน/ยกเลิกแพ็กเกจได้ทุกเมื่อ
      </footer>
    </main>
  );
}
