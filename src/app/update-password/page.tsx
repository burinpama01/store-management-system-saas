"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getSupabaseBrowserClient } from "@/server/integrations/supabase/client";

const MIN_PASSWORD_LENGTH = 8;

export default function UpdatePasswordPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);
  const [canUpdatePassword, setCanUpdatePassword] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const accessToken = hash.get("access_token");
    const refreshToken = hash.get("refresh_token");
    const supabase = getSupabaseBrowserClient();

    if (accessToken && refreshToken) {
      supabase.auth
        .setSession({
          access_token: accessToken,
          refresh_token: refreshToken,
        })
        .then(({ error: sessionError }) => {
          if (cancelled) return;
          window.history.replaceState(null, "", window.location.pathname);
          if (sessionError) router.replace("/login");
          else {
            window.sessionStorage.setItem("password_setup_intent", "recovery");
            setCanUpdatePassword(true);
            router.refresh();
          }
        })
        .catch(() => {
          if (cancelled) return;
          window.history.replaceState(null, "", window.location.pathname);
          router.replace("/login");
        });
      return () => {
        cancelled = true;
      };
    }

    const intent = window.sessionStorage.getItem("password_setup_intent");
    if (intent !== "invite" && intent !== "recovery") {
      router.replace("/");
      return () => {
        cancelled = true;
      };
    }

    supabase.auth
      .getUser()
      .then(({ data: { user } }) => {
        if (cancelled) return;
        if (!user) router.replace("/login");
        else setCanUpdatePassword(true);
      })
      .catch(() => {
        if (!cancelled) router.replace("/login");
      });

    return () => {
      cancelled = true;
    };
  }, [router]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (!canUpdatePassword) {
      setError("ลิงก์ตั้งรหัสผ่านไม่ถูกต้องหรือหมดอายุ");
      return;
    }

    const formData = new FormData(event.currentTarget);
    const password = (formData.get("password") as string | null) ?? "";
    const confirmPassword = (formData.get("confirmPassword") as string | null) ?? "";

    if (password.length < MIN_PASSWORD_LENGTH) {
      setError("รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร");
      return;
    }

    if (password !== confirmPassword) {
      setError("รหัสผ่านและการยืนยันรหัสผ่านไม่ตรงกัน");
      return;
    }

    try {
      setIsPending(true);
      const { error: updateError } = await getSupabaseBrowserClient().auth.updateUser({
        password,
      });

      if (updateError) {
        setError("ตั้งรหัสผ่านไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
        return;
      }

      window.sessionStorage.removeItem("password_setup_intent");
      router.replace("/");
      router.refresh();
    } catch {
      setError("ตั้งรหัสผ่านไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
    } finally {
      setIsPending(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center overflow-x-hidden bg-[var(--color-bg)] px-4">
      <div className="auth-card panel p-6 sm:p-8 space-y-6 shadow-sm">
        <div>
          <p className="label-muted mb-2">ตั้งค่าความปลอดภัย</p>
          <h1 className="page-title">ตั้งรหัสผ่าน</h1>
          <p className="page-kicker">กรุณาตั้งรหัสผ่านสำหรับบัญชีของคุณ</p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <p className="alert-danger" role="alert">
              {error}
            </p>
          )}
          <div className="space-y-1">
            <label htmlFor="password" className="field-label">
              รหัสผ่านใหม่
            </label>
            <input
              id="password"
              name="password"
              type="password"
              required
              minLength={MIN_PASSWORD_LENGTH}
              autoComplete="new-password"
              disabled={isPending || !canUpdatePassword}
              className="form-input disabled:opacity-50"
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="confirmPassword" className="field-label">
              ยืนยันรหัสผ่านใหม่
            </label>
            <input
              id="confirmPassword"
              name="confirmPassword"
              type="password"
              required
              minLength={MIN_PASSWORD_LENGTH}
              autoComplete="new-password"
              disabled={isPending || !canUpdatePassword}
              className="form-input disabled:opacity-50"
            />
          </div>
          <button
            type="submit"
            disabled={isPending || !canUpdatePassword}
            className="btn-primary w-full disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isPending ? "กำลังบันทึก..." : "บันทึกรหัสผ่าน"}
          </button>
        </form>
      </div>
    </main>
  );
}
