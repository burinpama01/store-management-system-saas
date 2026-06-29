"use client";

import { useActionState } from "react";
import Link from "next/link";
import { registerOwner, type RegisterState } from "./actions";
import { Button } from "@/shared/components/ui";

const INITIAL: RegisterState = { error: null, notice: null };

export default function RegisterPage() {
  const [state, formAction, isPending] = useActionState(registerOwner, INITIAL);

  return (
    <main className="grid min-h-screen overflow-hidden bg-[var(--canvas)] lg:grid-cols-[minmax(0,1fr)_460px]">
      <section className="hidden min-h-screen flex-col justify-between p-10 lg:flex">
        <Link href="/pricing" className="brand p-0">
          <div className="brand-mark brand-mark--logo" aria-hidden="true" />
          <div>
            <div className="brand-name">StoreOS</div>
            <div className="brand-sub">ระบบจัดการร้าน</div>
          </div>
        </Link>
        <div className="max-w-3xl">
          <h1 className="text-5xl font-extrabold leading-tight text-[var(--ink)]">
            เปิดร้านบนระบบเดียว จบครบทุกงานหลังร้าน
          </h1>
          <p className="mt-5 max-w-xl text-lg leading-8 text-[var(--ink-2)]">
            สมัครเป็นเจ้าของร้าน สร้างกิจการและสาขาแรกของคุณได้ทันที แล้วเชิญทีมงานเข้ามาช่วยภายหลัง
          </p>
        </div>
        <p className="text-xs text-[var(--muted)]">
          มีบัญชีอยู่แล้ว? <Link href="/login" className="font-bold text-[var(--color-brand)]">เข้าสู่ระบบ</Link>
        </p>
      </section>

      <section className="flex min-h-screen w-screen items-center justify-center overflow-x-hidden px-4 py-8 lg:w-auto">
        <div
          className="auth-card panel space-y-6 p-6 shadow-sm sm:p-8"
          style={{ width: "clamp(18rem, 31vw, 30rem)", maxWidth: "calc(100vw - 2rem)" }}
        >
          <div>
            <span className="badge badge-brand mb-3">สมัครใช้งาน</span>
            <h1 className="page-title">สร้างบัญชีเจ้าของร้าน</h1>
            <p className="page-kicker">เริ่มต้นด้วยแพ็กเกจ Free อัปเกรดได้ทุกเมื่อ</p>
          </div>

          <form action={formAction} className="space-y-4">
            {state.error && (
              <p className="alert-danger" role="alert">{state.error}</p>
            )}
            {state.notice && (
              <p
                className="rounded-[var(--radius-md)] border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700"
                role="status"
              >
                {state.notice}
              </p>
            )}

            <div className="space-y-1">
              <label htmlFor="organizationName" className="field-label">ชื่อกิจการ</label>
              <input
                id="organizationName"
                name="organizationName"
                type="text"
                required
                maxLength={100}
                disabled={isPending}
                placeholder="เช่น Caramel Group"
                className="form-input disabled:opacity-50"
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="storeName" className="field-label">ชื่อร้าน (สาขาแรก)</label>
              <input
                id="storeName"
                name="storeName"
                type="text"
                required
                maxLength={100}
                disabled={isPending}
                placeholder="เช่น Caramel Cafe สาขาสยาม"
                className="form-input disabled:opacity-50"
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="email" className="field-label">อีเมล</label>
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
              <label htmlFor="password" className="field-label">รหัสผ่าน (อย่างน้อย 8 ตัวอักษร)</label>
              <input
                id="password"
                name="password"
                type="password"
                required
                minLength={8}
                autoComplete="new-password"
                disabled={isPending}
                className="form-input disabled:opacity-50"
              />
            </div>

            <Button
              type="submit"
              variant="primary"
              loading={isPending}
              loadingText="กำลังสร้างบัญชี..."
              className="w-full disabled:cursor-not-allowed disabled:opacity-50"
            >
              สร้างบัญชี
            </Button>

            <p className="text-center text-xs text-[var(--muted)]">
              เมื่อสมัคร ถือว่ายอมรับเงื่อนไขการใช้งานของ StoreOS
            </p>
          </form>
        </div>
      </section>
    </main>
  );
}
