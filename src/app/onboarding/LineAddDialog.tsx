"use client";

import { useState } from "react";
import Link from "next/link";

interface LineAddDialogProps {
  open: boolean;
  addFriendUrl: string | null;
  providerReady: boolean;
}

export function LineAddDialog({ open, addFriendUrl, providerReady }: LineAddDialogProps) {
  const [visible, setVisible] = useState(open);
  if (!visible) return null;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/45 px-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-md rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xl">
        <p className="badge badge-brand mb-3">แจ้งเตือน LINE</p>
        <h2 className="text-xl font-extrabold text-[var(--ink)]">Add LINE เพื่อรับแจ้งเตือน</h2>
        <p className="mt-2 text-sm text-[var(--ink-2)]">
          เพิ่ม StoreOS เป็นเพื่อน แล้วไปตั้งค่าแจ้งเตือนเพื่อผูกบัญชี LINE กับร้านนี้
        </p>
        {!providerReady && (
          <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            LINE ยังไม่พร้อมใช้งาน สามารถตั้งค่าเพิ่มเติมภายหลังได้ที่หน้าตั้งค่าแจ้งเตือน
          </p>
        )}
        <div className="mt-5 flex flex-wrap gap-2">
          {addFriendUrl && (
            <a className="btn-primary" href={addFriendUrl} target="_blank" rel="noreferrer">
              Add LINE
            </a>
          )}
          <Link className="btn-secondary" href="/settings/notifications?lineLink=1">
            ไปตั้งค่าแจ้งเตือน
          </Link>
          <button className="btn-secondary" type="button" onClick={() => setVisible(false)}>
            ไว้ภายหลัง
          </button>
        </div>
      </div>
    </div>
  );
}
