"use client";
import { useRef, useState, useTransition } from "react";
import type { PlatformBeamPublicSettings } from "@/modules/billing/beam-settings";
import { saveBeamBillingAction } from "./beam-actions";

export function BeamBillingSettings({ settings, webhookUrl }: { settings: PlatformBeamPublicSettings; webhookUrl: string }) {
  const form = useRef<HTMLFormElement>(null);
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  function submit(testOnly: boolean) {
    if (!form.current) return;
    const data = new FormData(form.current);
    start(async () => {
      try { setResult(await saveBeamBillingAction(data, testOnly)); }
      catch { setResult({ ok: false, message: "ดำเนินการไม่สำเร็จ กรุณาตรวจสิทธิ์และลองใหม่" }); }
    });
  }
  return <section className="panel p-5">
    <h2 className="text-lg font-bold">Beam — รับค่าชำระแพ็กเกจ StoreOS</h2>
    <p className="text-sm text-[var(--muted)]">บัญชีรับเงินของแพลตฟอร์ม · Beam ของแต่ละร้านใช้การตั้งค่าของร้านตามเดิม</p>
    <form ref={form} onSubmit={(e) => { e.preventDefault(); submit(false); }} className="mt-4 space-y-4">
      <fieldset disabled={pending} className="space-y-4 disabled:opacity-60">
        <label className="flex min-h-11 items-center gap-2"><input name="enabled" type="checkbox" defaultChecked={settings.enabled} /> เปิดใช้ Beam สำหรับชำระแพ็กเกจ</label>
        <label className="block">สภาพแวดล้อม<select name="environment" defaultValue={settings.environment} className="form-input"><option value="test">Playground — ไม่เปิดสิทธิ์แพ็กเกจจริง</option><option value="live">Production</option></select></label>
        <label className="block">Merchant ID<input name="merchantId" autoComplete="off" placeholder={settings.merchantMasked ?? "กรอก Merchant ID"} className="form-input" /></label>
        <label className="block">API key<input name="apiKey" type="password" autoComplete="new-password" placeholder={settings.configured ? "เว้นว่างเพื่อคงค่าเดิม" : "กรอก API key"} className="form-input" /></label>
        <label className="block">Webhook HMAC key<input name="webhookHmacKey" type="password" autoComplete="new-password" placeholder={settings.hasHmacKey ? "เว้นว่างเพื่อคงค่าเดิม" : "กรอก HMAC key จาก Beam"} className="form-input" /></label>
        <p className="text-sm break-all">Webhook: <code>{webhookUrl}</code><br />เลือก event <code>charge.succeeded</code> และ <code>charge.failed</code></p>
        <label className="flex min-h-11 items-center gap-2"><input name="fallbackEnabled" type="checkbox" defaultChecked={settings.fallbackEnabled} /> ใช้ PromptPay + Slip2Go อัตโนมัติ เมื่อ Beam ไม่พร้อมก่อนเริ่มรายการ</label>
        <label className="block">เลขบัญชีธนาคารผู้รับสำหรับตรวจสลิป<input name="fallbackAccount" inputMode="numeric" defaultValue={settings.fallbackAccount} className="form-input" /></label>
        <p className="text-sm text-[var(--muted)]">ใช้ QR PromptPay ที่ตั้งด้านล่าง เลขบัญชีต้องเป็นบัญชีปลายทางเดียวกัน ระบบส่งบัญชีและยอดให้ Slip2Go ตรวจ หากยืนยันไม่ได้ให้ติดต่อผู้ดูแล</p>
        <div className="flex flex-wrap gap-3"><button className="btn-secondary min-h-11" type="button" onClick={() => submit(true)}>ทดสอบเชื่อมต่อ</button><button className="btn-primary min-h-11" type="submit">{pending ? "กำลังดำเนินการ…" : "บันทึก Beam"}</button></div>
      </fieldset>
      {result && <p role="status" className={result.ok ? "text-emerald-700" : "text-red-700"}>{result.message}</p>}
    </form>
  </section>;
}
