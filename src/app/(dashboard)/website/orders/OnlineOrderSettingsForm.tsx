"use client";

import { useState, useTransition } from "react";
import type { OnlineOrderSettings } from "@/modules/online-orders/core";
import { saveOnlineOrderSettingsAction } from "./actions";

const numberOrNull = (v: string) => (v.trim() === "" ? null : Number(v));

export function OnlineOrderSettingsForm({
  initial,
  hasWebsite,
  originFromAttendance,
  memberTiers = [],
}: {
  initial: OnlineOrderSettings;
  hasWebsite: boolean;
  /** ร้านตั้งจุดลงเวลาเข้างานแล้ว → ใช้เป็นพิกัดร้าน (แก้ที่หน้าการเข้างาน) */
  originFromAttendance: boolean;
  /** R3: ระดับสมาชิกของร้าน (ตั้งเพดานเก็บเงินปลายทางรายระดับ) */
  memberTiers?: { rank: number; name: string }[];
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
  // ตัวอย่างค่าส่งต้องอยู่ในรัศมีส่งจริง (ไม่โชว์ราคาของระยะที่ส่งไม่ได้)
  const exampleKm = Math.round(Math.min(s.deliveryFreeKm + 2.3, s.deliveryRadiusKm) * 10) / 10;

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
              ส่งฟรีในระยะ (กม. แรก, 0 = ไม่มี)
              <input className={field} type="number" min={0} max={50} step={0.5} value={s.deliveryFreeKm} onChange={(e) => set("deliveryFreeKm", Number(e.target.value) || 0)} />
              {s.deliveryFreeKm > s.deliveryRadiusKm && <span className="mt-1 block text-xs text-red-600">ระยะส่งฟรีต้องไม่เกินรัศมีส่ง</span>}
            </label>
            <label className="block">
              ส่งฟรีเมื่อยอดถึง (เว้นว่าง = ไม่มี)
              <input className={field} type="number" min={0} value={s.deliveryFreeOver ?? ""} onChange={(e) => set("deliveryFreeOver", numberOrNull(e.target.value))} />
            </label>
          </div>
          <p className="text-xs text-[var(--muted)]">
            {s.deliveryFreeKm > 0 ? (
              <>
                ส่งฟรีในระยะ {s.deliveryFreeKm} กม. แรก · เกินคิด ค่าเริ่มต้น + ค่าต่อ กม. × ส่วนที่เกิน (ปัดขึ้นทีละ 0.5 กม.) — ตัวอย่าง{" "}
                {s.deliveryFreeKm} กม. = ฟรี
                {exampleKm > s.deliveryFreeKm && (
                  <>
                    {" "}· {exampleKm.toLocaleString("th-TH")} กม. ={" "}
                    {(s.deliveryBaseFee + s.deliveryFeePerKm * (Math.ceil((exampleKm - s.deliveryFreeKm) * 2) / 2)).toLocaleString("th-TH")} บาท
                  </>
                )}
              </>
            ) : (
              <>ค่าส่ง = ค่าเริ่มต้น + ค่าต่อ กม. × ระยะเส้นตรง (ปัดขึ้นทีละ 0.5 กม.) — ตัวอย่าง 2.3 กม. = {(s.deliveryBaseFee + s.deliveryFeePerKm * 2.5).toLocaleString("th-TH")} บาท</>
            )}
          </p>
        </fieldset>
        <fieldset className="space-y-2 rounded-lg border border-[var(--border)] p-3">
          <legend className="px-1 font-semibold">คูปองส่วนลด</legend>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={s.couponsEnabled} onChange={(e) => set("couponsEnabled", e.target.checked)} />
            ให้ลูกค้าใส่รหัสคูปองของร้านในหน้าสั่งออนไลน์
          </label>
          <p className="text-xs text-[var(--muted)]">
            ใช้คูปองเดียวกับหน้าร้าน (เมนู ลูกค้า › คูปอง) — คูปองที่ไม่ต้องการให้ใช้ออนไลน์ เอาติ๊ก “ใช้สั่งออนไลน์” ออก · ลดเฉพาะค่าอาหาร
            ไม่ลดค่าส่ง · คูปองเฉพาะลูกค้า/จำกัดต่อคนใช้ได้เมื่อสั่งผ่านหน้าสมาชิก · ยกเลิก/หมดเวลาจ่าย คืนสิทธิ์คูปองอัตโนมัติ
          </p>
        </fieldset>
        <fieldset className="space-y-2 rounded-lg border border-[var(--border)] p-3" disabled={!s.deliveryEnabled}>
          <legend className="px-1 font-semibold">เก็บเงินปลายทาง</legend>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={s.codEnabled} onChange={(e) => set("codEnabled", e.target.checked)} />
            ให้ลูกค้าเลือกเก็บเงินปลายทาง (ส่งถึงบ้านเท่านั้น — จ่ายเงินสด/โอนกับคนส่ง)
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              เพดานยอดต่อบิล (บาท)
              <input className={field} type="number" min={0} step={50} value={s.codMaxPerBill} onChange={(e) => set("codMaxPerBill", Number(e.target.value) || 0)} />
            </label>
            <label className="flex items-end gap-2 pb-2">
              <input type="checkbox" checked={s.codRequireOtp} onChange={(e) => set("codRequireOtp", e.target.checked)} />
              ยืนยันเบอร์ด้วย OTP (SMS)
            </label>
          </div>
          {memberTiers.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-semibold text-[var(--muted)]">เพดานตามระดับสมาชิก (เว้นว่าง = ใช้เพดานต่อบิล)</p>
              <div className="grid grid-cols-2 gap-2">
                {memberTiers.map((t) => (
                  <label key={t.rank} className="block text-sm">
                    {t.name}
                    <input
                      className={field}
                      type="number"
                      min={0}
                      step={50}
                      value={s.codTierCaps[String(t.rank)] ?? ""}
                      onChange={(e) => {
                        const next = { ...s.codTierCaps };
                        if (e.target.value.trim() === "") delete next[String(t.rank)];
                        else next[String(t.rank)] = Number(e.target.value) || 0;
                        set("codTierCaps", next);
                      }}
                    />
                  </label>
                ))}
              </div>
            </div>
          )}
          <p className="text-xs text-[var(--muted)]">
            ร้านกดรับก่อนจึงเริ่มทำ · ส่งสำเร็จเลือกเงินสด/โอน (เงินสดปิดบิลเข้าลิ้นชักตอนคนส่งคืนเงิน) · ส่งไม่สำเร็จ 2 ครั้งใน 90 วัน เบอร์นั้นใช้เก็บปลายทางไม่ได้
          </p>
        </fieldset>
        <fieldset className="space-y-2 rounded-lg border border-[var(--border)] p-3" disabled={!s.deliveryEnabled}>
          <legend className="px-1 font-semibold">รายได้พิเศษคนส่ง</legend>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={s.riderPayEnabled} onChange={(e) => set("riderPayEnabled", e.target.checked)} />
            ให้รายได้พิเศษพนักงานที่ออกไปส่ง (เข้าเงินเดือนอัตโนมัติเมื่อกด “สำเร็จ”)
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              % ของยอดอาหาร
              <input className={field} type="number" min={0} max={100} step={0.5} value={s.riderPayRate} onChange={(e) => set("riderPayRate", Number(e.target.value) || 0)} />
            </label>
            <label className="flex items-end gap-2 pb-2">
              <input type="checkbox" checked={s.riderPayIncludeFee} onChange={(e) => set("riderPayIncludeFee", e.target.checked)} />
              บวกค่าส่งที่ลูกค้าจ่ายให้คนส่งทั้งหมด
            </label>
          </div>
          <p className="text-xs text-[var(--muted)]">
            ตัวอย่าง: อาหาร 300 + ค่าส่ง 30 → คนส่งได้ ฿
            {(Math.round(((300 * s.riderPayRate) / 100) * 100) / 100 + (s.riderPayIncludeFee ? 30 : 0)).toLocaleString("th-TH")} ·
            เลือกคนส่งตอนกด “ออกไปส่ง” · อัตราล็อก ณ ตอนออกไปส่ง
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
