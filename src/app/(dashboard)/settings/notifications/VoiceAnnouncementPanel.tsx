"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import {
  pickThaiVoice,
  primeVoices,
  readVoicePreference,
  resolveVoiceEnabled,
  speakAnnouncement,
  writeVoicePreference,
  type VoicePreference,
} from "@/shared/notifications/announce";
import { setNotificationVoiceEnabledAction } from "./actions";
import { INITIAL_ACTION_FEEDBACK_STATE } from "./feedback";

interface Props {
  storeEnabled: boolean;
  canManage: boolean;
}

const DEVICE_OPTIONS: Array<{ value: VoicePreference; label: string; hint: string }> = [
  { value: "store", label: "ตามค่าของร้าน", hint: "ใช้ค่าที่ตั้งไว้ด้านบน" },
  { value: "on", label: "เปิดเฉพาะเครื่องนี้", hint: "พูดเสมอ แม้ร้านจะปิดไว้" },
  { value: "off", label: "ปิดเฉพาะเครื่องนี้", hint: "ใช้เสียง beep เหมือนเดิม" },
];

/**
 * ตั้งค่าเสียงพูดแจ้งเตือน 2 ชั้น
 *   ชั้นร้าน  — คอลัมน์ใน DB มีผลกับทุกเครื่องที่ยังไม่ได้ตั้งเอง
 *   ชั้นเครื่อง — localStorage ของเครื่องนี้ ทับค่าของร้านเสมอ
 *
 * ปุ่มทดสอบสำคัญกว่าที่คิด: เสียงไทยเป็นของ Windows/Android ไม่ใช่ของเว็บ
 * ถ้าเครื่องร้านไม่มีเสียงไทยติดตั้งอยู่ ระบบจะถอยไป beep เงียบ ๆ โดยไม่มีใครรู้
 * — ต้องกดปุ่มนี้บนเครื่องร้านจริงเพื่อพิสูจน์ก่อนจะไว้ใจฟีเจอร์นี้ในเวลาเปิดร้าน
 */
export function VoiceAnnouncementPanel({ storeEnabled, canManage }: Props) {
  const [state, formAction, pending] = useActionState(
    setNotificationVoiceEnabledAction,
    INITIAL_ACTION_FEEDBACK_STATE,
  );
  const formRef = useRef<HTMLFormElement>(null);
  const [optimisticStore, setOptimisticStore] = useState<boolean | null>(null);
  const [devicePref, setDevicePref] = useState<VoicePreference>("store");
  const [thaiVoiceName, setThaiVoiceName] = useState<string | null>(null);
  const [probed, setProbed] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  const checked = state.status === "error" && !pending ? storeEnabled : optimisticStore ?? storeEnabled;
  const effective = resolveVoiceEnabled(checked, devicePref);

  useEffect(() => {
    primeVoices();
    let intervalId = 0;
    // getVoices() ว่างในครั้งแรกบน Chromium แล้วค่อยมีทีหลัง — เช็คซ้ำสั้น ๆ ก่อนสรุปว่าไม่มีเสียงไทย
    const probe = () => {
      const synth = window.speechSynthesis;
      if (!synth) {
        setProbed(true);
        return true;
      }
      const voice = pickThaiVoice(synth.getVoices() ?? []);
      if (voice) {
        setThaiVoiceName(voice.name);
        setProbed(true);
        return true;
      }
      return false;
    };
    // อ่านค่าเครื่อง/รายการเสียงนอกจังหวะ render (localStorage + speechSynthesis เป็นของนอก React)
    const startId = window.setTimeout(() => {
      setDevicePref(readVoicePreference());
      if (probe()) return;
      let tries = 0;
      intervalId = window.setInterval(() => {
        tries += 1;
        if (probe() || tries >= 10) {
          window.clearInterval(intervalId);
          setProbed(true);
        }
      }, 300);
    }, 0);
    return () => {
      window.clearTimeout(startId);
      if (intervalId) window.clearInterval(intervalId);
    };
  }, []);

  function selectDevicePref(next: VoicePreference) {
    setDevicePref(next);
    writeVoicePreference(next);
  }

  function runTest() {
    const spoken = speakAnnouncement("ออเดอร์เดลิเวอรีเข้าใหม่");
    setTestResult(
      spoken
        ? "พูดออกเสียงแล้ว — ถ้าไม่ได้ยิน ให้ตรวจระดับเสียงของเครื่องและลำโพง"
        : "เครื่องนี้ยังไม่มีเสียงภาษาไทย ระบบจะใช้เสียง beep แทน (ติดตั้งเสียงไทยได้ที่ Windows: การตั้งค่า → เวลาและภาษา → เสียงพูด)",
    );
  }

  return (
    <div className="rounded-md border border-[var(--color-border)] bg-white p-4">
      <h2 className="text-base font-bold text-[var(--color-text-primary)]">
        🔊 อ่านออกเสียงแจ้งเตือน
      </h2>
      <p className="mt-1 text-sm text-[var(--color-text-muted)]">
        แทนเสียง beep ด้วยประโยคภาษาไทย เช่น &quot;ออเดอร์โต๊ะ 4 เข้าใหม่&quot; หรือ
        &quot;ออเดอร์เดลิเวอรีเข้าใหม่&quot; — ดังซ้ำจนกว่าจะปิดหน้าต่างแจ้งเตือน
        ใช้ได้ทั้งหน้าแดชบอร์ดและหน้า POS
      </p>

      <form ref={formRef} action={formAction} aria-busy={pending} className="mt-3">
        <label className="flex min-h-11 items-center gap-2">
          <input
            type="checkbox"
            name="enabled"
            checked={checked}
            onChange={(event) => {
              setOptimisticStore(event.currentTarget.checked);
              formRef.current?.requestSubmit();
            }}
            disabled={!canManage || pending}
            className="h-4 w-4 accent-teal-700 disabled:cursor-not-allowed"
          />
          <span className="text-sm font-semibold text-[var(--color-text-primary)]">
            เปิดเสียงพูดสำหรับทุกเครื่องของร้านนี้
          </span>
        </label>
        <span
          aria-live="polite"
          className={`mt-1 block text-xs font-semibold ${
            state.status === "error" ? "text-red-700" : "text-[var(--color-text-muted)]"
          }`}
        >
          {pending
            ? "กำลังบันทึก..."
            : state.status === "error"
              ? state.message
              : state.status === "success"
                ? "บันทึกแล้ว"
                : "บันทึกอัตโนมัติ"}
        </span>
      </form>

      <fieldset className="mt-4 border-t border-[var(--color-border)] pt-3">
        <legend className="text-sm font-bold text-[var(--color-text-primary)]">เครื่องนี้</legend>
        <p className="text-xs text-[var(--color-text-muted)]">
          ค่าเฉพาะเครื่องนี้เท่านั้น (เก็บในเบราว์เซอร์) — ใช้ปิดเสียงพูดของเครื่องที่ตั้งติดลูกค้า
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {DEVICE_OPTIONS.map((option) => (
            <label
              key={option.value}
              className={`min-h-11 cursor-pointer rounded-md border px-3 py-2 text-xs font-semibold ${
                devicePref === option.value
                  ? "border-teal-600 bg-teal-50 text-teal-800"
                  : "border-[var(--color-border)] text-[var(--color-text-muted)]"
              }`}
            >
              <input
                type="radio"
                name="devicePref"
                value={option.value}
                checked={devicePref === option.value}
                onChange={() => selectDevicePref(option.value)}
                className="sr-only"
              />
              {option.label}
              <span className="mt-0.5 block font-normal">{option.hint}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-[var(--color-border)] pt-3">
        <button type="button" onClick={runTest} className="btn-secondary min-h-11 px-4 text-sm">
          ทดสอบเสียงพูด
        </button>
        <span className="text-xs font-semibold">
          {effective ? (
            <span className="text-emerald-700">เครื่องนี้: เปิดเสียงพูด</span>
          ) : (
            <span className="text-slate-500">เครื่องนี้: ใช้เสียง beep</span>
          )}
        </span>
        {probed && (
          <span className="text-xs text-[var(--color-text-muted)]">
            {thaiVoiceName ? `เสียงไทยที่พบ: ${thaiVoiceName}` : "ไม่พบเสียงภาษาไทยบนเครื่องนี้"}
          </span>
        )}
      </div>
      {testResult && (
        <p className="mt-2 rounded-md bg-[var(--color-surface-muted)] px-3 py-2 text-xs" role="status">
          {testResult}
        </p>
      )}
    </div>
  );
}
