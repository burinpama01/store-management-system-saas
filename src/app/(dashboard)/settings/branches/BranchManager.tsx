"use client";

import { useActionState, useEffect, useRef } from "react";
import type { Store } from "@/modules/stores/types";
import { createBranchAction, type BranchActionState } from "./actions";
import { Button } from "@/shared/components/ui";

const INITIAL_STATE: BranchActionState = { error: null };

export function BranchManager({
  stores,
  currentStoreId,
  canCreate,
  unavailableMessage,
}: {
  stores: Store[];
  currentStoreId: string;
  canCreate: boolean;
  unavailableMessage: string | null;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, action, pending] = useActionState(createBranchAction, INITIAL_STATE);

  useEffect(() => {
    if (state.ok) formRef.current?.reset();
  }, [state.ok]);

  return (
    <div className="space-y-5">
      <section className="panel p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="panel-title">สาขาในองค์กร</h2>
            <p className="mt-1 text-sm text-[var(--muted)]">
              ระบบแยกข้อมูลของแต่ละสาขาด้วยรหัสภายในและขอบเขตองค์กรอย่างชัดเจน
            </p>
          </div>
          <span className="badge badge-brand">{stores.length} สาขา</span>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {stores.map((store) => (
            <div
              key={store.id}
              className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-muted)] p-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-bold text-[var(--ink)]">{store.name}</p>
                  <p className="text-xs text-[var(--muted)]">{store.slug}</p>
                </div>
                <span className={`badge ${store.id === currentStoreId ? "badge-success" : ""}`}>
                  {store.id === currentStoreId ? "สาขาปัจจุบัน" : "เปิดใช้งานอยู่"}
                </span>
              </div>
            </div>
          ))}
        </div>

        <p className="mt-4 rounded-[var(--radius-md)] border border-[var(--border)] bg-white px-3 py-2 text-sm text-[var(--muted)]">
          การเข้าสาขาอื่นใช้ตัวเลือกสาขาที่แถบด้านซ้ายของระบบ หลังเลือกแล้วระบบจะจำสาขาปัจจุบัน
          และหน้าต่าง ๆ จะอ่านข้อมูลตามสาขานั้น
        </p>
      </section>

      <section className="panel max-w-xl p-5">
        <h2 className="panel-title">เพิ่มสาขา</h2>
        {unavailableMessage && (
          <p className="mt-3 rounded-[var(--radius-md)] border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            {unavailableMessage}
          </p>
        )}
        <form ref={formRef} action={action} className="mt-4 space-y-3">
          <label className="block">
            <span className="label-muted">ชื่อสาขา</span>
            <input
              name="name"
              className="form-input mt-1 w-full"
              placeholder="เช่น สาขาเชียงใหม่"
              disabled={!canCreate || pending}
              maxLength={80}
              required
            />
          </label>
          <Button
            type="submit"
            variant="primary"
            className="min-h-11"
            loading={pending}
            loadingText="กำลังเพิ่มสาขา..."
            disabled={!canCreate}
          >
            เพิ่มสาขา
          </Button>
          {state.error && <p className="alert-danger">{state.error}</p>}
          {state.ok && <p className="text-sm font-bold text-emerald-700">เพิ่มสาขาแล้ว</p>}
        </form>
      </section>
    </div>
  );
}
