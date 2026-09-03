"use client";

import { useMemo, useState, useTransition } from "react";
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

interface Props {
  storeSlug: string;
  portalCode: string;
  /** รหัสรับแต้มจาก QR ท้ายใบเสร็จ (?claim=) — null = เข้ามาปกติ */
  claimCode: string | null;
  data: CustomerPortalData;
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

export function MemberPortal({ storeSlug, portalCode, claimCode, data }: Props) {
  const router = useRouter();
  const [mode, setMode] = useState<"register" | "login">("register");
  const [otpId, setOtpId] = useState<string | null>(null);
  const [maskedPhone, setMaskedPhone] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(data.error);
  const [isPending, startTransition] = useTransition();
  const [tab, setTab] = useState<"redeem" | "history">("redeem");
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

  function requestOtp(formData: FormData) {
    startTransition(async () => {
      const result = await requestMemberOtpAction(formData);
      setMessage(result.error ?? `ส่ง OTP ไปที่ ${result.maskedPhone ?? "เบอร์ของคุณ"} แล้ว`);
      if (!result.error && result.otpId) {
        setOtpId(result.otpId);
        setMaskedPhone(result.maskedPhone ?? null);
      }
    });
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

  return (
    <main className="min-h-dvh bg-[var(--canvas)] p-4">
      <div className="mx-auto max-w-3xl space-y-4">
        <header className="rounded-lg border border-[var(--border)] bg-white p-5 shadow-sm">
          <p className="text-xs font-bold uppercase text-[var(--muted)]">Member Portal</p>
          <h1 className="mt-1 text-2xl font-bold text-[var(--foreground)]">{data.store?.name ?? "ร้านค้า"}</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">ต้องเปิดจาก QR ของร้าน เพื่อดูแต้มและแลกของรางวัลของร้านนี้</p>
        </header>

        <StatusMessage message={message} />

        {!data.customer ? (
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
                      <input className="form-input w-full px-3" name="name" maxLength={120} required />
                    </label>
                    <label className="space-y-1">
                      <span className="text-xs font-semibold uppercase text-[var(--muted)]">เบอร์โทรศัพท์</span>
                      <input className="form-input w-full px-3" name="phone" inputMode="tel" required />
                    </label>
                    <label className="space-y-1">
                      <span className="text-xs font-semibold uppercase text-[var(--muted)]">อีเมล</span>
                      <input className="form-input w-full px-3" name="email" type="email" />
                    </label>
                  </>
                ) : (
                  <label className="space-y-1">
                    <span className="text-xs font-semibold uppercase text-[var(--muted)]">เบอร์โทรศัพท์ / อีเมล</span>
                    <input className="form-input w-full px-3" name="identifier" required />
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
                <Button variant="secondary" className="w-full" onClick={() => setOtpId(null)} loading={isPending}>
                  เปลี่ยนข้อมูล
                </Button>
              </form>
            )}
          </section>
        ) : (
          <>
            {claimCode ? (
              <section className="rounded-lg border border-emerald-300 bg-emerald-50 p-4 shadow-sm">
                {claimResult ? (
                  <>
                    <p className="text-sm font-bold text-emerald-900">รับแต้มเรียบร้อย</p>
                    <p className="mt-1 text-2xl font-black text-emerald-800">
                      +{formatPoints(claimResult.points)} แต้ม
                    </p>
                    <p className="mt-1 text-xs text-emerald-800">จากบิล {claimResult.orderNumber}</p>
                  </>
                ) : (
                  <>
                    <p className="text-sm font-bold text-emerald-900">มีแต้มรอรับจากใบเสร็จ</p>
                    <p className="mt-1 text-xs text-emerald-800">รหัส {claimCode} · 1 บิลรับได้ครั้งเดียว</p>
                    {claimError ? (
                      <p className="mt-2 text-xs font-semibold text-red-700">{claimError}</p>
                    ) : null}
                    <Button
                      variant="primary"
                      className="mt-3 w-full"
                      onClick={claimReceiptPoints}
                      loading={isPending}
                    >
                      รับแต้มจากบิลนี้
                    </Button>
                  </>
                )}
              </section>
            ) : null}

            <section className="rounded-lg border border-[var(--border)] bg-white p-5 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm text-[var(--muted)]">{data.customer.name}</p>
                  <h2 className="mt-1 text-xl font-bold text-[var(--foreground)]">แต้มของฉัน</h2>
                </div>
                {/* จำเป็นเมื่อลูกค้าสแกนจากเครื่องที่ร้านวางไว้ให้ใช้ร่วมกัน (audit ข้อ 14) */}
                <form action={signOut}>
                  <input type="hidden" name="storeSlug" value={storeSlug} />
                  <button className="btn-secondary text-xs" type="submit">
                    ออกจากระบบ
                  </button>
                </form>
              </div>
              <p className="mt-3 text-4xl font-black text-[var(--foreground)]">
                {formatPoints(data.customer.pointsBalance)} แต้ม
              </p>
            </section>

            <div className="grid grid-cols-2 gap-2 rounded-lg bg-[var(--surface-muted)] p-1">
              <button
                className={tab === "redeem" ? "btn-primary" : "btn-secondary"}
                type="button"
                onClick={() => setTab("redeem")}
              >
                แลกของรางวัล
              </button>
              <button
                className={tab === "history" ? "btn-primary" : "btn-secondary"}
                type="button"
                onClick={() => setTab("history")}
              >
                รายการแลกของรางวัล
              </button>
            </div>

            {tab === "redeem" ? (
              <section className="rounded-lg border border-[var(--border)] bg-white p-5 shadow-sm">
                <div className="grid gap-3">
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
                          className="grid grid-cols-[64px_1fr_auto] items-center gap-3 rounded-lg border border-[var(--border)] p-4"
                        >
                          <input type="hidden" name="storeSlug" value={storeSlug} />
                          <input type="hidden" name="portalCode" value={portalCode} />
                          <input type="hidden" name="rewardId" value={reward.id} />
                          {reward.imageUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={reward.imageUrl} alt={reward.name} className="h-16 w-16 rounded-md border border-[var(--border)] object-cover" />
                          ) : (
                            <div className="grid h-16 w-16 place-items-center rounded-md bg-[var(--surface-muted)] text-2xl">🎁</div>
                          )}
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="font-bold text-[var(--foreground)]">{reward.name}</p>
                              <span className="rounded-full border border-[var(--border)] px-2 py-0.5 text-[11px] text-[var(--muted)]">
                                {rewardTypeBadge(reward)}
                              </span>
                            </div>
                            {reward.description && <p className="mt-1 text-sm text-[var(--muted)]">{reward.description}</p>}
                            <p className="mt-2 text-sm font-semibold text-[var(--foreground)]">
                              {formatPoints(reward.pointsCost)} แต้ม
                              {reward.stockQuantity !== null && reward.stockQuantity !== undefined
                                ? ` · เหลือ ${reward.stockQuantity}`
                                : ""}
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
            ) : (
              <section className="rounded-lg border border-[var(--border)] bg-white p-5 shadow-sm">
                <div className="grid gap-2">
                  {data.redemptions.length === 0 ? (
                    <p className="text-sm text-[var(--muted)]">ยังไม่มีประวัติแลกรางวัล</p>
                  ) : (
                    data.redemptions.map((redemption) => {
                      const badge = redemptionStatusBadge(redemption);
                      return (
                        <button
                          key={redemption.id}
                          type="button"
                          onClick={() => setDetail(redemption)}
                          className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] p-3 text-left transition hover:border-[var(--foreground)]"
                        >
                          <div className="min-w-0">
                            <p className="truncate font-semibold text-[var(--foreground)]">{redemption.rewardName}</p>
                            <p className="text-xs text-[var(--muted)]">
                              {redemption.voucherCode ? `โค้ด ${redemption.voucherCode} · ` : ""}
                              {formatDate(redemption.createdAt)}
                            </p>
                          </div>
                          <div className="shrink-0 text-right">
                            <span className={`inline-block rounded-full border px-2 py-0.5 text-[11px] font-semibold ${badge.className}`}>
                              {badge.label}
                            </span>
                            <p className="mt-1 text-xs text-[var(--muted)]">-{formatPoints(redemption.pointsSpent)} แต้ม</p>
                          </div>
                        </button>
                      );
                    })
                  )}
                </div>
                <p className="mt-3 text-xs text-[var(--muted)]">แตะรายการเพื่อดูรายละเอียดและโค้ดแลกรับ</p>
              </section>
            )}
          </>
        )}
      </div>

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
              <dd className="text-right font-semibold text-[var(--foreground)]">{formatPoints(detail.pointsSpent)} แต้ม</dd>
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
