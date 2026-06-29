"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { NowPlaying } from "@/modules/music-requests/types";
import type { PlayHistoryItem } from "@/modules/music-requests/repository";
import {
  advancePlayerAction,
  getPlayerStateAction,
  playPreviousAction,
  removeQueueItemAction,
  getPlayHistoryAction,
  type PlayerQueueItem,
} from "./actions";

interface YTPlayer {
  loadVideoById: (id: string) => void;
  playVideo: () => void;
  destroy?: () => void;
}
interface YTNamespace {
  Player: new (el: string | HTMLElement, opts: unknown) => YTPlayer;
  PlayerState: { ENDED: number };
}
declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

interface Props {
  storeName: string;
  initialNowPlaying: NowPlaying | null;
}

const VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

export function PlayerApp({ storeName, initialNowPlaying }: Props) {
  const [started, setStarted] = useState(false);
  const [now, setNow] = useState<NowPlaying | null>(initialNowPlaying);
  const [upcoming, setUpcoming] = useState<PlayerQueueItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [idle, setIdle] = useState(false);
  const [history, setHistory] = useState<PlayHistoryItem[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [busy, setBusy] = useState(false);

  const playerRef = useRef<YTPlayer | null>(null);
  const readyRef = useRef(false);
  const playingRef = useRef(false);
  const advancingRef = useRef(false);
  const advanceRef = useRef<() => Promise<void>>(async () => {});

  const advance = useCallback(async () => {
    if (advancingRef.current) return;
    advancingRef.current = true;
    try {
      const res = await advancePlayerAction();
      if (res.error) {
        setError(res.error);
        playingRef.current = false;
        setIdle(true);
        return;
      }
      setError(null);
      if (res.next && VIDEO_ID_RE.test(res.next.youtubeVideoId)) {
        playingRef.current = true;
        setIdle(false);
        setNow({
          storeId: "",
          source: res.next.source,
          musicRequestId: res.next.requestId,
          youtubeVideoId: res.next.youtubeVideoId,
          title: res.next.title,
          durationSeconds: res.next.durationSeconds,
          startedAt: new Date().toISOString(),
        });
        if (playerRef.current && readyRef.current) {
          playerRef.current.loadVideoById(res.next.youtubeVideoId);
        }
      } else {
        // Nothing playable right now — go idle and wait for a request.
        playingRef.current = false;
        setIdle(true);
        setNow(null);
      }
    } finally {
      advancingRef.current = false;
    }
  }, []);
  useEffect(() => {
    advanceRef.current = advance;
  }, [advance]);

  const refreshState = useCallback(async () => {
    const res = await getPlayerStateAction();
    if (res.error) return;
    setUpcoming(res.upcoming);
    // A "play now" donation interrupts immediately; otherwise start when idle.
    if (res.interrupt) void advanceRef.current();
    else if (!playingRef.current && res.upcoming.length > 0) void advanceRef.current();
  }, []);

  const loadHistory = useCallback(async () => {
    const res = await getPlayHistoryAction();
    if (!res.error) setHistory(res.history);
  }, []);

  function skipCurrent() {
    setBusy(true);
    void advanceRef.current().finally(() => {
      setBusy(false);
      void refreshState();
    });
  }

  function playPrevious() {
    setBusy(true);
    void (async () => {
      const res = await playPreviousAction();
      if (res.error) setError(res.error);
      else if (res.next && VIDEO_ID_RE.test(res.next.youtubeVideoId)) {
        playingRef.current = true;
        setIdle(false);
        setNow({
          storeId: "",
          source: res.next.source,
          musicRequestId: res.next.requestId,
          youtubeVideoId: res.next.youtubeVideoId,
          title: res.next.title,
          durationSeconds: res.next.durationSeconds,
          startedAt: new Date().toISOString(),
        });
        if (playerRef.current && readyRef.current) {
          playerRef.current.loadVideoById(res.next.youtubeVideoId);
        }
      }
      setBusy(false);
      void refreshState();
    })();
  }

  function removeItem(requestId: string) {
    setBusy(true);
    void (async () => {
      const res = await removeQueueItemAction(requestId);
      if (res.error) setError(res.error);
      setBusy(false);
      void refreshState();
    })();
  }

  // Create the YouTube player after the initial user gesture (autoplay policy).
  useEffect(() => {
    if (!started) return;
    function createPlayer() {
      const YT = window.YT;
      if (!YT) return;
      playerRef.current = new YT.Player("yt-player", {
        height: "100%",
        width: "100%",
        playerVars: { autoplay: 1, controls: 1, rel: 0, modestbranding: 1 },
        events: {
          onReady: () => {
            readyRef.current = true;
            // Always ask the server for the authoritative current track.
            void advanceRef.current();
          },
          onStateChange: (e: { data: number }) => {
            if (window.YT && e.data === window.YT.PlayerState.ENDED) void advanceRef.current();
          },
          // Skip videos YouTube refuses to play (bad id / embed disabled / removed).
          onError: () => {
            setTimeout(() => void advanceRef.current(), 1200);
          },
        },
      });
    }
    if (window.YT?.Player) {
      createPlayer();
    } else {
      const tag = document.createElement("script");
      tag.src = "https://www.youtube.com/iframe_api";
      document.body.appendChild(tag);
      window.onYouTubeIframeAPIReady = createPlayer;
    }
    return () => {
      playerRef.current?.destroy?.();
      playerRef.current = null;
      readyRef.current = false;
    };
  }, [started]);

  // Poll the upcoming queue + warn before the tab closes (keeps music alive).
  useEffect(() => {
    if (!started) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- setState runs after an await
    void refreshState();
    const id = setInterval(() => void refreshState(), 10000);
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      clearInterval(id);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [started, refreshState]);

  if (!started) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-black p-8 text-center text-white">
        <p className="text-5xl">🎵</p>
        <h1 className="mt-4 text-2xl font-bold">{storeName}</h1>
        <p className="mt-2 text-sm text-white/60">เครื่องเล่นเพลงอัตโนมัติ</p>
        <button
          onClick={() => setStarted(true)}
          className="mt-8 rounded-full bg-violet-600 px-10 py-4 text-lg font-bold active:bg-violet-700"
        >
          ▶ เริ่มเล่น
        </button>
        <p className="mt-6 max-w-xs text-xs text-white/40">
          เปิดทิ้งไว้ในแท็บนี้ ระบบจะเล่นเพลงต่อเนื่องและสลับเพลงเองอัตโนมัติ
        </p>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen flex-col bg-black text-white md:flex-row">
      {/* Player column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between px-4 py-3">
          <h1 className="truncate text-base font-bold">{storeName} · เครื่องเล่นเพลง</h1>
          {error && <span className="shrink-0 text-xs text-red-400">{error}</span>}
        </div>
        <div className="relative w-full bg-black" style={{ aspectRatio: "16 / 9" }}>
          <div id="yt-player" className="absolute inset-0 h-full w-full" />
          {idle && (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
              <p className="text-4xl">🎶</p>
              <p className="mt-2 text-sm text-white/60">รอเพลงในคิว — เพิ่มเพลงร้านหรือให้ลูกค้าขอเพลง</p>
            </div>
          )}
        </div>
        <div className="p-4">
          <p className="text-sm text-white/60">กำลังเล่น</p>
          <p className="mt-1 truncate text-lg font-semibold">
            {now?.title ?? "—"}
            {now?.source === "base" && <span className="ml-2 text-xs text-white/40">(เพลงร้าน)</span>}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              onClick={playPrevious}
              disabled={busy}
              className="rounded-lg bg-white/10 px-3 py-2 text-sm disabled:opacity-40"
            >
              ⏮ เพลงก่อนหน้า
            </button>
            <button
              onClick={skipCurrent}
              disabled={busy}
              className="rounded-lg bg-white/10 px-3 py-2 text-sm disabled:opacity-40"
            >
              ⏭ ข้ามเพลงนี้
            </button>
            <button
              onClick={() => {
                const next = !showHistory;
                setShowHistory(next);
                if (next) void loadHistory();
              }}
              className={`rounded-lg px-3 py-2 text-sm ${showHistory ? "bg-violet-600" : "bg-white/10"}`}
            >
              📜 ประวัติเพลง
            </button>
          </div>
        </div>
      </div>

      {/* Queue side panel */}
      <aside className="w-full shrink-0 overflow-y-auto border-t border-white/10 p-4 md:max-h-screen md:w-80 md:border-l md:border-t-0">
        {showHistory ? (
          <>
            <p className="text-sm font-semibold text-white/80">ประวัติเพลง ({history.length})</p>
            <ul className="mt-3 space-y-2">
              {history.map((h) => (
                <li key={h.id} className="rounded-lg bg-white/5 px-3 py-2 text-sm">
                  <p className="truncate">{h.title ?? h.youtubeVideoId}</p>
                  <p className="text-xs text-white/40">
                    {h.source === "base" ? "เพลงร้าน" : "คำขอ"} ·{" "}
                    {new Date(h.playedAt).toLocaleTimeString("th-TH", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </p>
                </li>
              ))}
              {history.length === 0 && (
                <li className="py-6 text-center text-sm text-white/30">ยังไม่มีประวัติ</li>
              )}
            </ul>
          </>
        ) : (
          <>
            <p className="text-sm font-semibold text-white/80">คิวเพลงที่ถูกขอ ({upcoming.length})</p>
            <ul className="mt-3 space-y-2">
              {upcoming.map((q, i) => (
                <li
                  key={q.id}
                  className="flex items-center gap-2 rounded-lg bg-white/5 px-3 py-2 text-sm"
                >
                  <span className="w-5 shrink-0 text-white/40">{i + 1}</span>
                  <span className="min-w-0 flex-1 truncate">{q.title}</span>
                  {q.playNow ? (
                    <span className="shrink-0 rounded-full bg-rose-500/20 px-2 py-0.5 text-xs text-rose-300">
                      ⚡ เปิดทันที
                    </span>
                  ) : q.isDonation ? (
                    <span className="shrink-0 rounded-full bg-amber-500/20 px-2 py-0.5 text-xs text-amber-300">
                      💸 โดเนท
                    </span>
                  ) : null}
                  <button
                    onClick={() => removeItem(q.id)}
                    disabled={busy}
                    title="ลบออกจากคิว"
                    className="shrink-0 px-1 text-white/40 hover:text-red-400 disabled:opacity-40"
                  >
                    ✕
                  </button>
                </li>
              ))}
              {upcoming.length === 0 && (
                <li className="py-6 text-center text-sm text-white/30">ยังไม่มีเพลงในคิว</li>
              )}
            </ul>
          </>
        )}
      </aside>
    </main>
  );
}
