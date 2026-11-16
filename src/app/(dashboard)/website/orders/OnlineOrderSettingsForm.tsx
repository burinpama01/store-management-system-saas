"use client";

import { useState, useTransition } from "react";
import type { OnlineOrderSettings } from "@/modules/online-orders/core";
import { saveOnlineOrderSettingsAction } from "./actions";

const numberOrNull = (v: string) => (v.trim() === "" ? null : Number(v));

export function OnlineOrderSettingsForm({
  initial,
  hasWebsite,
  originFromAttendance,
}: {
  initial: OnlineOrderSettings;
  hasWebsite: boolean;
  /** ร้านตั้งจุดลงเวลาเข้างานแล้ว → ใช้เป็นพิกัดร้าน (แก้ที่หน้าการเข้างาน) */
  originFromAttendance: boolean;
}) {
  const [s, setS] = useState(initial);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const set = <K extends keyof OnlineOrderSettings>(key: K, value: OnlineOrderSettings[K]) => setS((prev) => ({ ...prev, [key]: value }));

  const useHere = () => {
    if (!navigator.geolocation) return setMessage("อุปกรณ์นี้หาตำแหน่งไม่ได้ — กรอกพิกัดเอง");
    navigator.geolocation.getCurrentPosition(
      (pos) => setS((prev) => ({ ...prev, originLat: Number(pos.coords.latitude.toFixed(6)), originLng: Number(pos.coords.longitude.toFixed(6)) })),
      () => setMessage("หาตำแหน่งไม่ได้ — อนุญาตตำแหน่งหรือกรอกพิกัดเอง"),
      { enableHighAccuracy: true, timeout: 15000 },
    );
  };

  const save = () => {
    setMessage(null);
    startTransition(async () => {
      const res = await saveOnlineOrderSettingsAction(s);
      setMessage(res.ok ? "บันทึกแล้ว" : res.error);
    });
  };

  const field = "input w-full";
  return (
    <section className="panel space-y-4 p-4 text-sm">
      <div>
        <h2 className="text-base font-semibold">ตั้งค่าสั่งออนไลน์</h2>
        <p className="text-[var(--muted)]">ลูกค้าจ่ายด้วย Beam เท่านั้น · ปุ่ม “สั่งออนไลน์” จะขึ้นใต้บล็อกเมนูบนเว็บร้าน</p>
        {!hasWebsite && <p className="text-amber-700">ยังไม่ได้สร้างเว็บไซต์ร้าน — สร้างก่อนที่หน้าเว็บไซต์ร้าน</p>}
      </div>
      <label className="flex items-center gap-2 font-medium">
        <input type="checkbox" checked={s.enabled} onChange={(e) => set("enabled", e.target.checked)} />
        เปิดรับสั่งออนไลน์
      </label>
      <div className="grid gap-4 md:grid-cols-2">
        <fieldset className="space-y-2 rounded-lg border p-3">
          <legend className="px-1 font-medium">รับที่ร้าน</legend>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={s.pickupEnabled} onChange={(e) => set("pickupEnabled", e.target.checked)} />
            เปิดรับที่ร้าน
          </label>
          <label className="block">
            เวลาเตรียม (นาที)
            <input className={field} type="number" min={0} max={240} value={s.prepMinutes} onChange={(e) => set("prepMinutes", Number(e.target.value))} />
          </label>
          <label className="block">
            ยอดขั้นต่ำ (บาท)
            <input className={field} type="number" min={0} value={s.minOrder} onChange={(e) => set("minOrder", Number(e.target.value))} />
          </label>
        </fieldset>
        <fieldset className="space-y-2 rounded-lg border p-3">
          <legend className="px-1 font-medium">ร้านส่งเอง</legend>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={s.deliveryEnabled} onChange={(e) => set("deliveryEnabled", e.target.checked)} />
            เปิดส่งถึงบ้าน
          </label>
          {originFromAttendance ? (
            <p className="rounded bg-green-50 px-2 py-1 text-green-800">
              📍 พิกัดร้าน = จุดลงเวลาเข้างาน ({s.originLat?.toFixed(5)}, {s.originLng?.toFixed(5)}) — แก้ได้ที่หน้า{" "}
              <a href="/attendance" className="underline">การเข้างาน</a>
            </p>
          ) : (
            <>
              <p className="text-amber-700">ยังไม่ได้ตั้งจุดลงเวลาเข้างาน — ตั้งที่หน้าการเข้างาน (แนะนำ ใช้ร่วมกัน) หรือกรอกพิกัดร้านที่นี่</p>
              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  ละติจูดร้าน
                  <input className={field} type="number" step="0.000001" value={s.originLat ?? ""} onChange={(e) => set("originLat", numberOrNull(e.target.value))} />
                </label>
                <label className="block">
                  ลองจิจูดร้าน
                  <input className={field} type="number" step="0.000001" value={s.originLng ?? ""} onChange={(e) => set("originLng", numberOrNull(e.target.value))} />
                </label>
              </div>
              <button type="button" className="btn-secondary text-xs" onClick={useHere}>📍 ใช้ตำแหน่งที่ยืนอยู่ตอนนี้ (ยืนที่ร้าน)</button>
            </>
          )}
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              รัศมีส่ง (กม.)
              <input className={field} type="number" min={0.5} max={50} step={0.5} value={s.deliveryRadiusKm} onChange={(e) => set("deliveryRadiusKm", Number(e.target.value))} />
            </label>
            <label className="block">
              ค่าส่งเริ่มต้น (บาท)
              <input className={field} type="number" min={0} value={s.deliveryBaseFee} onChange={(e) => set("deliveryBaseFee", Number(e.target.value))} />
            </label>
            <label className="block">
              ค่าส่งต่อ กม. (บาท)
              <input className={field} type="number" min={0} value={s.deliveryFeePerKm} onChange={(e) => set("deliveryFeePerKm", Number(e.target.value))} />
            </label>
            <label className="block">
              ส่งฟรีเมื่อยอดถึง (เว้นว่าง = ไม่มี)
              <input className={field} type="number" min={0} value={s.deliveryFreeOver ?? ""} onChange={(e) => set("deliveryFreeOver", numberOrNull(e.target.value))} />
            </label>
          </div>
          <p className="text-xs text-[var(--muted)]">
            ค่าส่ง = ค่าเริ่มต้น + ค่าต่อ กม. × ระยะเส้นตรง (ปัดขึ้นทีละ 0.5 กม.) — ตัวอย่าง 2.3 กม. = {(s.deliveryBaseFee + s.deliveryFeePerKm * 2.5).toLocaleString("th-TH")} บาท
          </p>
        </fieldset>
      </div>
      <div className="flex items-center gap-3">
        <button type="button" onClick={save} disabled={pending} className="btn-primary">{pending ? "กำลังบันทึก..." : "บันทึก"}</button>
        {message && <span className={message === "บันทึกแล้ว" ? "text-green-700" : "text-red-700"}>{message}</span>}
      </div>
    </section>
  );
}
