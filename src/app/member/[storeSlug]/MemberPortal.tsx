"use client";

import { useMemo, useState, useTransition } from "react";
import type { CustomerPortalData } from "@/modules/customers/member-repository";
import {
  redeemMemberRewardAction,
  requestMemberOtpAction,
  verifyMemberOtpAction,
} from "./actions";

interface Props {
  storeSlug: string;
  portalCode: string;
  data: CustomerPortalData;
}

function formatPoints(value: number) {
  return new Intl.NumberFormat("th-TH", { maximumFractionDigits: 0 }).format(value);
}

function StatusMessage({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800">
      {message}
    </div>
  );
}

export function MemberPortal({ storeSlug, portalCode, data }: Props) {
  const [mode, setMode] = useState<"register" | "login">("register");
  const [otpId, setOtpId] = useState<string | null>(null);
  const [maskedPhone, setMaskedPhone] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(data.error);
  const [isPending, startTransition] = useTransition();
  const sortedRewards = useMemo(
    () => [...data.rewards].sort((a, b) => a.pointsCost - b.pointsCost),
    [data.rewards],
  );

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
      setMessage(result.error ?? "เข้าสู่ระบบสมาชิกแล้ว");
      if (!result.error) {
        setOtpId(null);
        window.location.reload();
      }
    });
  }

  function redeemReward(formData: FormData) {
    startTransition(async () => {
      const result = await redeemMemberRewardAction(formData);
      setMessage(result.error ?? "แลกของรางวัลแล้ว");
      if (!result.error) window.location.reload();
    });
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
                <button className="btn-primary w-full" type="submit" disabled={isPending}>
                  รับ OTP
                </button>
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
                <button className="btn-primary w-full" type="submit" disabled={isPending}>
                  ยืนยัน OTP
                </button>
                <button className="btn-secondary w-full" type="button" onClick={() => setOtpId(null)} disabled={isPending}>
                  เปลี่ยนข้อมูล
                </button>
              </form>
            )}
          </section>
        ) : (
          <>
            <section className="rounded-lg border border-[var(--border)] bg-white p-5 shadow-sm">
              <p className="text-sm text-[var(--muted)]">{data.customer.name}</p>
              <h2 className="mt-1 text-xl font-bold text-[var(--foreground)]">แต้มของฉัน</h2>
              <p className="mt-3 text-4xl font-black text-[var(--foreground)]">
                {formatPoints(data.customer.pointsBalance)} แต้ม
              </p>
            </section>

            <section className="rounded-lg border border-[var(--border)] bg-white p-5 shadow-sm">
              <h2 className="text-xl font-bold text-[var(--foreground)]">แลกของรางวัล</h2>
              <div className="mt-4 grid gap-3">
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
                        className="grid gap-3 rounded-lg border border-[var(--border)] p-4 sm:grid-cols-[1fr_auto]"
                      >
                        <input type="hidden" name="storeSlug" value={storeSlug} />
                        <input type="hidden" name="portalCode" value={portalCode} />
                        <input type="hidden" name="rewardId" value={reward.id} />
                        <div>
                          <p className="font-bold text-[var(--foreground)]">{reward.name}</p>
                          {reward.description && <p className="mt-1 text-sm text-[var(--muted)]">{reward.description}</p>}
                          <p className="mt-2 text-sm font-semibold text-[var(--foreground)]">
                            {formatPoints(reward.pointsCost)} แต้ม
                            {reward.stockQuantity !== null && reward.stockQuantity !== undefined
                              ? ` · เหลือ ${reward.stockQuantity}`
                              : ""}
                          </p>
                        </div>
                        <button className="btn-primary self-end" type="submit" disabled={!canRedeem || isPending}>
                          แลก
                        </button>
                      </form>
                    );
                  })
                )}
              </div>
            </section>

            <section className="rounded-lg border border-[var(--border)] bg-white p-5 shadow-sm">
              <h2 className="text-xl font-bold text-[var(--foreground)]">ประวัติแลกรางวัล</h2>
              <div className="mt-3 grid gap-2">
                {data.redemptions.length === 0 ? (
                  <p className="text-sm text-[var(--muted)]">ยังไม่มีประวัติแลกรางวัล</p>
                ) : (
                  data.redemptions.map((redemption) => (
                    <div key={redemption.id} className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] p-3">
                      <div>
                        <p className="font-semibold text-[var(--foreground)]">{redemption.rewardName}</p>
                        <p className="text-xs text-[var(--muted)]">{new Date(redemption.createdAt).toLocaleString("th-TH")}</p>
                      </div>
                      <span className="text-sm font-bold text-[var(--foreground)]">-{formatPoints(redemption.pointsSpent)}</span>
                    </div>
                  ))
                )}
              </div>
            </section>
          </>
        )}
      </div>
    </main>
  );
}
