"use client";

import { useActionState } from "react";
import type { BuffetPackage } from "@/modules/buffet/types";
import { createBuffetPackageAction, toggleBuffetPackageAction, type BuffetSettingsState } from "./actions";

const INITIAL: BuffetSettingsState = { error: null, ok: false };

export function BuffetPackageSettings({
  packages,
  canManage,
}: {
  packages: BuffetPackage[];
  canManage: boolean;
}) {
  const [state, action, pending] = useActionState(createBuffetPackageAction, INITIAL);

  return (
    <div className="page-shell">
      <div className="page-header">
        <div>
          <h1 className="page-title">ตั้งค่าบุฟเฟต์</h1>
          <p className="page-kicker">แพ็กเกจบุฟเฟต์ (ราคาต่อหัว/เวลา) สำหรับเปิดโต๊ะ · สินค้าที่แสดงบน QR ตั้งได้ที่เมนูสินค้า</p>
        </div>
      </div>

      {canManage && (
        <section className="panel max-w-3xl p-5">
          <h2 className="panel-title mb-3">เพิ่มแพ็กเกจบุฟเฟต์</h2>
          <form action={action} className="grid gap-3 sm:grid-cols-3">
            <div className="sm:col-span-1">
              <label className="field-label">ชื่อแพ็กเกจ</label>
              <input name="name" type="text" required maxLength={80} placeholder="เช่น บุฟเฟต์หมูกระทะ" className="form-input" />
            </div>
            <div>
              <label className="field-label">ราคา/หัว (บาท)</label>
              <input name="pricePerGuest" type="number" min={0} step={1} required className="form-input" />
            </div>
            <div>
              <label className="field-label">เวลา (นาที, ไม่บังคับ)</label>
              <input name="durationMinutes" type="number" min={15} max={600} placeholder="เช่น 90" className="form-input" />
            </div>
            <div className="sm:col-span-3">
              {state.error && <p className="alert-danger mb-2">{state.error}</p>}
              {state.ok && <p className="mb-2 text-xs text-emerald-700">เพิ่มแพ็กเกจแล้ว</p>}
              <button type="submit" disabled={pending} className="btn-primary disabled:opacity-40">
                {pending ? "กำลังบันทึก..." : "เพิ่มแพ็กเกจ"}
              </button>
            </div>
          </form>
        </section>
      )}

      <section className="panel overflow-x-auto p-0">
        <h2 className="panel-title px-4 pt-4">แพ็กเกจทั้งหมด ({packages.length})</h2>
        {packages.length === 0 ? (
          <p className="p-4 text-sm text-[var(--muted)]">ยังไม่มีแพ็กเกจบุฟเฟต์</p>
        ) : (
          <table className="mt-3 w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-left text-xs text-[var(--muted)]">
                <th className="px-4 py-2 font-bold">ชื่อ</th>
                <th className="px-4 py-2 text-right font-bold">ราคา/หัว</th>
                <th className="px-4 py-2 font-bold">เวลา</th>
                <th className="px-4 py-2 font-bold">สถานะ</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {packages.map((p) => (
                <tr key={p.id} className="border-b border-[var(--border)] last:border-0">
                  <td className="px-4 py-2 font-bold text-[var(--ink)]">{p.name}</td>
                  <td className="px-4 py-2 text-right tabular-nums">฿{p.pricePerGuest.toLocaleString("th-TH")}</td>
                  <td className="px-4 py-2 text-[var(--muted)]">{p.durationMinutes ? `${p.durationMinutes} นาที` : "ไม่จำกัด"}</td>
                  <td className="px-4 py-2">
                    <span className={`badge ${p.active ? "badge-success" : "badge-warning"}`}>{p.active ? "เปิดใช้" : "ปิด"}</span>
                  </td>
                  <td className="px-4 py-2 text-right">
                    {canManage && (
                      <form action={toggleBuffetPackageAction}>
                        <input type="hidden" name="id" value={p.id} />
                        <input type="hidden" name="active" value={p.active ? "0" : "1"} />
                        <button type="submit" className="btn-secondary text-xs">{p.active ? "ปิด" : "เปิด"}</button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
