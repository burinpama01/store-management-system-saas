"use client";

import { useEffect, useState } from "react";
import {
  requestLauncherSpeakers,
  saveLauncherSpeakers,
  testLauncherAlert,
  type LauncherSpeakers,
} from "@/modules/launcher/device-host";
import { useLauncherDevice } from "@/modules/launcher/useLauncherDevice";

const WINDOWS_DEFAULT = "";

/**
 * ลำโพงของเครื่องนี้ (StoreOS Launcher 0.5.0+ บน Windows)
 *
 * โจทย์จริง: พีซีแคชเชียร์ต่อลำโพงสองตัว — ตัวหนึ่งเปิดเพลงร้าน อีกตัวรับเสียงแจ้งเตือนจาก POS
 * ค่าเก็บในเครื่อง (launcher.json) ไม่ใช่ของร้าน เพราะลำโพงเป็นของแต่ละเครื่อง
 * แสดงเฉพาะตอนเปิดใน Launcher ที่รองรับ — เบราว์เซอร์ปกติเลือกลำโพงแบบนี้ไม่ได้
 */
export function LauncherSpeakerPanel() {
  const launcher = useLauncherDevice();
  const supported = launcher.capabilities.includes("speakers");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (supported) requestLauncherSpeakers();
  }, [supported]);

  if (!launcher.inLauncher) return null;

  if (launcher.legacy) {
    return (
      <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        <h2 className="text-base font-bold">ลำโพงของเครื่องนี้</h2>
        <p className="mt-1">
          StoreOS Launcher บนเครื่องนี้เป็นรุ่นเก่า ยังเลือกลำโพงแยกและอัปเดตตัวเองไม่ได้ —{" "}
          <a className="font-semibold underline" href="/download/windows-launcher">
            ดาวน์โหลดรุ่นใหม่
          </a>{" "}
          แล้วติดตั้งทับหนึ่งครั้ง (ค่าตั้งเดิมอยู่ครบ)
        </p>
      </div>
    );
  }

  if (!supported) return null;
  if (!launcher.speakers) {
    return (
      <div className="rounded-md border border-[var(--color-border)] bg-white p-4 text-sm text-[var(--color-text-muted)]">
        กำลังอ่านรายชื่อลำโพงของเครื่องนี้…
      </div>
    );
  }

  return (
    <SpeakerForm
      key={formKey(launcher.speakers)}
      speakers={launcher.speakers}
      saved={saved}
      onSavedChange={setSaved}
    />
  );
}

/** รีเซ็ตฟอร์มเมื่อ Launcher ส่งค่าที่บันทึกแล้วกลับมา (หรือเสียบ/ถอดลำโพง) */
function formKey(speakers: LauncherSpeakers) {
  return [speakers.alertDeviceId, speakers.alertVolume, speakers.musicDeviceId, speakers.devices.map((d) => d.id).join("|")].join("~");
}

function SpeakerForm({
  speakers,
  saved,
  onSavedChange,
}: {
  speakers: LauncherSpeakers;
  saved: boolean;
  onSavedChange: (saved: boolean) => void;
}) {
  const [alertDevice, setAlertDevice] = useState(speakers.alertDeviceId ?? WINDOWS_DEFAULT);
  const [volume, setVolume] = useState(speakers.alertVolume);
  const [musicDevice, setMusicDevice] = useState(speakers.musicDeviceId ?? WINDOWS_DEFAULT);

  const defaultName = speakers.devices.find((d) => d.isDefault)?.name ?? "ลำโพงหลัก";
  const missing = (id: string) => id !== WINDOWS_DEFAULT && !speakers.devices.some((d) => d.id === id);
  const dirty =
    alertDevice !== (speakers.alertDeviceId ?? WINDOWS_DEFAULT) ||
    volume !== speakers.alertVolume ||
    musicDevice !== (speakers.musicDeviceId ?? WINDOWS_DEFAULT);

  function save() {
    saveLauncherSpeakers({
      alertDeviceId: alertDevice || null,
      alertVolume: volume,
      musicDeviceId: musicDevice || null,
    });
    onSavedChange(true);
  }

  const options = (
    <>
      <option value={WINDOWS_DEFAULT}>ลำโพงหลักของ Windows ({defaultName})</option>
      {speakers.devices.map((device) => (
        <option key={device.id} value={device.id}>
          {device.name}
        </option>
      ))}
    </>
  );

  return (
    <div className="rounded-md border border-[var(--color-border)] bg-white p-4">
      <h2 className="text-base font-bold text-[var(--color-text-primary)]">ลำโพงของเครื่องนี้</h2>
      <p className="mt-1 text-sm text-[var(--color-text-muted)]">
        แยกเสียงแจ้งเตือนของ POS กับเพลงร้านออกคนละลำโพงได้ — ตั้งแยกต่อเครื่อง ไม่กระทบเครื่องอื่นในร้าน
      </p>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <label className="block">
          <span className="text-sm font-semibold text-[var(--color-text-primary)]">🔔 เสียงแจ้งเตือน (ออเดอร์ QR/เดลิเวอรี)</span>
          <select
            value={alertDevice}
            onChange={(e) => {
              setAlertDevice(e.target.value);
              onSavedChange(false);
            }}
            className="mt-1 block min-h-11 w-full rounded-md border border-[var(--color-border)] bg-white px-3 text-sm"
          >
            {missing(alertDevice) && <option value={alertDevice}>ลำโพงที่เลือกไว้ (ไม่ได้เสียบอยู่)</option>}
            {options}
          </select>
          {missing(alertDevice) && (
            <span className="mt-1 block text-xs text-amber-700">ลำโพงที่เลือกไว้ไม่ได้เสียบอยู่ — ตอนนี้เสียงออกลำโพงหลักแทน</span>
          )}
          <span className="mt-3 flex items-center gap-3">
            <span className="text-xs text-[var(--color-text-muted)]">ความดัง</span>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={volume}
              onChange={(e) => {
                setVolume(Number(e.target.value));
                onSavedChange(false);
              }}
              className="flex-1 accent-teal-700"
              aria-label="ความดังเสียงแจ้งเตือน"
            />
            <span className="w-10 text-right text-xs font-semibold">{volume}%</span>
          </span>
        </label>

        <label className="block">
          <span className="text-sm font-semibold text-[var(--color-text-primary)]">🎵 เพลงร้าน (หน้าเครื่องเล่นเพลง)</span>
          <select
            value={musicDevice}
            onChange={(e) => {
              setMusicDevice(e.target.value);
              onSavedChange(false);
            }}
            disabled={!speakers.musicRoutingSupported}
            className="mt-1 block min-h-11 w-full rounded-md border border-[var(--color-border)] bg-white px-3 text-sm disabled:cursor-not-allowed disabled:bg-[var(--color-surface-muted)]"
          >
            {missing(musicDevice) && <option value={musicDevice}>ลำโพงที่เลือกไว้ (ไม่ได้เสียบอยู่)</option>}
            {options}
          </select>
          {!speakers.musicRoutingSupported ? (
            <span className="mt-1 block text-xs text-amber-700">
              Windows เครื่องนี้ไม่รองรับการแยกลำโพงของเพลงจากโปรแกรม — ตั้งได้ที่ Settings → System → Sound → Volume mixer
            </span>
          ) : (
            <span className="mt-1 block text-xs text-[var(--color-text-muted)]">
              เสียงอื่นจากหน้าเว็บ (เช่นเสียงพูดประกาศออเดอร์) จะออกลำโพงนี้ด้วย
            </span>
          )}
        </label>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={!dirty}
          className="min-h-11 rounded-md bg-teal-700 px-4 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          บันทึกลำโพง
        </button>
        <button
          type="button"
          onClick={testLauncherAlert}
          className="min-h-11 rounded-md border border-[var(--color-border)] px-4 text-sm font-semibold"
        >
          ทดสอบเสียงแจ้งเตือน
        </button>
        {dirty && <span className="text-xs text-[var(--color-text-muted)]">กดบันทึกก่อน แล้วค่อยทดสอบ</span>}
        {saved && !dirty && (
          <span className="text-xs font-semibold text-teal-700">บันทึกแล้ว — ใช้กับเครื่องนี้ทันที</span>
        )}
      </div>
    </div>
  );
}
