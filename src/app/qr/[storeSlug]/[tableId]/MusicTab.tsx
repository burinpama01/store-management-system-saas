"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { Button } from "@/shared/components/ui";
import { QrCode } from "@/shared/components/ui/QrCode";
import {
  listMusicQueueAction,
  submitMusicRequestAction,
  searchMusicAction,
  previewDonationPositionAction,
  startMusicDonationAction,
  verifyMusicDonationAction,
} from "./music-actions";
import {
  MUSIC_REQUEST_STATUS_LABEL,
  type PublicMusicRequest,
} from "@/modules/music-requests/types";
import type { YouTubeSearchResult } from "@/modules/music-requests/youtube";
import type { QrMusicEligibility } from "@/modules/music-requests/gates";

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

interface Props {
  storeId: string;
  tableId: string;
  querySessionId: string | null;
  eligibility: QrMusicEligibility;
}

const STATUS_STYLE: Record<PublicMusicRequest["status"], string> = {
  pending: "bg-amber-50 text-amber-700",
  approved: "bg-blue-50 text-blue-700",
  played: "bg-green-50 text-green-700",
};

function fmtDur(sec?: number): string {
  if (!sec) return "";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function MusicTab({ storeId, tableId, querySessionId, eligibility }: Props) {
  const [queue, setQueue] = useState<PublicMusicRequest[]>([]);
  const [nowPlaying, setNowPlaying] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<YouTubeSearchResult[]>([]);
  const [selected, setSelected] = useState<YouTubeSearchResult | null>(null);
  const [requester, setRequester] = useState("");
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [pending, start] = useTransition();

  // Donation flow
  const [donationEnabled, setDonationEnabled] = useState(false);
  const [minDonation, setMinDonation] = useState(10);
  const [playNowPrice, setPlayNowPrice] = useState(100);
  const [donateTier, setDonateTier] = useState<"queue" | "now" | null>(null);
  const [amount, setAmount] = useState("");
  const [previewPos, setPreviewPos] = useState<number | null>(null);
  const [payPayload, setPayPayload] = useState<string | null>(null);
  const [payInfo, setPayInfo] = useState<{ promptpayId: string; amount: number } | null>(null);
  const [donationRequestId, setDonationRequestId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await listMusicQueueAction(storeId, tableId, querySessionId);
    if (!res.error) {
      setQueue(res.queue);
      setNowPlaying(res.nowPlayingTitle ?? null);
      setDonationEnabled(Boolean(res.donationEnabled));
      // 0 is a valid price (free tier) — don't treat it as "missing".
      if (typeof res.minDonation === "number") setMinDonation(res.minDonation);
      if (typeof res.playNowPrice === "number") setPlayNowPrice(res.playNowPrice);
    }
  }, [storeId, tableId, querySessionId]);

  // Poll the queue / now-playing.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async load setStates after await
    void load();
    const id = setInterval(() => void load(), 15000);
    return () => clearInterval(id);
  }, [load]);

  // Debounced YouTube search.
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (selected) return;
    const q = query.trim();
    if (q.length < 2) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clears stale results when query is too short
      setResults([]);
      return;
    }
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(async () => {
      setSearching(true);
      const res = await searchMusicAction(storeId, tableId, querySessionId, q);
      setSearching(false);
      if (!res.error) setResults(res.results);
    }, 450);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [query, selected, storeId, tableId, querySessionId]);

  function submit() {
    if (!selected) return;
    setErrMsg(null);
    setOkMsg(null);
    const track = selected;
    start(async () => {
      const res = await submitMusicRequestAction(
        storeId,
        tableId,
        querySessionId,
        {
          songTitle: track.title,
          artistName: track.channelTitle,
          requesterLabel: requester.trim() || undefined,
        },
        {
          videoId: track.videoId,
          title: track.title,
          thumbnailUrl: track.thumbnailUrl,
          durationSeconds: track.durationSeconds,
        },
      );
      if (res.error) {
        setErrMsg(res.error);
        return;
      }
      setSelected(null);
      setQuery("");
      setResults([]);
      setOkMsg("ส่งคำขอเพลงแล้ว 🎵 รอเปิดในคิวนะคะ");
      void load();
    });
  }

  const effectiveMin = donateTier === "now" ? playNowPrice : minDonation;

  // Live queue-position preview for the "queue jump" tier (no amounts revealed).
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (donateTier !== "queue") return;
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clears preview when amount is empty/invalid
      setPreviewPos(null);
      return;
    }
    if (previewTimer.current) clearTimeout(previewTimer.current);
    previewTimer.current = setTimeout(async () => {
      const res = await previewDonationPositionAction(storeId, tableId, querySessionId, amt);
      if (!res.error) setPreviewPos(res.position);
    }, 400);
    return () => {
      if (previewTimer.current) clearTimeout(previewTimer.current);
    };
  }, [amount, donateTier, storeId, tableId, querySessionId]);

  function resetTrack() {
    setSelected(null);
    setDonateTier(null);
    setAmount("");
    setPreviewPos(null);
    setPayPayload(null);
    setPayInfo(null);
    setDonationRequestId(null);
  }

  function startDonation(tierOverride?: "queue" | "now", amountOverride?: number) {
    if (!selected) return;
    const tier = tierOverride ?? donateTier;
    const amt = amountOverride ?? Number(amount);
    setErrMsg(null);
    start(async () => {
      const res = await startMusicDonationAction(
        storeId,
        tableId,
        querySessionId,
        {
          videoId: selected.videoId,
          title: selected.title,
          thumbnailUrl: selected.thumbnailUrl,
          durationSeconds: selected.durationSeconds,
        },
        requester.trim() || undefined,
        amt,
        tier === "now",
      );
      if (res.free && res.requestId) {
        // Zero-price tier: no payment step — the song is already in.
        resetTrack();
        setQuery("");
        setResults([]);
        setOkMsg(tier === "now" ? "ส่งเพลงแล้ว 🎉 กำลังจะเปิดทันที" : "ส่งเพลงแล้ว 🎉 เข้าคิวลำดับแรก");
        void load();
        return;
      }
      if (res.error || !res.requestId || !res.promptPayPayload) {
        setErrMsg(res.error ?? "เริ่มโดเนทไม่สำเร็จ");
        return;
      }
      setDonationRequestId(res.requestId);
      setPayPayload(res.promptPayPayload);
      if (res.promptpayId && res.amount != null) {
        setPayInfo({ promptpayId: res.promptpayId, amount: res.amount });
      }
    });
  }

  function onSlipSelected(file: File | undefined) {
    if (!file || !donationRequestId) return;
    setErrMsg(null);
    start(async () => {
      const base64 = await fileToBase64(file);
      const res = await verifyMusicDonationAction(storeId, donationRequestId, base64);
      if (res.error) {
        setErrMsg(res.error);
        return;
      }
      setOkMsg("ยืนยันโดเนทแล้ว 🎉 เพลงของคุณจะได้แซงคิว");
      resetTrack();
      setQuery("");
      setResults([]);
      void load();
    });
  }

  return (
    <div className="flex-1 space-y-4 p-4">
      {nowPlaying && (
        <div className="rounded-xl bg-violet-50 px-4 py-3">
          <p className="text-xs text-violet-500">กำลังเล่น</p>
          <p className="truncate text-sm font-semibold text-violet-900">🎵 {nowPlaying}</p>
        </div>
      )}

      {eligibility.canSubmitRequest ? (
        <div className="space-y-3 rounded-xl border border-gray-100 bg-white p-4">
          <p className="text-sm font-bold text-gray-900">🎵 ขอเพลง</p>

          {selected ? (
            <div className="flex items-center gap-3 rounded-lg border border-violet-200 bg-violet-50 p-2">
              {selected.thumbnailUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={selected.thumbnailUrl} alt="" className="h-12 w-16 rounded object-cover" />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-gray-900">{selected.title}</p>
                <p className="truncate text-xs text-gray-400">
                  {selected.channelTitle}
                  {selected.durationSeconds ? ` · ${fmtDur(selected.durationSeconds)}` : ""}
                </p>
              </div>
              <button onClick={resetTrack} className="shrink-0 px-2 text-gray-400">
                ✕
              </button>
            </div>
          ) : (
            <>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                maxLength={100}
                placeholder="ค้นหาเพลงจาก YouTube..."
                className="w-full min-h-11 rounded-lg border border-gray-200 px-3 text-sm"
              />
              {searching && <p className="text-xs text-gray-400">กำลังค้นหา...</p>}
              {results.length > 0 && (
                <ul className="max-h-64 space-y-1 overflow-y-auto">
                  {results.map((r) => (
                    <li key={r.videoId}>
                      <button
                        onClick={() => {
                          setSelected(r);
                          setResults([]);
                        }}
                        className="flex w-full items-center gap-3 rounded-lg p-2 text-left active:bg-gray-50"
                      >
                        {r.thumbnailUrl && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={r.thumbnailUrl} alt="" className="h-12 w-16 rounded object-cover" />
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-gray-900">{r.title}</p>
                          <p className="truncate text-xs text-gray-400">
                            {r.channelTitle}
                            {r.durationSeconds ? ` · ${fmtDur(r.durationSeconds)}` : ""}
                          </p>
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          <input
            value={requester}
            onChange={(e) => setRequester(e.target.value)}
            maxLength={60}
            placeholder="ชื่อผู้ขอ / โต๊ะ (ไม่บังคับ)"
            className="w-full min-h-11 rounded-lg border border-gray-200 px-3 text-sm"
          />
          {errMsg && <p className="text-xs text-red-500">{errMsg}</p>}
          {okMsg && <p className="text-xs text-green-600">{okMsg}</p>}

          {payPayload ? (
            <div className="space-y-3 rounded-lg border border-violet-200 bg-violet-50 p-3 text-center">
              <p className="text-sm font-semibold text-violet-900">สแกนจ่ายเพื่อโดเนท</p>
              <div className="flex justify-center">
                <QrCode value={payPayload} size={200} />
              </div>
              {payInfo && (
                <p className="text-xs text-gray-600">
                  PromptPay: {payInfo.promptpayId} · ฿{payInfo.amount.toLocaleString("th-TH")}
                </p>
              )}
              <p className="text-xs text-gray-500">จ่ายแล้วแนบสลิปเพื่อยืนยัน</p>
              <label className="block">
                <span className="btn-primary inline-flex min-h-11 cursor-pointer items-center justify-center px-4 text-sm">
                  {pending ? "กำลังตรวจสลิป..." : "แนบสลิปโอนเงิน"}
                </span>
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  disabled={pending}
                  onChange={(e) => onSlipSelected(e.target.files?.[0])}
                />
              </label>
              <button onClick={resetTrack} className="text-xs text-gray-400">
                ยกเลิก
              </button>
            </div>
          ) : donateTier ? (
            <div
              className={`space-y-2 rounded-lg border p-3 ${
                donateTier === "now" ? "border-rose-200 bg-rose-50" : "border-amber-200 bg-amber-50"
              }`}
            >
              <p className="text-sm font-semibold text-gray-900">
                {donateTier === "now" ? "⚡ เปิดทันที" : "💸 เข้าคิวแรก"}
              </p>
              <input
                type="number"
                inputMode="numeric"
                min={effectiveMin}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder={`ยอดโดเนท (ขั้นต่ำ ${effectiveMin} บาท)`}
                className="w-full min-h-11 rounded-lg border border-gray-200 px-3 text-sm"
              />
              {donateTier === "now" ? (
                <p className="text-xs text-rose-700">เพลงนี้จะถูกเปิดทันทีหลังจ่ายสำเร็จ</p>
              ) : (
                previewPos !== null && (
                  <p className="text-xs text-amber-800">
                    ยอดที่คุณระบุจะอยู่ในลำดับ <span className="font-bold">{previewPos}</span> — เพิ่มเงินเพื่อเล่นก่อน
                  </p>
                )
              )}
              <Button
                variant="primary"
                onClick={() => startDonation()}
                disabled={Number(amount) < effectiveMin || pending}
                loading={pending}
                className="w-full min-h-11 text-sm"
              >
                ชำระเงินโดเนท
              </Button>
              <button onClick={() => setDonateTier(null)} className="w-full text-xs text-gray-400">
                ยกเลิก
              </button>
            </div>
          ) : selected && donationEnabled ? (
            /* Tier hierarchy: play-now (hero) → queue-jump → free (smallest). */
            <div className="space-y-2">
              <button
                onClick={() => {
                  if (playNowPrice <= 0) {
                    // Free tier (store priced it 0) — no payment step at all.
                    startDonation("now", 0);
                    return;
                  }
                  setDonateTier("now");
                  setAmount(String(playNowPrice));
                }}
                disabled={pending}
                className="w-full min-h-12 rounded-xl bg-gradient-to-r from-rose-500 to-orange-500 px-4 py-3 text-white shadow-md active:opacity-90 disabled:opacity-50"
              >
                <span className="block text-sm font-bold">⚡ เปิดทันที</span>
                <span className="block text-xs text-white/90">
                  ตัดหน้าทุกคิว เล่นเลย ·{" "}
                  {playNowPrice <= 0 ? "ฟรี" : `฿${playNowPrice.toLocaleString("th-TH")}`}
                </span>
              </button>
              <button
                onClick={() => {
                  if (minDonation <= 0) {
                    startDonation("queue", 0);
                    return;
                  }
                  setDonateTier("queue");
                }}
                disabled={pending}
                className="w-full min-h-11 rounded-xl border-2 border-amber-400 bg-amber-50 px-4 py-2.5 text-amber-800 active:bg-amber-100 disabled:opacity-50"
              >
                <span className="block text-sm font-semibold">💸 เข้าคิวแรก</span>
                <span className="block text-xs text-amber-700">
                  {minDonation <= 0
                    ? "เข้าก่อนคิวปกติ · ฟรี"
                    : `โดเนทแข่งลำดับ เริ่ม ฿${minDonation.toLocaleString("th-TH")}`}
                </span>
              </button>
              <button
                onClick={submit}
                disabled={pending}
                className="w-full min-h-11 rounded-lg py-2 text-sm text-gray-500 underline-offset-2 hover:underline disabled:opacity-50"
              >
                ส่งคำขอเพลงฟรี (รอคิวปกติ)
              </button>
            </div>
          ) : (
            <Button
              variant="primary"
              onClick={submit}
              disabled={!selected || pending}
              loading={pending}
              className="w-full min-h-11 text-sm"
            >
              ส่งคำขอเพลง (ฟรี)
            </Button>
          )}
        </div>
      ) : (
        <div className="rounded-xl border border-gray-100 bg-white p-4 text-center text-sm text-gray-500">
          {eligibility.reason ?? "ขณะนี้ยังไม่เปิดให้ขอเพลง"}
        </div>
      )}

      <div>
        <p className="mb-2 text-sm font-bold text-gray-900">คิวเพลง</p>
        {queue.length === 0 ? (
          <p className="py-6 text-center text-sm text-gray-400">ยังไม่มีเพลงในคิว</p>
        ) : (
          <ul className="space-y-2">
            {queue.map((q) => (
              <li
                key={q.id}
                className="flex items-center justify-between gap-2 rounded-lg border border-gray-100 bg-white px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-gray-900">{q.songTitle}</p>
                  {(q.artistName || q.requesterLabel) && (
                    <p className="truncate text-xs text-gray-400">
                      {q.artistName ?? ""}
                      {q.artistName && q.requesterLabel ? " · " : ""}
                      {q.requesterLabel ?? ""}
                    </p>
                  )}
                </div>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_STYLE[q.status]}`}>
                  {MUSIC_REQUEST_STATUS_LABEL[q.status]}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
