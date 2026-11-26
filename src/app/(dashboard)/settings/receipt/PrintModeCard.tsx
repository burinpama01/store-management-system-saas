"use client";

import { useActionState } from "react";
import type { StorePrintMode } from "@/modules/printing/direct-print-repository";
import { savePrintModeAction, type PrintModeState } from "./print-mode-actions";

const INITIAL: PrintModeState = { error: null, saved: false };

/** การ์ด "วิธีพิมพ์ของร้าน" (เฟส D3) — Print Hub เดิม หรือ พิมพ์ตรงจากโปรแกรม StoreOS POS */
export function PrintModeCard({ mode, canEdit }: { mode: StorePrintMode; canEdit: boolean }) {
  const [state, action, pending] = useActionState(savePrintModeAction, INITIAL);

  return (
    <section className="card mb-4">
      <h2 className="text-base font-bold text-gray-900">วิธีพิมพ์ของร้าน</h2>
      <p className="mt-1 text-sm text-gray-600">เลือกว่าใบเสร็จและตั๋วครัวจะส่งไปเครื่องพิมพ์ทางไหน</p>
      <form action={action} className="mt-3 space-y-2">
        <label className="flex cursor-pointer gap-3 rounded-lg border border-gray-200 p-3 has-[:checked]:border-[var(--tenant-primary)]">
          <input type="radio" name="printMode" value="hub" defaultChecked={mode === "hub"} disabled={!canEdit} className="mt-1" />
          <span className="text-sm">
            <b>Print Hub (แบบเดิม)</b>
            <br />
            งานพิมพ์ผ่านคิวบนคลาวด์ ให้ Print Hub บนเครื่องแคชเชียร์พิมพ์ — iPad / มือถือ / ทุกจอสั่งพิมพ์ได้
          </span>
        </label>
        <label className="flex cursor-pointer gap-3 rounded-lg border border-gray-200 p-3 has-[:checked]:border-[var(--tenant-primary)]">
          <input type="radio" name="printMode" value="direct" defaultChecked={mode === "direct"} disabled={!canEdit} className="mt-1" />
          <span className="text-sm">
            <b>พิมพ์ตรงจากโปรแกรม StoreOS POS</b> (เร็วและเสถียรกว่า)
            <br />
            ใบเสร็จและตั๋วครัวส่งจากเครื่องแคชเชียร์เข้าเครื่องพิมพ์ IP โดยตรง ไม่ผ่านอินเทอร์เน็ต
            <br />
            <span className="text-amber-700">
              ต้องเปิดโปรแกรม StoreOS POS ไว้ตลอดเวลาร้านเปิด · iPad/มือถือ/จออื่นจะสั่งพิมพ์ไม่ได้ · ใช้ได้เฉพาะเครื่องพิมพ์ IP/WiFi
            </span>
            <br />
            <a href="/download/pos-launcher" className="font-semibold text-[var(--tenant-primary)] underline" rel="nofollow">
              ดาวน์โหลดโปรแกรม StoreOS POS สำหรับ Windows
            </a>
          </span>
        </label>
        {canEdit ? (
          <div className="flex items-center gap-3">
            <button type="submit" disabled={pending} className="btn-primary min-h-11 px-4 text-sm">
              {pending ? "กำลังบันทึก…" : "บันทึกวิธีพิมพ์"}
            </button>
            {state.saved && <span className="text-sm text-emerald-700">บันทึกแล้ว</span>}
            {state.error && <span role="alert" className="text-sm text-red-600">{state.error}</span>}
          </div>
        ) : (
          <p className="text-xs text-gray-500">ต้องมีสิทธิ์ตั้งค่าเครื่องพิมพ์จึงจะเปลี่ยนได้</p>
        )}
      </form>
    </section>
  );
}
