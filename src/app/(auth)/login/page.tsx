"use client";

import { useEffect, useState } from "react";
import { useActionState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getSupabaseBrowserClient } from "@/server/integrations/supabase/client";
import { signIn } from "./actions";

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
    <main className="grid min-h-screen bg-[var(--canvas)] lg:grid-cols-2">
      {/* Brand panel */}
      <section
        className="relative hidden min-h-screen flex-col justify-between overflow-hidden p-12 text-white lg:flex"
        style={{
          background:
            "radial-gradient(120% 120% at 0% 0%, var(--tenant-primary) 0%, var(--tenant-primary-strong) 55%, #5a2f1c 100%)",
        }}
      >
        {/* decorative glow */}
        <div
          aria-hidden
          className="pointer-events-none absolute -right-24 -top-24 h-96 w-96 rounded-full opacity-20 blur-3xl"
          style={{ background: "#fff" }}
        />
        <div className="relative flex items-center gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-xl bg-white/15 text-lg font-extrabold backdrop-blur">
            S
          </div>
          <div>
            <div className="text-base font-extrabold">StoreOS</div>
            <div className="text-xs text-white/70">ระบบจัดการร้าน</div>
          </div>
        </div>

        <div className="relative max-w-xl">
          <h1 className="text-4xl font-extrabold leading-tight xl:text-5xl">
            ร้านเดียวก็สวยได้
            <br />
            หลายสาขาก็คุมง่าย
          </h1>
          <p className="mt-5 max-w-lg text-base leading-7 text-white/80">
            POS, QR ordering, รายงาน, ทีมงาน และธีมแบรนด์ของแต่ละ tenant อยู่ในประสบการณ์เดียว
          </p>
          <div className="mt-8 grid max-w-lg grid-cols-3 gap-3">
            {[
              ["POS", "ขายหน้าร้านเร็ว"],
              ["QR", "รับออร์เดอร์โต๊ะ"],
              ["Theme", "แต่งสีร้านเอง"],
            ].map(([title, text]) => (
              <div key={title} className="rounded-xl border border-white/15 bg-white/10 p-4 backdrop-blur">
                <p className="text-sm font-extrabold">{title}</p>
                <p className="mt-1 text-xs text-white/70">{text}</p>
              </div>
            ))}
          </div>
        </div>

        <p className="relative text-xs text-white/60">Caramel Cafe preset · Tenant-ready UI tokens</p>
      </section>

      {/* Form panel */}
      <section className="flex min-h-screen items-center justify-center px-5 py-10 sm:px-8">
        <div className="auth-card panel w-full max-w-md space-y-6 p-6 shadow-sm sm:p-8">
          <div>
            <div className="mb-5 flex items-center gap-3 lg:hidden">
              <div className="brand-mark">S</div>
              <div>
                <div className="brand-name">StoreOS</div>
                <div className="brand-sub">ระบบจัดการร้าน</div>
              </div>
            </div>
            <span className="badge badge-brand mb-3">Caramel Cafe</span>
            <h1 className="page-title">เข้าสู่ระบบ</h1>
            <p className="page-kicker">ระบบจัดการร้านค้า POS รายงาน และทีมงานในที่เดียว</p>
          </div>
        <form action={formAction} className="space-y-4">
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
          <div className="space-y-1">
            <label htmlFor="email" className="field-label">
              อีเมล
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="email"
              disabled={isPending}
              placeholder="you@example.com"
              className="form-input disabled:opacity-50"
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="password" className="field-label">
              รหัสผ่าน
            </label>
            <input
              id="password"
              name="password"
              type="password"
              required
              autoComplete="current-password"
              disabled={isPending}
              className="form-input disabled:opacity-50"
            />
          </div>
          <button
            type="submit"
            disabled={isPending}
            className="btn-primary w-full disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isPending ? "กำลังเข้าสู่ระบบ..." : "เข้าสู่ระบบ"}
          </button>
          <div className="text-center">
            <Link href="/reset-password" className="text-sm font-bold text-[var(--color-brand)] hover:text-[var(--color-brand-hover)]">
              ลืมรหัสผ่าน
            </Link>
          </div>
        </form>
      </div>
      </section>
    </main>
  );
}
