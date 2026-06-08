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
    <main className="grid min-h-screen overflow-hidden bg-[var(--canvas)] lg:grid-cols-[minmax(0,1fr)_440px]">
      <section className="hidden min-h-screen flex-col justify-between p-10 lg:flex">
        <div className="brand p-0">
          <div className="brand-mark">S</div>
          <div>
            <div className="brand-name">StoreOS</div>
            <div className="brand-sub">ระบบจัดการร้าน</div>
          </div>
        </div>
        <div className="max-w-3xl">
          <h1 className="text-5xl font-extrabold leading-tight text-[var(--ink)]">
            ร้านเดียวก็สวยได้ หลายสาขาก็คุมง่าย
          </h1>
          <p className="mt-5 max-w-xl text-lg leading-8 text-[var(--ink-2)]">
            POS, QR ordering, รายงาน, ทีมงาน และธีมแบรนด์ของแต่ละ tenant อยู่ในประสบการณ์เดียวแบบ StoreOS redesign
          </p>
          <div className="mt-8 grid max-w-2xl grid-cols-3 gap-3">
            {[
              ["POS", "ขายหน้าร้านเร็ว"],
              ["QR", "รับออร์เดอร์โต๊ะ"],
              ["Theme", "แต่งสีร้านเอง"],
            ].map(([title, text]) => (
              <div key={title} className="panel p-4">
                <p className="text-sm font-extrabold text-[var(--tenant-primary-strong)]">{title}</p>
                <p className="mt-1 text-xs text-[var(--muted)]">{text}</p>
              </div>
            ))}
          </div>
        </div>
        <p className="text-xs text-[var(--muted)]">Caramel Cafe preset · Tenant-ready UI tokens</p>
      </section>

      <section className="flex min-h-screen w-screen items-center justify-center overflow-x-hidden px-4 py-8 lg:w-auto">
        <div
          className="auth-card panel space-y-6 p-6 shadow-sm sm:p-8"
          style={{ width: "clamp(18rem, 31vw, 28rem)", maxWidth: "calc(100vw - 2rem)" }}
        >
          <div>
            <div className="mb-4 flex items-center gap-3 lg:hidden">
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
