"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { getSupabaseBrowserClient } from "@/server/integrations/supabase/client";

export default function ResetPasswordPage() {
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setMessage(null);

    const formData = new FormData(event.currentTarget);
    const email = (formData.get("email") as string | null)?.trim() ?? "";

    if (!email) {
      setError("กรุณากรอกอีเมล");
      return;
    }

    try {
      setIsPending(true);
      const { error: resetError } = await getSupabaseBrowserClient().auth.resetPasswordForEmail(
        email,
        { redirectTo: `${window.location.origin}/update-password` },
      );

      if (resetError) {
        setError("ส่งลิงก์รีเซ็ตรหัสผ่านไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
        return;
      }

      setMessage("ส่งลิงก์รีเซ็ตรหัสผ่านแล้ว กรุณาตรวจสอบอีเมล");
    } catch {
      setError("ส่งลิงก์รีเซ็ตรหัสผ่านไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
    } finally {
      setIsPending(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center overflow-x-hidden bg-[var(--color-bg)] px-4">
      <div className="auth-card panel p-6 sm:p-8 space-y-6 shadow-sm">
        <div>
          <p className="label-muted mb-2">กู้คืนบัญชี</p>
          <h1 className="page-title">รีเซ็ตรหัสผ่าน</h1>
          <p className="page-kicker">
            กรอกอีเมลเพื่อรับลิงก์ตั้งรหัสผ่านใหม่
          </p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <p className="alert-danger" role="alert">
              {error}
            </p>
          )}
          {message && (
            <p className="alert-success" aria-live="polite">
              {message}
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
          <button
            type="submit"
            disabled={isPending}
            className="btn-primary w-full disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isPending ? "กำลังส่ง..." : "ส่งลิงก์รีเซ็ตรหัสผ่าน"}
          </button>
          <div className="text-center">
            <Link href="/login" className="text-sm font-bold text-[var(--color-brand)] hover:text-[var(--color-brand-hover)]">
              กลับไปเข้าสู่ระบบ
            </Link>
          </div>
        </form>
      </div>
    </main>
  );
}
