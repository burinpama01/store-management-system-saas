"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { readDeviceCapabilities } from "@/modules/devices/browser-capability";
import { recommendPrintChannels, type DeviceRecommendation } from "@/modules/devices/device-recommendation";
import type { DeviceCapabilities } from "@/modules/devices/capability";
import { PrinterConnectionPanel } from "@/modules/printing/PrinterConnectionPanel";

/** Task 10/D (v0.34.1) — D1: ask the governed AI to explain a printer error. */
function AiDiagnosisCard({ platform, channel }: { platform: string; channel: string }) {
  const [errorCode, setErrorCode] = useState("timeout");
  const [model, setModel] = useState("");
  const [result, setResult] = useState<{ ok: boolean; advice?: { summary: string; steps: string[] }; manualPath?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function ask() {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/ai/device-diagnosis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ errorCode, platform, channel, printerModel: model || undefined, requestId: crypto.randomUUID() }),
      });
      const data = (await res.json()) as { ok?: boolean; advice?: { summary: string; steps: string[] }; manualPath?: string };
      setResult({ ok: Boolean(data.ok), advice: data.advice, manualPath: data.manualPath });
    } catch {
      setResult({ ok: false, manualPath: "เชื่อมต่อไม่สำเร็จ — ทำตามขั้นตอนแนะนำในหน้านี้ก่อน" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] p-5">
      <h3 className="panel-title">ผู้ช่วย AI วินิจฉัยปัญหาเครื่องพิมพ์</h3>
      <p className="label-muted mt-1">AI ให้คำแนะนำเท่านั้น (ต้องกดยืนยันก่อนทำตามทุกขั้น) — ส่งเฉพาะรุ่นเครื่อง/รหัสปัญหา ไม่มีข้อมูลร้านหรือข้อมูลส่วนตัว</p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <label className="text-xs font-semibold text-[var(--ink-2)]">
          อาการ
          <select value={errorCode} onChange={(e) => setErrorCode(e.target.value)} className="form-input mt-1 w-full">
            <option value="timeout">พิมพ์แล้วค้าง/หมดเวลา</option>
            <option value="disconnected">หลุดการเชื่อมต่อ</option>
            <option value="unknown">อื่น ๆ / ไม่แน่ใจ</option>
          </select>
        </label>
        <label className="text-xs font-semibold text-[var(--ink-2)]">
          รุ่นเครื่องพิมพ์ (ถ้ารู้)
          <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="เช่น EPSON TM-T82III" maxLength={40} className="form-input mt-1 w-full" />
        </label>
      </div>
      <button type="button" onClick={ask} disabled={busy} className="btn-primary mt-3 min-h-11 w-full disabled:opacity-40">
        {busy ? "กำลังขอคำแนะนำ..." : "ขอคำแนะนำจาก AI"}
      </button>
      {result ? (
        result.ok && result.advice ? (
          <div className="mt-3 rounded-[var(--radius-md)] border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900" role="status">
            <p className="font-bold">{result.advice.summary}</p>
            <ol className="mt-2 list-decimal space-y-1 pl-5">
              {result.advice.steps.map((step, i) => (
                <li key={i}>{step}</li>
              ))}
            </ol>
            <p className="mt-2 text-xs font-semibold">ทุกขั้นตอนต้องกดยืนยันก่อนทำ — AI ไม่ทำการเปลี่ยนแปลงเอง</p>
          </div>
        ) : (
          <p className="mt-3 rounded-[var(--radius-md)] border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800" role="alert">
            {result.manualPath}
          </p>
        )
      ) : null}
    </div>
  );
}

export function DeviceCenter({ hasNetworkPrinter }: { hasNetworkPrinter: boolean }) {
  const [caps, setCaps] = useState<DeviceCapabilities | null>(null);
  const [recommendation, setRecommendation] = useState<DeviceRecommendation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const detect = useCallback(() => {
    setLoading(true);
    setError(null);
    readDeviceCapabilities()
      .then((next) => {
        setCaps(next);
        setRecommendation(recommendPrintChannels(next, { hasNetworkPrinter }));
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "ตรวจอุปกรณ์ไม่สำเร็จ"))
      .finally(() => setLoading(false));
  }, [hasNetworkPrinter]);

  useEffect(() => {
    detect();
  }, [detect]);

  const channelHints = caps
    ? {
        usb: caps.webUsb ? null : "อุปกรณ์/เบราว์เซอร์นี้ไม่รองรับ WebUSB",
        bluetooth: caps.webBluetooth ? null : "อุปกรณ์/เบราว์เซอร์นี้ไม่รองรับ Web Bluetooth",
      }
    : null;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="panel-title">อุปกรณ์เครื่องนี้เชื่อมอะไรได้บ้าง</h2>
          <p className="label-muted">
            {caps
              ? `ระบบตรวจจริงแล้ว: ${caps.os} · ${caps.formFactor} · ${caps.runtime === "storeos-app" ? "แอป StoreOS" : "เบราว์เซอร์"}`
              : "กำลังตรวจอุปกรณ์..."}
          </p>
        </div>
        <button type="button" onClick={detect} disabled={loading} className="btn-secondary min-h-11 px-3 text-xs disabled:opacity-40">
          {loading ? "กำลังตรวจ..." : "ตรวจใหม่"}
        </button>
      </div>

      {error ? (
        <p className="rounded-[var(--radius-md)] border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800" role="alert">
          ตรวจอุปกรณ์ไม่สำเร็จ ({error}) — ลองรีเฟรชหน้านี้
        </p>
      ) : null}

      {recommendation?.primary ? (
        <div className="rounded-[var(--radius-lg)] border border-[var(--tenant-primary)] bg-[var(--tenant-primary-soft)] p-5">
          <span className="badge badge-brand mb-2">ช่องทางที่แนะนำสำหรับเครื่องนี้</span>
          <h3 className="text-lg font-extrabold text-[var(--ink)]">{recommendation.primary.title}</h3>
          <p className="mt-1 text-sm text-[var(--ink-2)]">{recommendation.primary.reason}</p>
          {recommendation.primary.href ? (
            <Link href={recommendation.primary.href} className="btn-primary mt-3 inline-flex min-h-11 items-center px-4 text-sm">
              ไปตั้งค่าช่องทางนี้
            </Link>
          ) : null}
        </div>
      ) : null}

      {recommendation && recommendation.unknown.length > 0 ? (
        <div className="rounded-[var(--radius-lg)] border border-amber-200 bg-amber-50 p-4">
          <h3 className="text-sm font-extrabold text-amber-900">ยังตรวจไม่ได้</h3>
          <ul className="mt-1 space-y-1 text-sm text-amber-800">
            {recommendation.unknown.map((opt) => (
              <li key={opt.id}>
                <strong>{opt.title}</strong> — {opt.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {recommendation && recommendation.fallbacks.length > 0 ? (
        <div>
          <h3 className="mb-2 text-sm font-extrabold text-[var(--ink)]">ช่องทางสำรองที่ทำได้จริง</h3>
          <div className="space-y-2">
            {recommendation.fallbacks.map((opt) => (
              <div key={opt.id} className="flex items-start justify-between gap-3 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-3">
                <div className="min-w-0">
                  <p className="text-sm font-bold text-[var(--ink)]">{opt.title}</p>
                  <p className="text-xs text-[var(--muted)]">{opt.reason}</p>
                </div>
                {opt.href ? (
                  <Link href={opt.href} className="btn-secondary shrink-0 px-3 py-2 text-xs">
                    เปิด
                  </Link>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {recommendation && recommendation.unavailable.length > 0 ? (
        <div>
          <h3 className="mb-2 text-sm font-extrabold text-[var(--ink)]">ช่องทางที่เครื่องนี้ใช้ไม่ได้ (พร้อมเหตุผล)</h3>
          <div className="space-y-2">
            {recommendation.unavailable.map((opt) => (
              <div key={opt.id} className="rounded-[var(--radius-md)] border border-dashed border-[var(--border)] bg-[var(--surface-muted)] p-3 opacity-80">
                <p className="text-sm font-bold text-[var(--ink-2)]">{opt.title}</p>
                <p className="text-xs text-[var(--muted)]">{opt.reason}</p>
              </div>
            ))}
          </div>
        </div>
      ) : null}


      {caps ? <AiDiagnosisCard platform={caps.os} channel={caps.recommendedPrint} /> : null}
      <div>
        <h3 className="mb-2 text-sm font-extrabold text-[var(--ink)]">เชื่อมต่อ/ทดสอบพิมพ์เลย</h3>
        <PrinterConnectionPanel capabilityHints={channelHints} />
        <p className="mt-2 text-xs text-[var(--muted)]">
          ตั้งค่า Print Hub (token/ตัวติดตั้ง) ที่{" "}
          <Link href="/settings/print-hub" className="font-bold underline">
            หน้า Print Hub
          </Link>{" "}
          · จัดการเครื่องพิมพ์ที่บันทึกไว้ที่{" "}
          <Link href="/settings/receipt" className="font-bold underline">
            หน้าเครื่องพิมพ์
          </Link>
        </p>
      </div>
    </div>
  );
}