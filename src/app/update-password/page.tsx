"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getSupabaseBrowserClient } from "@/server/integrations/supabase/client";
import { Button } from "@/shared/components/ui";

const MIN_PASSWORD_LENGTH = 8;

export default function UpdatePasswordPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);
  const [canUpdatePassword, setCanUpdatePassword] = useState(false);

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    let settled = false;

    const enable = () => {
      settled = true;
      setCanUpdatePassword(true);
    };

    // @supabase/ssr (PKCE, detectSessionInUrl) auto-processes both the hash
    // (#access_token) and the query (?code) recovery/invite links, then emits an
    // auth event. Listen for it instead of parsing the URL manually.
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (
        event === "PASSWORD_RECOVERY" ||
        (Boolean(session) &&
          (event === "SIGNED_IN" || event === "INITIAL_SESSION" || event === "TOKEN_REFRESHED"))
      ) {
        enable();
      }
    });

    // Fallback for an already-established session (e.g. invite flow).
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (user) enable();
    });

    // If no recovery/session is established shortly, the link was invalid/expired.
    const timer = setTimeout(() => {
      if (!settled) router.replace("/login");
    }, 4000);

    return () => {
      sub.subscription.unsubscribe();
      clearTimeout(timer);
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
      router.replace("/dashboard");
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
          <Button
            type="submit"
            variant="primary"
            loading={isPending}
            loadingText="กำลังบันทึก..."
            disabled={!canUpdatePassword}
            className="w-full disabled:cursor-not-allowed disabled:opacity-50"
          >
            บันทึกรหัสผ่าน
          </Button>
        </form>
      </div>
    </main>
  );
}
