"use client";

import { useEffect, useState } from "react";
import { useActionState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getSupabaseBrowserClient } from "@/server/integrations/supabase/client";
import { MarketingBrand } from "@/shared/components/marketing/MarketingShell";
import { signIn } from "./actions";
import { Button } from "@/shared/components/ui";

export default function LoginPage() {
  const router = useRouter();
  const [state, formAction, isPending] = useActionState(signIn, { error: null });
  const [inviteError, setInviteError] = useState<string | null>(null);

  useEffect(() => {
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const accessToken = hash.get("access_token");
    const refreshToken = hash.get("refresh_token");

    if (!accessToken || !refreshToken) return;

    let cancelled = false;

    getSupabaseBrowserClient().auth
      .setSession({
        access_token: accessToken,
        refresh_token: refreshToken,
      })
      .then(({ error }) => {
        if (cancelled) return;
        window.history.replaceState(null, "", window.location.pathname);
        if (error) {
          setInviteError("ลิงก์เชิญไม่ถูกต้องหรือหมดอายุ กรุณาขอลิงก์ใหม่");
          return;
        }
        window.sessionStorage.setItem("password_setup_intent", "invite");
        router.replace("/update-password");
        router.refresh();
      })
      .catch(() => {
        if (cancelled) return;
        window.history.replaceState(null, "", window.location.pathname);
        setInviteError("ลิงก์เชิญไม่ถูกต้องหรือหมดอายุ กรุณาขอลิงก์ใหม่");
      });

    return () => {
      cancelled = true;
    };
  }, [router]);

  return (
    <main className="reference-auth-page">
      <section className="reference-auth-visual">
        <div className="reference-auth-bg" aria-hidden="true">
          <picture>
            <source media="(max-width: 767px)" srcSet="/marketing/storeos-login-bg-mobile.png" />
            <source media="(max-width: 1100px)" srcSet="/marketing/storeos-login-bg-tablet.png" />
            <img src="/marketing/storeos-login-bg-desktop.png" alt="" draggable={false} />
          </picture>
        </div>
        <MarketingBrand />
        <div className="reference-auth-copy">
          <h1>
            จัดการร้านในที่เดียว
            <span>ให้ธุรกิจของคุณเติบโตอย่างมั่นคง</span>
          </h1>
          <p>POS, QR ordering, สต็อก, ลงเวลา และรายงาน พร้อมกลับมาทำงานต่อทันที</p>
        </div>

        <div className="reference-auth-cards" aria-hidden="true">
          <span className="marketing-glass-card is-pos">
            <i className="marketing-card-icon is-pos" aria-hidden="true" />
            <strong>POS</strong>
            <small>สั่งขาย - ชำระเงิน</small>
          </span>
          <span className="marketing-glass-card is-report">
            <i className="marketing-card-icon is-report" aria-hidden="true" />
            <strong>รายงานขาย</strong>
            <small>วันนี้ 24,560 บาท</small>
          </span>
          <span className="marketing-glass-card is-time">
            <i className="marketing-card-icon is-time" aria-hidden="true" />
            <strong>ลงเวลา</strong>
            <small>เข้า-ออกงาน</small>
          </span>
        </div>
      </section>

      <section className="reference-auth-form-wrap">
        <div className="auth-card marketing-glass reference-auth-card">
          <div className="reference-auth-mobile-brand">
            <MarketingBrand />
          </div>
          <div className="reference-auth-title">
            <h1>เข้าสู่ระบบ</h1>
            <p>ยินดีต้อนรับกลับมา</p>
          </div>

          <form action={formAction} className="reference-login-form">
            {inviteError && (
              <p className="alert-danger" role="alert">
                {inviteError}
              </p>
            )}
            {state.error && (
              <p className="alert-danger" role="alert">
                {state.error}
              </p>
            )}

            <label>
              <span>อีเมล</span>
              <input
                id="email"
                name="email"
                type="email"
                required
                autoComplete="email"
                disabled={isPending}
                placeholder="กรอกอีเมลของคุณ"
                className="form-input disabled:opacity-50"
              />
            </label>

            <label>
              <span>รหัสผ่าน</span>
              <input
                id="password"
                name="password"
                type="password"
                required
                autoComplete="current-password"
                disabled={isPending}
                placeholder="กรอกรหัสผ่าน"
                className="form-input disabled:opacity-50"
              />
            </label>

            <Link href="/reset-password" className="reference-forgot-link">
              ลืมรหัสผ่าน?
            </Link>

            <Button
              type="submit"
              variant="primary"
              loading={isPending}
              loadingText="กำลังเข้าสู่ระบบ..."
              className="reference-login-submit disabled:cursor-not-allowed disabled:opacity-50"
            >
              เข้าสู่ระบบ
            </Button>
          </form>

          <p className="reference-auth-register">
            ยังไม่มีบัญชี? <Link href="/register">สมัครใช้งานฟรี 30 วัน</Link>
          </p>
        </div>
      </section>
    </main>
  );
}
