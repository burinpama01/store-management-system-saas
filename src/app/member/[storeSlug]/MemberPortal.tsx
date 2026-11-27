"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { CustomerPortalData, CustomerRewardRedemption } from "@/modules/customers/member-repository";
import type { LoyaltyReward } from "@/modules/loyalty/repository";
import {
  claimReceiptPointsAction,
  redeemMemberRewardAction,
  signOutMemberAction,
  requestMemberOtpAction,
  verifyMemberOtpAction,
} from "./actions";
import { Button } from "@/shared/components/ui";
import { MemberRedeemCodeCard } from "./MemberRedeemCodeCard";
import { MemberPassesCard } from "./MemberPassesCard";
import type { MemberPassesView } from "@/modules/prepaid-passes/member-portal";
import type { MemberTierCoupon, MemberTierView } from "@/modules/member-tiers/repository";
import { MemberTierCard } from "./MemberTierCard";
import { MemberMissionsCard } from "./MemberMissionsCard";
import type { MemberMissionsView } from "@/modules/missions/repository";

const RESEND_COOLDOWN_SECONDS = 60;

interface Props {
  storeSlug: string;
  portalCode: string;
  /** รหัสรับแต้มจาก QR ท้ายใบเสร็จ (?claim=) — null = เข้ามาปกติ */
  claimCode: string | null;
  data: CustomerPortalData;
  /** แพ็กของฉัน — null = ยังไม่ล็อกอิน */
  passesView?: MemberPassesView | null;
  /** ระดับสมาชิก — null = ร้านไม่ได้เปิดใช้/ยังไม่ล็อกอิน */
  tierView?: MemberTierView | null;
  /** โค้ดพิเศษเดือนนี้ตามระดับ */
  tierCoupons?: MemberTierCoupon[];
  /** ภารกิจสะสม — null = ร้านไม่ได้เปิด/ยังไม่ล็อกอิน */
  missionsView?: MemberMissionsView | null;
  /** สั่งออนไลน์จากหน้าสมาชิก — null = ร้านไม่ได้เปิด/ยังไม่ล็อกอิน */
  onlineOrderHref?: string | null;
}

interface RedeemedVoucher {
  code: string;
  rewardType: "discount" | "product";
  rewardName: string;
  discountKind: "amount" | "percentage" | null;
  discountValue: number | null;
  expiresAt: string;
}

function formatPoints(value: number) {
  return new Intl.NumberFormat("th-TH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "numeric" });
}

function discountLabel(kind: "amount" | "percentage" | null, value: number | null) {
  if (value === null || value === undefined) return null;
  return kind === "percentage" ? `ลด ${value}%` : `ลด ${formatPoints(value)} บาท`;
}

function rewardTypeBadge(reward: LoyaltyReward) {
  if (reward.rewardType === "discount") {
    return discountLabel(reward.discountKind ?? null, reward.discountValue ?? null) ?? "ส่วนลด";
  }
  return "ของรางวัล";
}

/** คูปองยังใช้ได้ (ตัดสินจากสถานะจริง ไม่ใช่จากข้อความป้าย) */
function isRedemptionReady(redemption: CustomerRewardRedemption, now = Date.now()): boolean {
  if (redemption.usedAt || redemption.status === "fulfilled" || redemption.status === "cancelled") return false;
  return !(redemption.expiresAt && new Date(redemption.expiresAt).getTime() < now);
}

function redemptionStatusBadge(redemption: CustomerRewardRedemption): { label: string; className: string } {
  if (redemption.usedAt || redemption.status === "fulfilled") {
    return { label: "ใช้แล้ว", className: "border-slate-200 bg-slate-100 text-slate-600" };
  }
  if (redemption.status === "cancelled") {
    return { label: "ยกเลิก", className: "border-slate-200 bg-slate-100 text-slate-500" };
  }
  if (redemption.expiresAt && new Date(redemption.expiresAt).getTime() < Date.now()) {
    return { label: "หมดอายุ", className: "border-red-200 bg-red-50 text-red-600" };
  }
  return { label: "ใช้ได้", className: "border-emerald-200 bg-emerald-50 text-emerald-700" };
}

function StatusMessage({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800">
      {message}
    </div>
  );
}

type PortalView = "home" | "missions" | "code" | "coupons" | "member";

const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;

/** สีหลักตามธีมของร้าน — ตั้งทั้ง --tenant-* และ --color-brand* ให้การ์ดลูกที่ใช้ตัวแปรเดิมเปลี่ยนสีตามด้วย */
function storeThemeStyle(store: CustomerPortalData["store"]): React.CSSProperties | undefined {
  const primary = store?.themePrimaryColor;
  if (!primary || !HEX_COLOR_RE.test(primary)) return undefined;
  const strong = store?.themePrimaryStrongColor && HEX_COLOR_RE.test(store.themePrimaryStrongColor) ? store.themePrimaryStrongColor : primary;
  const soft = store?.themePrimarySoftColor && HEX_COLOR_RE.test(store.themePrimarySoftColor) ? store.themePrimarySoftColor : `${primary}1f`;
  return {
    "--tenant-primary": primary,
    "--tenant-primary-strong": strong,
    "--tenant-primary-soft": soft,
    "--color-brand": primary,
    "--color-brand-hover": strong,
    "--color-brand-soft": soft,
  } as React.CSSProperties;
}

function redemptionSource(redemption: CustomerRewardRedemption): string {
  return redemption.pointsSpent > 0 ? `แลกแต้ม · ${formatPoints(redemption.pointsSpent)} แต้ม` : "จากภารกิจ";
}

/** คูปองทรงตั๋ว (รอยปรุ) — แตะเพื่อเปิดรายละเอียด/โค้ดแลกรับ */
function CouponTicket({ redemption, onOpen, faded = false }: { redemption: CustomerRewardRedemption; onOpen: () => void; faded?: boolean }) {
  const badge = redemptionStatusBadge(redemption);
  const isDiscount = redemption.rewardType === "discount";
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`relative flex w-full rounded-xl border border-[var(--border)] bg-white text-left ${faded ? "opacity-60" : ""}`}
    >
      <span className="absolute -top-2 left-[64px] h-4 w-4 rounded-full border border-[var(--border)] bg-[var(--canvas)]" aria-hidden />
      <span className="absolute -bottom-2 left-[64px] h-4 w-4 rounded-full border border-[var(--border)] bg-[var(--canvas)]" aria-hidden />
      <span className="flex w-[72px] shrink-0 items-center justify-center border-r-2 border-dashed border-[var(--border-strong)] text-2xl">
        {redemption.rewardImageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={redemption.rewardImageUrl} alt="" className="h-12 w-12 rounded-lg object-cover" />
        ) : isDiscount ? (
          "🏷️"
        ) : (
          "🎁"
        )}
      </span>
      <span className="min-w-0 flex-1 p-3">
        <span className="block text-[11px] text-[var(--muted)]">{redemptionSource(redemption)}</span>
        <span className="block truncate text-sm font-semibold text-[var(--foreground)]">{redemption.rewardName}</span>
        <span className="mt-1 flex items-center justify-between gap-2 text-[11px] text-[var(--muted)]">
          <span>{redemption.usedAt ? `ใช้เมื่อ ${formatDate(redemption.usedAt)}` : `ใช้ได้ถึง ${formatDate(redemption.expiresAt)}`}</span>
          <span className={`shrink-0 rounded-full border px-2 py-0.5 font-semibold ${badge.className}`}>{badge.label}</span>
        </span>
      </span>
    </button>
  );
}

function EmptyPanel({ icon, title, text }: { icon: string; title: string; text: string }) {
  return (
    <div className="rounded-xl border border-dashed border-[var(--border)] bg-white p-6 text-center">
      <p className="text-3xl" aria-hidden>{icon}</p>
      <p className="mt-2 font-semibold text-[var(--foreground)]">{title}</p>
      <p className="mt-1 text-sm text-[var(--muted)]">{text}</p>
    </div>
  );
}

export function MemberPortal({
  storeSlug,
  portalCode,
  claimCode,
  data,
  passesView = null,
  tierView = null,
  tierCoupons = [],
  missionsView = null,
  onlineOrderHref = null,
}: Props) {
  const router = useRouter();
  const [mode, setMode] = useState<"register" | "login">("register");
  const [otpId, setOtpId] = useState<string | null>(null);
  const [maskedPhone, setMaskedPhone] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(data.error);
  const [isPending, startTransition] = useTransition();
  // แท็บของหน้าสมาชิก (แถบล่าง) — เริ่มที่หน้าแรกเสมอ
  const [view, setView] = useState<PortalView>("home");
  const [couponTab, setCouponTab] = useState<"ready" | "past">("ready");
  // เวลาอ้างอิงตอนเปิดหน้า สำหรับแยกคูปองพร้อมใช้/หมดอายุ (ไม่เรียก Date.now ระหว่าง render)
  const [renderNow] = useState(() => Date.now());
  const [voucher, setVoucher] = useState<RedeemedVoucher | null>(null);
  // รับแต้มจากใบเสร็จ: null = ยังไม่ได้กด, ที่เหลือคือผลลัพธ์ที่แสดงค้างไว้
  const [claimResult, setClaimResult] = useState<{ points: number; orderNumber: string } | null>(null);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [detail, setDetail] = useState<CustomerRewardRedemption | null>(null);
  const sortedRewards = useMemo(
    () => [...data.rewards].sort((a, b) => a.pointsCost - b.pointsCost),
    [data.rewards],
  );

  function signOut(formData: FormData) {
    startTransition(async () => {
      await signOutMemberAction(formData);
      // เซิร์ฟเวอร์ revalidate แล้ว แต่คอมโพเนนต์นี้ถือ data เป็น prop จึงต้องสั่งโหลดใหม่
      router.refresh();
    });
  }

  function claimReceiptPoints() {
    if (!claimCode) return;
    const formData = new FormData();
    formData.set("storeSlug", storeSlug);
    formData.set("portalCode", portalCode);
    formData.set("claimCode", claimCode);
    startTransition(async () => {
      const result = await claimReceiptPointsAction(formData);
      if (result.error || !result.claimed) {
        setClaimError(result.error ?? "รับแต้มไม่สำเร็จ");
        return;
      }
      setClaimError(null);
      setClaimResult({ points: result.claimed.points, orderNumber: result.claimed.orderNumber });
    });
  }

  // นับถอยหลังก่อนขอรหัสใหม่ (ฝั่งเซิร์ฟเวอร์บังคับ 60 วิเหมือนกัน)
  const [resendIn, setResendIn] = useState(0);
  const lastOtpRequest = useRef<FormData | null>(null);
  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = window.setTimeout(() => setResendIn((value) => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [resendIn]);

  function requestOtp(formData: FormData) {
    startTransition(async () => {
      const result = await requestMemberOtpAction(formData);
      setMessage(result.error ?? `ส่ง OTP ไปที่ ${result.maskedPhone ?? "เบอร์ของคุณ"} แล้ว`);
      if (!result.error && result.otpId) {
        lastOtpRequest.current = formData;
        setOtpId(result.otpId);
        setMaskedPhone(result.maskedPhone ?? null);
        setResendIn(RESEND_COOLDOWN_SECONDS);
      }
    });
  }

  function resendOtp() {
    if (resendIn > 0 || !lastOtpRequest.current) return;
    requestOtp(lastOtpRequest.current);
  }

  function verifyOtp(formData: FormData) {
    startTransition(async () => {
      const result = await verifyMemberOtpAction(formData);
      setMessage(result.error ?? result.notice ?? "เข้าสู่ระบบสมาชิกแล้ว");
      if (!result.error) {
        setOtpId(null);
        // มีข้อความต้องอ่าน (เช่น เข้าบัญชีเดิม) — อย่ารีโหลดทับจนอ่านไม่ทัน
        if (result.notice) {
          router.refresh();
          return;
        }
        window.location.reload();
      }
    });
  }

  function redeemReward(formData: FormData) {
    startTransition(async () => {
      const result = await redeemMemberRewardAction(formData);
      if (result.error) {
        setMessage(result.error);
        return;
      }
      setMessage(null);
      if (result.voucher) {
        setVoucher(result.voucher);
      } else {
        window.location.reload();
      }
    });
  }

  function closeVoucher() {
    setVoucher(null);
    window.location.reload();
  }

  if (!data.portalValid) {
    return (
      <main className="min-h-dvh bg-[var(--canvas)] p-4">
        <div className="mx-auto max-w-md rounded-lg border border-[var(--border)] bg-white p-5 text-center shadow-sm">
          <p className="text-xs font-bold uppercase text-[var(--muted)]">Member Portal</p>
          <h1 className="mt-2 text-xl font-bold text-[var(--foreground)]">ต้องเปิดจาก QR ของร้าน</h1>
          <p className="mt-2 text-sm text-[var(--muted)]">
            {data.error ?? "ลิงก์นี้ใช้ได้เฉพาะ QR ที่ร้านสร้างให้เท่านั้น"}
          </p>
        </div>
      </main>
    );
  }

  const customer = data.customer;
  const store = data.store;
  const themeStyle = storeThemeStyle(store);
  const storeInitials = (store?.name ?? "ร้าน").trim().slice(0, 2);
  const activeMissionCount = missionsView?.missions.filter((m) => m.enrollment?.status === "active").length ?? 0;
  const readyRedemptions = data.redemptions.filter((r) => isRedemptionReady(r, renderNow));
  const pastRedemptions = data.redemptions.filter((r) => !isRedemptionReady(r, renderNow));
  const readyCouponCount = readyRedemptions.length + tierCoupons.filter((c) => c.remaining > 0).length;
  const hasPasses = Boolean(passesView && (passesView.passes.length > 0 || passesView.plans.length > 0));

  const quickActions = (
    [
      { key: "order", icon: "🛵", label: "สั่งออนไลน์", badge: 0, show: Boolean(onlineOrderHref), anchor: null },
      { key: "history", icon: "🧾", label: "ประวัติสั่ง", badge: 0, show: Boolean(onlineOrderHref), anchor: null },
      { key: "missions", icon: "🎯", label: "ภารกิจ", badge: activeMissionCount, show: Boolean(missionsView?.enabled), anchor: null },
      { key: "coupons", icon: "🎟️", label: "คูปอง", badge: readyCouponCount, show: true, anchor: null },
      { key: "member", icon: "☕", label: "แพ็ก", badge: 0, show: hasPasses, anchor: "member-passes" },
      { key: "member", icon: "🎁", label: "แลกแต้ม", badge: 0, show: !data.passesOnly, anchor: "member-rewards" },
    ] as const
  ).filter((item) => item.show);

  function go(next: PortalView, anchor: string | null = null) {
    setView(next);
    if (typeof window === "undefined") return;
    if (!anchor) {
      window.scrollTo({ top: 0 });
      return;
    }
    // รอแท็บใหม่ render ก่อนเลื่อนไปหัวข้อ (แพ็ก / แลกแต้ม อยู่แท็บสมาชิกเดียวกัน)
    window.setTimeout(() => document.getElementById(anchor)?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  }

  const rewardCatalog = (
    <section className="rounded-xl border border-[var(--border)] bg-white p-4 shadow-sm" aria-label="แลกของรางวัล">
      <h2 className="text-base font-bold text-[var(--foreground)]">แลกของรางวัล</h2>
      <p className="mt-0.5 text-xs text-[var(--muted)]">ใช้แต้มสะสมแลกของรางวัลของร้าน — ได้รับเป็นคูปองในแท็บ “คูปอง”</p>
      <div className="mt-3 grid gap-3">
        {sortedRewards.length === 0 ? (
          <p className="rounded-lg border border-dashed border-[var(--border)] p-4 text-sm text-[var(--muted)]">
            ร้านนี้ยังไม่มีของรางวัลให้แลก
          </p>
        ) : (
          sortedRewards.map((reward) => {
            const canRedeem =
              data.customer !== null &&
              data.customer.pointsBalance >= reward.pointsCost &&
              (reward.stockQuantity === null || reward.stockQuantity === undefined || reward.stockQuantity > 0);
            return (
              <form
                key={reward.id}
                action={redeemReward}
                className="grid grid-cols-[56px_1fr_auto] items-center gap-3 rounded-lg border border-[var(--border)] p-3"
              >
                <input type="hidden" name="storeSlug" value={storeSlug} />
                <input type="hidden" name="portalCode" value={portalCode} />
                <input type="hidden" name="rewardId" value={reward.id} />
                {reward.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={reward.imageUrl} alt={reward.name} className="h-14 w-14 rounded-md border border-[var(--border)] object-cover" />
                ) : (
                  <div className="grid h-14 w-14 place-items-center rounded-md bg-[var(--canvas-2)] text-2xl">🎁</div>
                )}
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-bold text-[var(--foreground)]">{reward.name}</p>
                    <span className="rounded-full border border-[var(--border)] px-2 py-0.5 text-[11px] text-[var(--muted)]">
                      {rewardTypeBadge(reward)}
                    </span>
                  </div>
                  {reward.description && <p className="mt-1 text-sm text-[var(--muted)]">{reward.description}</p>}
                  <p className="mt-1 text-sm font-semibold text-[var(--foreground)]">
                    {formatPoints(reward.pointsCost)} แต้ม
                    {reward.stockQuantity !== null && reward.stockQuantity !== undefined ? ` · เหลือ ${reward.stockQuantity}` : ""}
                  </p>
                </div>
                <Button variant="primary" className="self-center" type="submit" loading={isPending} disabled={!canRedeem}>
                  แลก
                </Button>
              </form>
            );
          })
        )}
      </div>
    </section>
  );

  return (
    <main className={`min-h-dvh bg-[var(--canvas)] ${customer ? "pb-28" : ""}`} style={themeStyle}>
      <div className={`mx-auto space-y-4 p-4 ${customer ? "max-w-md" : "max-w-3xl"}`}>
        {customer ? (
          <header className="flex items-center gap-3 pt-1">
            {store?.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={store.logoUrl} alt="" className="h-11 w-11 rounded-xl border border-[var(--border)] bg-white object-cover" />
            ) : (
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--tenant-primary)] text-sm font-bold text-white">
                {storeInitials}
              </span>
            )}
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-base font-bold text-[var(--foreground)]">{store?.name ?? "ร้านค้า"}</h1>
              <p className="truncate text-xs text-[var(--muted)]">สวัสดี {customer.name}</p>
            </div>
          </header>
        ) : (
          <header className="rounded-lg border border-[var(--border)] bg-white p-5 shadow-sm">
            <p className="text-xs font-bold uppercase text-[var(--muted)]">Member Portal</p>
            <h1 className="mt-1 text-2xl font-bold text-[var(--foreground)]">{store?.name ?? "ร้านค้า"}</h1>
            <p className="mt-1 text-sm text-[var(--muted)]">ต้องเปิดจาก QR ของร้าน เพื่อดูแต้มและแลกของรางวัลของร้านนี้</p>
          </header>
        )}

        <StatusMessage message={message} />

        {!customer ? (
          <section className="rounded-lg border border-[var(--border)] bg-white p-5 shadow-sm">
            <div className="mb-4 grid grid-cols-2 gap-2 rounded-lg bg-[var(--surface-muted)] p-1">
              <button
                className={mode === "register" ? "btn-primary" : "btn-secondary"}
                type="button"
                onClick={() => setMode("register")}
              >
                สมัครสมาชิก
              </button>
              <button
                className={mode === "login" ? "btn-primary" : "btn-secondary"}
                type="button"
                onClick={() => setMode("login")}
              >
                เข้าสู่ระบบ
              </button>
            </div>

            {!otpId ? (
              <form action={requestOtp} className="grid gap-3">
                <input type="hidden" name="storeSlug" value={storeSlug} />
                <input type="hidden" name="portalCode" value={portalCode} />
                <input type="hidden" name="mode" value={mode} />
                {mode === "register" ? (
                  <>
                    <label className="space-y-1">
                      <span className="text-xs font-semibold uppercase text-[var(--muted)]">ชื่อ</span>
                      <input className="form-input w-full px-3" style={{ fontSize: 16 }} name="name" maxLength={120} required />
                    </label>
                    <label className="space-y-1">
                      <span className="text-xs font-semibold uppercase text-[var(--muted)]">เบอร์โทรศัพท์</span>
                      <input className="form-input w-full px-3" style={{ fontSize: 16 }} name="phone" inputMode="tel" required />
                    </label>
                    <label className="space-y-1">
                      <span className="text-xs font-semibold uppercase text-[var(--muted)]">อีเมล</span>
                      <input className="form-input w-full px-3" style={{ fontSize: 16 }} name="email" type="email" />
                    </label>
                  </>
                ) : (
                  <label className="space-y-1">
                    <span className="text-xs font-semibold uppercase text-[var(--muted)]">เบอร์โทรศัพท์ / อีเมล</span>
                    <input className="form-input w-full px-3" style={{ fontSize: 16 }} name="identifier" required />
                  </label>
                )}
                <Button variant="primary" className="w-full" type="submit" loading={isPending}>
                  รับ OTP
                </Button>
              </form>
            ) : (
              <form action={verifyOtp} className="grid gap-3">
                <input type="hidden" name="storeSlug" value={storeSlug} />
                <input type="hidden" name="portalCode" value={portalCode} />
                <input type="hidden" name="otpId" value={otpId} />
                <label className="space-y-1">
                  <span className="text-xs font-semibold uppercase text-[var(--muted)]">OTP {maskedPhone ? `(${maskedPhone})` : ""}</span>
                  <input className="form-input w-full px-3 text-center text-xl font-bold" name="code" inputMode="numeric" maxLength={6} required />
                </label>
                <Button variant="primary" className="w-full" type="submit" loading={isPending}>
                  ยืนยัน OTP
                </Button>
                <Button
                  variant="secondary"
                  className="w-full"
                  type="button"
                  onClick={resendOtp}
                  disabled={resendIn > 0 || isPending}
                >
                  {resendIn > 0 ? `ขอรหัสใหม่ได้ใน ${resendIn} วินาที` : "ขอรหัสใหม่"}
                </Button>
                <Button variant="secondary" className="w-full" onClick={() => setOtpId(null)} loading={isPending}>
                  เปลี่ยนข้อมูล
                </Button>
              </form>
            )}
          </section>
        ) : (
          <>
            {view === "home" && (
              <>
                {claimCode ? (
                  <section className="rounded-xl border border-emerald-300 bg-emerald-50 p-4 shadow-sm">
                    {claimResult ? (
                      <>
                        <p className="text-sm font-bold text-emerald-900">รับแต้มเรียบร้อย</p>
                        <p className="mt-1 text-2xl font-black text-emerald-800">+{formatPoints(claimResult.points)} แต้ม</p>
                        <p className="mt-1 text-xs text-emerald-800">จากบิล {claimResult.orderNumber}</p>
                      </>
                    ) : (
                      <>
                        <p className="text-sm font-bold text-emerald-900">มีแต้มรอรับจากใบเสร็จ</p>
                        <p className="mt-1 text-xs text-emerald-800">รหัส {claimCode} · 1 บิลรับได้ครั้งเดียว</p>
                        {claimError ? <p className="mt-2 text-xs font-semibold text-red-700">{claimError}</p> : null}
                        <Button variant="primary" className="mt-3 w-full" onClick={claimReceiptPoints} loading={isPending}>
                          รับแต้มจากบิลนี้
                        </Button>
                      </>
                    )}
                  </section>
                ) : null}

                {data.passesOnly && (
                  <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                    ร้านปิดระบบสะสม/แลกแต้มแล้ว — แพ็กที่คุณซื้อไว้ยังใช้ได้ตามปกติจนหมดอายุ
                  </p>
                )}

                <div className="grid grid-cols-2 gap-3">
                  <button type="button" onClick={() => go("member")} className="rounded-xl border border-[var(--border)] bg-white p-3 text-left shadow-sm">
                    <p className="text-xs text-[var(--muted)]">แต้มของฉัน</p>
                    <p className="mt-1 text-2xl font-black tabular-nums text-[var(--foreground)]">{formatPoints(customer.pointsBalance)}</p>
                  </button>
                  <button type="button" onClick={() => go("member")} className="rounded-xl border border-[var(--border)] bg-white p-3 text-left shadow-sm">
                    <p className="text-xs text-[var(--muted)]">ระดับสมาชิก</p>
                    {tierView ? (
                      <span
                        className="mt-1.5 inline-block rounded-full px-2.5 py-0.5 text-xs font-bold text-white"
                        style={{ background: tierView.tier.color }}
                      >
                        {tierView.tier.name.toUpperCase()}
                      </span>
                    ) : (
                      <p className="mt-1.5 text-sm font-semibold text-[var(--foreground)]">สมาชิก</p>
                    )}
                    <p className="mt-1 text-[11px] text-[var(--muted)]">ดูสิทธิ์ ›</p>
                  </button>
                </div>

                <nav
                  className="grid gap-2"
                  style={{ gridTemplateColumns: `repeat(${quickActions.length}, minmax(0, 1fr))` }}
                  aria-label="ทางลัด"
                >
                  {quickActions.map((item) => (
                      <button
                        key={item.label}
                        type="button"
                        onClick={() => {
                          // สั่งออนไลน์ = ไปหน้าสั่งของสมาชิก (ไม่ใช่แท็บในหน้านี้)
                          if (item.key === "order") {
                            if (onlineOrderHref) router.push(onlineOrderHref);
                            return;
                          }
                          if (item.key === "history") {
                            // /member/<slug>/order → /member/<slug>/orders (cookie สมาชิก path เดียวกัน)
                            if (onlineOrderHref) router.push(`${onlineOrderHref}s`);
                            return;
                          }
                          go(item.key, item.anchor);
                        }}
                        className="relative rounded-xl border border-[var(--border)] bg-white px-1 py-2.5 text-center text-xs font-semibold text-[var(--ink-2)] shadow-sm"
                      >
                        <span aria-hidden="true" className="mx-auto mb-1 flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--tenant-primary-soft)] text-lg">
                          {item.icon}
                        </span>
                        {item.label}
                        {item.badge > 0 && (
                          <span className="absolute right-1.5 top-1.5 min-w-5 rounded-full bg-[var(--tenant-primary)] px-1.5 text-[10px] font-bold leading-5 text-white">
                            {item.badge}
                          </span>
                        )}
                      </button>
                    ))}
                </nav>

                {missionsView && (
                  <MemberMissionsCard storeSlug={storeSlug} portalCode={portalCode} view={missionsView} mode="home" onSeeAll={() => go("missions")} />
                )}

                {readyRedemptions.length > 0 && (
                  <section aria-label="คูปองพร้อมใช้">
                    <div className="mb-2 flex items-baseline justify-between">
                      <h2 className="text-base font-bold text-[var(--foreground)]">คูปองพร้อมใช้</h2>
                      <button type="button" onClick={() => go("coupons")} className="text-xs font-semibold text-[var(--tenant-primary)]">
                        ดูทั้งหมด ›
                      </button>
                    </div>
                    <div className="space-y-2">
                      {readyRedemptions.slice(0, 2).map((redemption) => (
                        <CouponTicket key={redemption.id} redemption={redemption} onOpen={() => setDetail(redemption)} />
                      ))}
                    </div>
                  </section>
                )}
              </>
            )}

            {view === "missions" &&
              (missionsView && missionsView.enabled ? (
                <MemberMissionsCard storeSlug={storeSlug} portalCode={portalCode} view={missionsView} />
              ) : (
                <EmptyPanel icon="🎯" title="ยังไม่มีภารกิจ" text="ร้านนี้ยังไม่เปิดภารกิจสะสม" />
              ))}

            {view === "code" &&
              (data.memberCodeEnabled ? (
                <MemberRedeemCodeCard storeSlug={storeSlug} portalCode={portalCode} />
              ) : (
                <EmptyPanel
                  icon="▣"
                  title="บอกเบอร์โทรที่แคชเชียร์"
                  text={`สาขานี้ยังไม่เปิดรหัสสมาชิก — สะสมแต้มด้วยเบอร์ ${customer.phone ?? "ที่สมัครไว้"}`}
                />
              ))}

            {view === "coupons" && (
              <section aria-label="คูปองของฉัน">
                <h2 className="text-xl font-bold text-[var(--foreground)]">คูปองของฉัน</h2>
                <p className="text-xs text-[var(--muted)]">รวมคูปองจากภารกิจ ระดับสมาชิก และรายการแลกของรางวัล</p>
                <div className="mt-3 flex border-b border-[var(--border)]" role="tablist">
                  {(
                    [
                      ["ready", `พร้อมใช้ (${readyCouponCount})`],
                      ["past", "ใช้แล้ว / หมดอายุ"],
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      role="tab"
                      aria-selected={couponTab === key}
                      onClick={() => setCouponTab(key)}
                      className={`flex-1 pb-2 text-sm ${
                        couponTab === key
                          ? "border-b-2 border-[var(--tenant-primary)] font-bold text-[var(--tenant-primary)]"
                          : "text-[var(--muted)]"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="mt-3 space-y-2">
                  {couponTab === "ready" ? (
                    <>
                      {tierView &&
                        tierCoupons
                          .filter((coupon) => coupon.remaining > 0)
                          .map((coupon) => (
                            <div key={coupon.benefitId} className="relative flex rounded-xl border border-[var(--border)] bg-white">
                              <div
                                className="flex w-[72px] shrink-0 items-center justify-center rounded-l-xl border-r-2 border-dashed border-[var(--border-strong)] text-[10px] font-bold text-white"
                                style={{ background: tierView.tier.color }}
                              >
                                {tierView.tier.name}
                              </div>
                              <div className="min-w-0 flex-1 p-3">
                                <p className="text-[11px] text-[var(--muted)]">สิทธิ์ระดับ · เหลือ {coupon.remaining}/{coupon.usesPerMonth} ครั้งเดือนนี้</p>
                                <p className="text-sm font-semibold text-[var(--foreground)]">{coupon.name}</p>
                                <button type="button" onClick={() => go("code")} className="mt-1 text-xs font-bold text-[var(--tenant-primary)]">
                                  ใช้ที่ร้าน: แสดงรหัสสมาชิก ›
                                </button>
                              </div>
                            </div>
                          ))}
                      {readyRedemptions.map((redemption) => (
                        <CouponTicket key={redemption.id} redemption={redemption} onOpen={() => setDetail(redemption)} />
                      ))}
                      {readyCouponCount === 0 && <EmptyPanel icon="🎟️" title="ยังไม่มีคูปองพร้อมใช้" text="ทำภารกิจหรือแลกแต้มเพื่อรับคูปอง" />}
                    </>
                  ) : pastRedemptions.length === 0 ? (
                    <EmptyPanel icon="🗂️" title="ยังไม่มีประวัติ" text="คูปองที่ใช้แล้วหรือหมดอายุจะแสดงที่นี่" />
                  ) : (
                    pastRedemptions.map((redemption) => (
                      <CouponTicket key={redemption.id} redemption={redemption} onOpen={() => setDetail(redemption)} faded />
                    ))
                  )}
                </div>
                <p className="mt-3 text-xs text-[var(--muted)]">แตะคูปองเพื่อดูรายละเอียดและโค้ดแลกรับ</p>
              </section>
            )}

            {view === "member" && (
              <>
                <section className="rounded-xl border border-[var(--border)] bg-white p-4 shadow-sm">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-[var(--foreground)]">{customer.name}</p>
                      <p className="text-xs text-[var(--muted)]">{customer.phone ?? customer.email ?? ""}</p>
                    </div>
                    {/* จำเป็นเมื่อลูกค้าสแกนจากเครื่องที่ร้านวางไว้ให้ใช้ร่วมกัน (audit ข้อ 14) */}
                    <form action={signOut}>
                      <input type="hidden" name="storeSlug" value={storeSlug} />
                      <button className="btn-secondary text-xs" type="submit">
                        ออกจากระบบ
                      </button>
                    </form>
                  </div>
                  <p className="mt-3 text-xs text-[var(--muted)]">แต้มของฉัน</p>
                  <p className="text-3xl font-black tabular-nums text-[var(--foreground)]">{formatPoints(customer.pointsBalance)} แต้ม</p>
                </section>
                {tierView && <MemberTierCard view={tierView} coupons={tierCoupons} />}
                {data.passesOnly && (
                  <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                    ร้านปิดระบบสะสม/แลกแต้มแล้ว — แพ็กที่คุณซื้อไว้ยังใช้ได้ตามปกติจนหมดอายุ
                  </p>
                )}
              </>
            )}
            {/* การ์ดแพ็ก mount ค้างไว้ทุกแท็บ (ซ่อนเมื่อไม่ใช่แท็บสมาชิก) — QR ชำระแพ็กที่กำลังรอจ่ายต้องไม่หายเมื่อสลับแท็บ */}
            {passesView && hasPasses && (
              <div id="member-passes" className={view === "member" ? "" : "hidden"}>
                <MemberPassesCard storeSlug={storeSlug} portalCode={portalCode} view={passesView} />
              </div>
            )}
            {view === "member" && !data.passesOnly && <div id="member-rewards">{rewardCatalog}</div>}
          </>
        )}
      </div>

      {customer && (
        <nav
          className="fixed inset-x-0 bottom-0 z-40 border-t border-[var(--border)] bg-white/95 backdrop-blur"
          style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
          aria-label="เมนูหลักสมาชิก"
        >
          <div className="mx-auto grid max-w-md grid-cols-5 items-end px-2 pb-1.5 pt-1 text-[11px]">
            {(
              [
                { key: "home", icon: "⌂", label: "หน้าแรก" },
                { key: "missions", icon: "🎯", label: "ภารกิจ" },
                { key: "code", icon: "▣", label: "รหัสสมาชิก" },
                { key: "coupons", icon: "🎟️", label: "คูปอง" },
                { key: "member", icon: "☺", label: "สมาชิก" },
              ] as const
            ).map((item) =>
              item.key === "code" ? (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => go("code")}
                  aria-current={view === "code" ? "page" : undefined}
                  className="-mt-6 flex flex-col items-center font-semibold text-[var(--tenant-primary)]"
                >
                  <span aria-hidden="true" className="flex h-14 w-14 items-center justify-center rounded-full border-4 border-[var(--canvas)] bg-[var(--tenant-primary)] text-2xl text-white shadow-md">
                    {item.icon}
                  </span>
                  {item.label}
                </button>
              ) : (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => go(item.key)}
                  aria-current={view === item.key ? "page" : undefined}
                  className={`relative flex flex-col items-center gap-0.5 py-1 ${
                    view === item.key ? "font-bold text-[var(--tenant-primary)]" : "text-[var(--quiet)]"
                  }`}
                >
                  <span aria-hidden="true" className="text-lg leading-none">{item.icon}</span>
                  {item.label}
                  {item.key === "coupons" && readyCouponCount > 0 && (
                    <span className="absolute right-3 top-0 h-2 w-2 rounded-full bg-[var(--tenant-primary)]" />
                  )}
                </button>
              ),
            )}
          </div>
        </nav>
      )}

      {voucher && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"
          onClick={closeVoucher}
        >
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 text-center shadow-xl" onClick={(event) => event.stopPropagation()}>
            <p className="text-3xl">🎉</p>
            <h3 className="mt-2 text-lg font-bold text-[var(--foreground)]">แลกสำเร็จ!</h3>
            <p className="mt-1 text-sm text-[var(--muted)]">{voucher.rewardName}</p>
            <p className="mt-4 text-xs font-semibold uppercase text-[var(--muted)]">โค้ดแลกรับ</p>
            <p className="mt-1 select-all rounded-lg border-2 border-dashed border-[var(--border)] bg-[var(--surface-muted)] py-3 text-2xl font-black tracking-widest text-[var(--foreground)]">
              {voucher.code}
            </p>
            <p className="mt-3 text-sm text-[var(--muted)]">
              {voucher.rewardType === "discount"
                ? `นำโค้ดนี้ให้พนักงานกรอกที่จุดชำระเงินเพื่อรับ${discountLabel(voucher.discountKind, voucher.discountValue) ?? "ส่วนลด"}`
                : "นำโค้ดนี้ให้พนักงานเพื่อรับของรางวัลที่ร้าน"}
            </p>
            <p className="mt-1 text-xs text-[var(--muted)]">ใช้ได้ครั้งเดียว · หมดอายุ {formatDate(voucher.expiresAt)}</p>
            <Button variant="primary" className="mt-5 w-full" onClick={closeVoucher}>
              เสร็จสิ้น
            </Button>
          </div>
        </div>
      )}

      {detail && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"
          onClick={() => setDetail(null)}
        >
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-start justify-between gap-3">
              <h3 className="text-lg font-bold text-[var(--foreground)]">{detail.rewardName}</h3>
              <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${redemptionStatusBadge(detail).className}`}>
                {redemptionStatusBadge(detail).label}
              </span>
            </div>
            {detail.rewardImageUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={detail.rewardImageUrl} alt={detail.rewardName} className="mt-3 h-40 w-full rounded-lg border border-[var(--border)] object-cover" />
            )}
            {detail.voucherCode && (
              <div className="mt-4 text-center">
                <p className="text-xs font-semibold uppercase text-[var(--muted)]">โค้ดแลกรับ</p>
                <p className="mt-1 select-all rounded-lg border-2 border-dashed border-[var(--border)] bg-[var(--surface-muted)] py-2 text-xl font-black tracking-widest text-[var(--foreground)]">
                  {detail.voucherCode}
                </p>
              </div>
            )}
            <dl className="mt-4 grid grid-cols-2 gap-y-2 text-sm">
              <dt className="text-[var(--muted)]">ประเภท</dt>
              <dd className="text-right font-semibold text-[var(--foreground)]">
                {detail.rewardType === "discount"
                  ? discountLabel(detail.discountKind, detail.discountValue) ?? "ส่วนลด"
                  : "ของรางวัล"}
              </dd>
              <dt className="text-[var(--muted)]">แต้มที่ใช้</dt>
              <dd className="text-right font-semibold text-[var(--foreground)]">
                {detail.pointsSpent > 0 ? `${formatPoints(detail.pointsSpent)} แต้ม` : "รางวัลภารกิจ (ไม่ใช้แต้ม)"}
              </dd>
              <dt className="text-[var(--muted)]">วันที่แลก</dt>
              <dd className="text-right font-semibold text-[var(--foreground)]">{formatDate(detail.createdAt)}</dd>
              <dt className="text-[var(--muted)]">หมดอายุ</dt>
              <dd className="text-right font-semibold text-[var(--foreground)]">{formatDate(detail.expiresAt)}</dd>
              {detail.usedAt && (
                <>
                  <dt className="text-[var(--muted)]">ใช้เมื่อ</dt>
                  <dd className="text-right font-semibold text-[var(--foreground)]">{formatDate(detail.usedAt)}</dd>
                </>
              )}
            </dl>
            <Button variant="secondary" className="mt-5 w-full" onClick={() => setDetail(null)}>
              ปิด
            </Button>
          </div>
        </div>
      )}
    </main>
  );
}
