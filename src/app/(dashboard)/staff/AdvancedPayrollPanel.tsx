"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, useConfirm } from "@/shared/components/ui";
import {
  PAYROLL_FEATURE_KEYS,
  PAYROLL_FEATURE_LABEL,
  PAYROLL_FEATURE_REQUIRES,
  SALES_CHANNELS,
  SALES_CHANNEL_LABEL,
  formatTiers,
  type AdvancedPayrollSettings,
  type PayrollFeatureKey,
} from "@/modules/hr/advanced/settings";
import type { StoreSkill } from "@/modules/hr/advanced/repository";
import { addStoreSkillAction, archiveStoreSkillAction, saveAdvancedPayrollSettingsAction } from "./advanced-actions";

const INPUT = "mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 text-sm";
const HINT = "mt-1 block text-[11px] font-normal text-gray-400";

const FEATURE_HINT: Record<PayrollFeatureKey, string> = {
  salesTargetBar: "แสดงยอดขายวันนี้ + อีกเท่าไหร่ถึงโบนัส ในหน้า POS และหน้าลงเวลา (ทุกตำแหน่ง เฉพาะวันนี้)",
  salesBonus: "โบนัสต่อคนตามยอดขายรายวัน เฉพาะพนักงานประจำที่ทำเต็มวัน",
  skillPay: "จ่ายตามจำนวนทักษะที่ทำได้ เฉพาะพนักงานประจำ (ได้ทักษะใหม่ มีผลงวดถัดไป)",
  seniorityPay: "จ่ายตามอายุงาน เฉพาะพนักงานประจำ (ครบขั้นกลางงวด มีผลงวดถัดไป)",
  socialSecurity: "หักประกันสังคมตามอัตรา/ฐานที่ตั้ง (ไม่เปิด = ไม่แสดงในสลิป)",
  withholdingTax: "หักภาษี ณ ที่จ่าย กรอกเอง หรือ % คงที่ต่อคน (ไม่เปิด = ไม่แสดงในสลิป)",
  payCycle: "ตั้งรอบ/วันจ่าย ระบบปิดงวดให้เองหลังเวลาปิดร้านของวันสุดท้าย และเก็บสลิปถาวร",
  myPayslip: "พนักงานเปิดดู/บันทึกสลิปของตัวเองได้ เฉพาะงวดที่ปิดแล้ว ตั้งแต่วันจ่าย",
  payrollNotifications: "แจ้งเตือนผ่านแอปมือถือ: สลิปออก, ปิดงวด, ใกล้วันจ่าย, ยอดถึงขั้น ฯลฯ",
};

export function AdvancedPayrollPanel({
  entitled,
  settings,
  skills,
}: {
  entitled: boolean;
  /** ค่าที่ร้านตั้งไว้ (ไม่ใช่ค่าหลังล็อกแพ็ก) — หมดแพ็กแล้วกลับมาต่ออายุ ต้องเห็นค่าเดิม */
  settings: AdvancedPayrollSettings;
  skills: StoreSkill[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sw, setSw] = useState(settings.switches);
  const { confirm, confirmDialog } = useConfirm();

  function run(action: () => Promise<{ error: string | null }>, ok?: string) {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const r = await action();
      if (r.error) setError(r.error);
      else {
        if (ok) setNotice(ok);
        router.refresh();
      }
    });
  }

  function toggle(key: PayrollFeatureKey, on: boolean) {
    setSw((prev) => {
      const next = { ...prev, [key]: on };
      // ปิดตัวแม่ = ปิดตัวลูก; เปิดตัวลูก = เปิดตัวแม่ให้
      for (const [child, parent] of Object.entries(PAYROLL_FEATURE_REQUIRES) as [PayrollFeatureKey, PayrollFeatureKey][]) {
        if (key === parent && !on) next[child] = false;
        if (key === child && on) next[parent] = true;
      }
      return next;
    });
  }

  const locked = !entitled;

  return (
    <section className="space-y-4">
      {confirmDialog}
      {locked && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          <p className="font-semibold">เงินเดือนขั้นสูง ยังไม่อยู่ในแพ็กเกจของร้าน</p>
          <p className="mt-1">มีในแพ็ก Enterprise หรือซื้อ &quot;เงินเดือนขั้นสูง&quot; เพิ่มในแพ็ก Business — ระหว่างนี้ทุกฟีเจอร์ด้านล่างทำงานเหมือนปิด (ค่าที่ตั้งไว้ไม่หาย)</p>
          <a href="/settings/billing" className="btn-secondary mt-3 inline-flex min-h-11 items-center px-4 text-sm">ไปหน้าแพ็กเกจ</a>
        </div>
      )}
      {error && <p className="rounded-lg bg-red-50 px-4 py-2 text-sm text-red-600">{error}</p>}
      {notice && <p className="rounded-lg bg-green-50 px-4 py-2 text-sm text-green-700" aria-live="polite">{notice}</p>}

      <form
        action={(fd) => run(() => saveAdvancedPayrollSettingsAction(fd), "บันทึกตั้งค่าเงินเดือนขั้นสูงแล้ว")}
        className="space-y-4"
      >
        <fieldset disabled={locked} className="space-y-4 disabled:opacity-60">
          <div className="rounded-lg border border-gray-200 bg-white p-4">
            <h2 className="text-sm font-bold text-gray-900">เปิด/ปิดฟีเจอร์ (ไม่เปิด = ไม่แสดงเลย)</h2>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {PAYROLL_FEATURE_KEYS.map((key) => (
                <label key={key} className="flex cursor-pointer items-start gap-3 rounded-lg border border-gray-200 p-3">
                  <input
                    type="checkbox"
                    name={`feat_${key}`}
                    checked={sw[key]}
                    onChange={(e) => toggle(key, e.target.checked)}
                    className="mt-1 h-5 w-5 accent-orange-500"
                  />
                  <span>
                    <span className="block text-sm font-semibold text-gray-900">{PAYROLL_FEATURE_LABEL[key]}</span>
                    <span className="block text-xs text-gray-500">{FEATURE_HINT[key]}</span>
                    {PAYROLL_FEATURE_REQUIRES[key] && (
                      <span className="block text-[11px] text-gray-400">ต้องเปิด &quot;{PAYROLL_FEATURE_LABEL[PAYROLL_FEATURE_REQUIRES[key] as PayrollFeatureKey]}&quot; ด้วย</span>
                    )}
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div className="rounded-lg border border-gray-200 bg-white p-4">
            <h2 className="text-sm font-bold text-gray-900">รอบเงินเดือน</h2>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="text-xs font-medium text-gray-600">
                เริ่มรอบวันที่ (1–28)
                <input name="payCycleStartDay" type="number" min={1} max={28} defaultValue={settings.payCycleStartDay} className={INPUT} />
                <span className={HINT}>เช่น 24 → งวด 24 ต.ค. – 23 พ.ย.</span>
              </label>
              <label className="text-xs font-medium text-gray-600">
                วันจ่ายเงิน
                <select name="payDay" defaultValue={settings.payDay} className={INPUT}>
                  <option value={0}>วันสุดท้ายของเดือน</option>
                  {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                    <option key={d} value={d}>วันที่ {d}{d >= 29 ? " (เดือนที่สั้นกว่า = วันสุดท้าย)" : ""}</option>
                  ))}
                </select>
                <span className={HINT}>อยู่เดือนเดียวกับวันจบงวด ถ้าตกก่อนวันจบงวดจะเลื่อนไปเดือนถัดไป · พนักงานเห็นสลิปวันนี้</span>
              </label>
            </div>
          </div>

          <div className="rounded-lg border border-gray-200 bg-white p-4">
            <h2 className="text-sm font-bold text-gray-900">ขั้นค่าทักษะ / ค่าอายุงาน</h2>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="text-xs font-medium text-gray-600">
                ค่าทักษะ: จำนวนทักษะ=เงินต่องวด
                <input name="skillTiers" defaultValue={formatTiers(settings.skillTiers, "count")} className={INPUT} />
                <span className={HINT}>เช่น 1=500, 2=1000, 3=1500 (ทักษะเกินขั้นสูงสุดได้ขั้นสูงสุด)</span>
              </label>
              <label className="text-xs font-medium text-gray-600">
                ค่าอายุงาน: เดือน=เงินต่องวด
                <input name="seniorityTiers" defaultValue={formatTiers(settings.seniorityTiers, "months")} className={INPUT} />
                <span className={HINT}>เช่น 6=300, 12=600, 24=900, 36=1200 (นับจากวันเริ่มงาน)</span>
              </label>
            </div>
          </div>

          <div className="rounded-lg border border-gray-200 bg-white p-4">
            <h2 className="text-sm font-bold text-gray-900">โบนัสยอดขายรายวัน</h2>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="text-xs font-medium text-gray-600 sm:col-span-2">
                ขั้นยอดขาย=โบนัสต่อคน
                <input name="salesBonusTiers" defaultValue={formatTiers(settings.salesBonusTiers, "minSales")} className={INPUT} />
                <span className={HINT}>เช่น 30000=100, 35000=150, 40000=250 · วันขายตัดตามเวลาปิดร้าน (ตั้งที่ตั้งค่าร้าน)</span>
              </label>
              <div className="text-xs font-medium text-gray-600">
                นับยอดจากช่องทาง
                <div className="mt-1 flex flex-wrap gap-2">
                  {SALES_CHANNELS.map((c) => (
                    <label key={c} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-gray-300 px-3">
                      <input type="checkbox" name="salesBonusChannels" value={c} defaultChecked={settings.salesBonusChannels.includes(c)} className="accent-orange-500" />
                      {SALES_CHANNEL_LABEL[c]}
                    </label>
                  ))}
                </div>
                <span className={HINT}>ยอดหลังหักส่วนลด ไม่รวมบิลยกเลิก/คืนเงิน</span>
              </div>
              <label className="text-xs font-medium text-gray-600">
                มาสายเกิน (นาที) = ไม่ได้โบนัสวันนั้น
                <input name="salesBonusLateMaxMinutes" type="number" min={0} max={600} defaultValue={settings.salesBonusLateMaxMinutes ?? ""} placeholder="ว่าง = มาสายไม่มีผล" className={INPUT} />
              </label>
              <label className="text-xs font-medium text-gray-600">
                โบนัสทำสถิติยอดขายสูงสุด (ต่อคน)
                <input name="salesRecordBonus" type="number" min={0} step="0.01" defaultValue={settings.salesRecordBonus} className={INPUT} />
              </label>
              <label className="text-xs font-medium text-gray-600">
                วันทำสถิติ
                <select name="salesRecordMode" defaultValue={settings.salesRecordMode} className={INPUT}>
                  <option value="replace">ได้โบนัสสถิติแทนขั้นปกติ</option>
                  <option value="stack">ได้ขั้นปกติ + โบนัสสถิติ</option>
                </select>
              </label>
              <label className="text-xs font-medium text-gray-600">
                ยอดสถิติเริ่มต้น
                <input name="salesRecordBaseline" type="number" min={0} step="0.01" defaultValue={settings.salesRecordBaseline} className={INPUT} />
                <span className={HINT}>ระบบเทียบกับยอดสูงสุดในประวัติด้วย — ตั้งไว้กันช่วงแรกทำสถิติบ่อย</span>
              </label>
            </div>
          </div>

          <div className="rounded-lg border border-gray-200 bg-white p-4">
            <h2 className="text-sm font-bold text-gray-900">ประกันสังคม / ภาษี</h2>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <label className="text-xs font-medium text-gray-600">
                อัตราประกันสังคม (%)
                <input name="ssoRate" type="number" min={0} max={20} step="0.01" defaultValue={settings.ssoRate} className={INPUT} />
              </label>
              <label className="text-xs font-medium text-gray-600">
                ฐานต่ำสุด
                <input name="ssoWageFloor" type="number" min={0} step="0.01" defaultValue={settings.ssoWageFloor} className={INPUT} />
              </label>
              <label className="text-xs font-medium text-gray-600">
                ฐานสูงสุด
                <input name="ssoWageCeiling" type="number" min={0} step="0.01" defaultValue={settings.ssoWageCeiling} className={INPUT} />
                <span className={HINT}>ตรวจประกาศสำนักงานประกันสังคมล่าสุดก่อนใช้จริง</span>
              </label>
              <label className="text-xs font-medium text-gray-600 sm:col-span-3">
                ภาษีหัก ณ ที่จ่าย
                <select name="whtMode" defaultValue={settings.whtMode} className={INPUT}>
                  <option value="manual">กรอกเองทุกงวด (เพิ่มรายการปรับ &quot;ภาษีหัก ณ ที่จ่าย&quot;)</option>
                  <option value="percent">% คงที่ต่อคน (ตั้งในข้อมูลพนักงาน)</option>
                </select>
              </label>
            </div>
          </div>

          <Button type="submit" variant="primary" loading={isPending} loadingText="กำลังบันทึก..." className="min-h-11 px-6 text-sm">
            บันทึกตั้งค่าเงินเดือนขั้นสูง
          </Button>
        </fieldset>
      </form>

      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="text-sm font-bold text-gray-900">รายการทักษะของร้าน</h2>
        <p className="text-xs text-gray-500">ติ๊กทักษะให้พนักงานได้ในแท็บพนักงาน · เลิกใช้ทักษะ = ถอนจากทุกคน ณ วันนี้ (มีผลงวดถัดไป)</p>
        <ul className="mt-3 flex flex-wrap gap-2">
          {skills.length === 0 && <li className="text-sm text-gray-400">ยังไม่มีทักษะ</li>}
          {skills.map((s) => (
            <li key={s.id} className="inline-flex items-center gap-2 rounded-full bg-gray-100 px-3 py-1 text-sm">
              {s.name}
              <button
                type="button"
                disabled={locked || isPending}
                onClick={async () => {
                  const ok = await confirm({
                    title: `เลิกใช้ทักษะ "${s.name}"?`,
                    message: "พนักงานที่มีทักษะนี้จะถูกถอน ณ วันนี้ (มีผลงวดถัดไป) ประวัติเดิมยังอยู่",
                    confirmLabel: "เลิกใช้",
                  });
                  if (ok) run(() => archiveStoreSkillAction(s.id), "เลิกใช้ทักษะแล้ว");
                }}
                className="min-h-8 px-1 text-xs text-red-500 disabled:opacity-40"
                aria-label={`เลิกใช้ทักษะ ${s.name}`}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
        <form action={(fd) => run(() => addStoreSkillAction(fd), "เพิ่มทักษะแล้ว")} className="mt-3 flex gap-2">
          <input name="name" maxLength={60} placeholder="เช่น เสิร์ฟ, แคชเชียร์, รับออเดอร์, เช็กสต็อก" disabled={locked} className="min-h-11 flex-1 rounded-lg border border-gray-300 px-3 text-sm" />
          <Button type="submit" variant="secondary" loading={isPending} disabled={locked} className="min-h-11 px-4 text-sm">เพิ่ม</Button>
        </form>
      </div>
    </section>
  );
}
