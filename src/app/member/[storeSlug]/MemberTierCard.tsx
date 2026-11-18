import type { MemberTierCoupon, MemberTierView } from "@/modules/member-tiers/repository";
import { cycleEnd, describeBenefit, tierProgress, type TierProgressLine } from "@/modules/member-tiers/rules";

const money = (value: number) => new Intl.NumberFormat("th-TH", { maximumFractionDigits: 0 }).format(value);

function formatThaiDate(iso: string) {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("th-TH", { timeZone: "Asia/Bangkok", day: "numeric", month: "short", year: "numeric" }).format(
    new Date(`${iso}T00:00:00+07:00`),
  );
}

function Progress({ line }: { line: TierProgressLine }) {
  const pct = line.target > 0 ? Math.min(100, Math.round((line.current / line.target) * 100)) : 100;
  const fmt = (value: number) => (line.unit === "baht" ? `฿${money(value)}` : money(value));
  return (
    <div>
      <p className="text-xs text-[var(--muted)]">{line.label}</p>
      <p className="text-base font-bold tabular-nums text-[var(--foreground)]">
        {fmt(line.current)}
        <span className="text-xs font-normal text-[var(--muted)]">/{fmt(line.target)}</span>
      </p>
      <div className="mt-1 h-1.5 overflow-hidden rounded bg-[var(--canvas-2)]">
        <div className="h-full bg-[var(--tenant-primary)]" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** การ์ดระดับสมาชิกแบบหน้าจอ Shopee Rewards: ระดับปัจจุบัน + เพื่อรักษาระดับ + อีกเท่าไรถึงระดับถัดไป */
export function MemberTierCard({ view, coupons = [] }: { view: MemberTierView; coupons?: MemberTierCoupon[] }) {
  const { program, tier } = view;
  const progress = tierProgress(program.metricMode, program.tiers, view.rank, view.cycleSpend, view.cycleOrders);
  const end = view.cycleStart ? cycleEnd(view.cycleStart, program.cycleMonths) : "";

  return (
    <section className="overflow-hidden rounded-lg border border-[var(--border)] bg-white shadow-sm" aria-label="ระดับสมาชิก">
      <div className="p-4 text-white" style={{ background: `linear-gradient(135deg, ${tier.color}, #1d1b18)` }}>
        <p className="text-xs opacity-80">ระดับสมาชิกของคุณ</p>
        <p className="text-3xl font-black tracking-wide">{tier.name.toUpperCase()}</p>
        {view.locked && <p className="text-xs opacity-80">ร้านตั้งระดับนี้ให้คุณ</p>}
      </div>
      <div className="flex gap-1 px-4 pt-3">
        {program.tiers.map((t) => (
          <div
            key={t.rank}
            className="flex-1 rounded py-1 text-center text-[10px] font-bold"
            style={t.rank === view.rank ? { background: t.color, color: "#fff" } : { background: "#ece8e0", color: "#8b857a" }}
          >
            {t.name}
          </div>
        ))}
      </div>
      <div className="space-y-3 p-4">
        {progress.keep.length > 0 && (
          <div>
            <p className="text-sm font-semibold text-[var(--tenant-primary-strong)]">
              เพื่อรักษาระดับในรอบนี้{program.metricMode === "either" ? " (ถึงอย่างใดอย่างหนึ่งก็พอ)" : ""}
            </p>
            <div className="mt-1 grid grid-cols-2 gap-3">
              {progress.keep.map((line) => (
                <Progress key={line.label} line={line} />
              ))}
            </div>
          </div>
        )}
        {progress.next && (
          <div>
            <p className="text-sm font-semibold text-[var(--foreground)]">ถึงระดับ {progress.next.tier.name}</p>
            <div className="mt-1 grid grid-cols-2 gap-3">
              {progress.next.lines.map((line) => (
                <Progress key={line.label} line={line} />
              ))}
            </div>
          </div>
        )}
        {coupons.length > 0 && (
          <div>
            <p className="text-sm font-semibold text-[var(--foreground)]">โค้ดพิเศษสำหรับคุณเดือนนี้</p>
            <div className="mt-1 space-y-2">
              {coupons.map((coupon) => (
                <div key={coupon.benefitId} className="flex overflow-hidden rounded-lg border border-[var(--border)]">
                  <div className="flex w-16 shrink-0 items-center justify-center text-[10px] font-bold text-white" style={{ background: tier.color }}>
                    {tier.name}
                  </div>
                  <div className="min-w-0 flex-1 p-2">
                    <p className="text-sm font-semibold text-[var(--foreground)]">{coupon.name}</p>
                    <p className="text-xs text-[var(--muted)]">
                      {describeBenefit(coupon)} · เหลือ {coupon.remaining}/{coupon.usesPerMonth} ครั้งเดือนนี้
                    </p>
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-1 text-xs text-[var(--muted)]">ใช้ที่ร้าน: กด “แสดงรหัสใช้สิทธิ์” แล้วให้แคชเชียร์สแกนรหัส 6 หลัก — แคชเชียร์จะเห็นสิทธิ์นี้และกดใช้ให้</p>
          </div>
        )}
        {end && <p className="text-xs text-[var(--muted)]">รอบนี้สิ้นสุด {formatThaiDate(end)} — ยอดสะสมเริ่มนับใหม่ทุกรอบ ขึ้นระดับทันทีเมื่อถึงเกณฑ์</p>}
      </div>
    </section>
  );
}
