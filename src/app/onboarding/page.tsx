import Link from "next/link";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";

export const dynamic = "force-dynamic";

const STEPS = [
  {
    href: "/settings/store",
    title: "ตั้งค่าข้อมูลร้าน",
    desc: "ชื่อร้าน ที่อยู่ เบอร์โทร timezone และสกุลเงิน",
  },
  {
    href: "/catalog",
    title: "เพิ่มเมนูสินค้า",
    desc: "สร้างหมวดหมู่ สินค้า ตัวเลือก และราคาเพื่อเริ่มขาย",
  },
  {
    href: "/settings/team",
    title: "เชิญทีมงาน",
    desc: "เพิ่ม admin/manager/cashier/staff และกำหนดสิทธิ์ราย store",
  },
  {
    href: "/settings/billing",
    title: "เลือกแพ็กเกจ",
    desc: "อัปเกรดเพื่อเปิดฟีเจอร์บุฟเฟต์ QR ordering และรายงานขั้นสูง",
  },
];

export default async function OnboardingPage() {
  const { ctx } = await getResolvedCurrentPermissions();

  return (
    <main className="min-h-screen bg-[var(--canvas)]">
      <div className="mx-auto max-w-3xl px-6 py-10">
        <span className="badge badge-brand mb-3">ยินดีต้อนรับ</span>
        <h1 className="text-3xl font-extrabold text-[var(--ink)]">
          เริ่มต้นใช้งาน {ctx.orgName}
        </h1>
        <p className="mt-2 text-[var(--ink-2)]">
          ร้าน <strong>{ctx.storeName}</strong> ถูกสร้างเรียบร้อยแล้ว ทำตามขั้นตอนด้านล่างเพื่อเตรียมเปิดร้าน
        </p>

        <div className="mt-6 space-y-3">
          {STEPS.map((step, i) => (
            <Link
              key={step.href}
              href={step.href}
              className="flex items-start gap-4 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] p-4 transition-colors hover:border-[var(--tenant-primary)]"
            >
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[var(--tenant-primary-soft)] text-sm font-extrabold text-[var(--tenant-primary-strong)]">
                {i + 1}
              </span>
              <div className="min-w-0">
                <p className="font-bold text-[var(--ink)]">{step.title}</p>
                <p className="text-sm text-[var(--muted)]">{step.desc}</p>
              </div>
            </Link>
          ))}
        </div>

        <Link href="/dashboard" className="btn-primary mt-6 inline-block">
          ไปที่แดชบอร์ด
        </Link>
      </div>
    </main>
  );
}
