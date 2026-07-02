"use client";

import { useActionState } from "react";
import Link from "next/link";
import { SubmitButton } from "@/shared/components/ui";
import type { MusicPlayerSettings } from "@/modules/music-requests/types";
import { updateMusicPlayerSettingsAction } from "./actions";

interface Props {
  settings: MusicPlayerSettings;
  storeSlug: string;
  canEdit: boolean;
}

export function MusicPlayerSettingsForm({ settings, storeSlug, canEdit }: Props) {
  const [state, formAction] = useActionState(updateMusicPlayerSettingsAction, { error: null });
  const playlistText = settings.basePlaylist.map((t) => t.title).join("\n");

  return (
    <form action={formAction} className="space-y-5">
      <section className="panel space-y-3">
        <h2 className="panel-title">ลิขสิทธิ์เพลง</h2>
        <p className="text-sm text-[var(--muted)]">
          การเปิดเพลงในร้านเชิงพาณิชย์มีภาระค่าลิขสิทธิ์ (เช่น MCT/GMM/ลิขสิทธิ์สากล) และต้องเป็นไปตามเงื่อนไขของ YouTube
          ระบบนี้เป็นเพียงเครื่องมือจัดคิว/เล่น — <span className="font-semibold">ความรับผิดชอบด้านลิขสิทธิ์เป็นของร้าน</span>
        </p>
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            name="licensingAcknowledged"
            value="1"
            defaultChecked={Boolean(settings.licensingAcknowledgedAt)}
            disabled={!canEdit}
            className="rounded border-gray-300"
          />
          <span className="text-sm font-medium">ข้าพเจ้ารับทราบและยอมรับความรับผิดชอบด้านลิขสิทธิ์เพลง</span>
        </label>
      </section>

      <section className="panel space-y-3">
        <h2 className="panel-title">เครื่องเล่นเพลง</h2>
        <label className="flex cursor-pointer items-center gap-2">
          <input type="checkbox" name="playerEnabled" value="1" defaultChecked={settings.playerEnabled} disabled={!canEdit} className="rounded border-gray-300" />
          <span className="text-sm font-medium">เปิดใช้งานเครื่องเล่นเพลงอัตโนมัติ</span>
        </label>
        <label className="flex cursor-pointer items-center gap-2">
          <input type="checkbox" name="autoApprove" value="1" defaultChecked={settings.autoApprove} disabled={!canEdit} className="rounded border-gray-300" />
          <span className="text-sm font-medium">อนุมัติคำขอเพลงอัตโนมัติ (เข้าคิวเล่นทันที ไม่ต้องให้พนักงานกด)</span>
        </label>
        <div className="max-w-xs">
          <label className="field-label" htmlFor="maxDurationSeconds">ความยาวเพลงสูงสุด (วินาที)</label>
          <input id="maxDurationSeconds" type="number" name="maxDurationSeconds" min={60} max={1800} defaultValue={settings.maxDurationSeconds} disabled={!canEdit} className="w-full rounded-[var(--radius-md)] border border-[var(--border)] px-3 py-2 text-sm" />
        </div>
      </section>

      <section className="panel space-y-3">
        <h2 className="panel-title">โดเนทแซงคิว</h2>
        <label className="flex cursor-pointer items-center gap-2">
          <input type="checkbox" name="donationEnabled" value="1" defaultChecked={settings.donationEnabled} disabled={!canEdit} className="rounded border-gray-300" />
          <span className="text-sm font-medium">เปิดให้ลูกค้าโดเนทเพื่อแซงคิว (PromptPay + สลิป)</span>
        </label>
        <div className="grid max-w-md grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="field-label" htmlFor="minDonation">เข้าคิวแรก — ขั้นต่ำ (บาท)</label>
            <input id="minDonation" type="number" name="minDonation" min={0} step="1" defaultValue={settings.minDonation} disabled={!canEdit} className="w-full rounded-[var(--radius-md)] border border-[var(--border)] px-3 py-2 text-sm" />
            <p className="mt-1 text-xs text-[var(--muted)]">โดเนทแข่งลำดับคิว ยิ่งมากยิ่งได้เล่นก่อน</p>
          </div>
          <div>
            <label className="field-label" htmlFor="playNowPrice">เปิดทันที — ราคา (บาท)</label>
            <input id="playNowPrice" type="number" name="playNowPrice" min={0} step="1" defaultValue={settings.playNowPrice} disabled={!canEdit} className="w-full rounded-[var(--radius-md)] border border-[var(--border)] px-3 py-2 text-sm" />
            <p className="mt-1 text-xs text-[var(--muted)]">จ่ายเท่านี้ = เพลงถูกเปิดทันที ตัดหน้าทุกคิว</p>
          </div>
        </div>
      </section>

      <section className="panel space-y-3">
        <h2 className="panel-title">เพลงพื้นฐานของร้าน (Base Playlist)</h2>
        <p className="text-sm text-[var(--muted)]">วาง YouTube URL หรือ video ID บรรทัดละ 1 เพลง (สูงสุด 100). เล่นวนเมื่อไม่มีคิวคำขอ</p>
        <textarea
          name="basePlaylist"
          rows={8}
          defaultValue={playlistText}
          disabled={!canEdit}
          placeholder={"https://youtu.be/...\nhttps://www.youtube.com/watch?v=..."}
          className="w-full rounded-[var(--radius-md)] border border-[var(--border)] px-3 py-2 text-sm font-mono"
        />
      </section>

      {state.error && <p className="alert-danger">{state.error}</p>}

      <div className="flex items-center gap-3">
        {canEdit && <SubmitButton className="btn-primary">บันทึก</SubmitButton>}
        <Link
          href={`/player/${storeSlug}`}
          target="_blank"
          rel="noopener noreferrer"
          className="btn-secondary"
        >
          เปิดหน้าเครื่องเล่น (แท็บใหม่)
        </Link>
      </div>
    </form>
  );
}
