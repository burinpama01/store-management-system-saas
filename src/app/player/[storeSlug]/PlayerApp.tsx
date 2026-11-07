"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { NowPlaying } from "@/modules/music-requests/types";
import type { PlayHistoryItem } from "@/modules/music-requests/repository";
import {
  advancePlayerAction,
  getPlayerStateAction,
  playPreviousAction,
  playQueueItemAction,
  playBaseTrackAction,
  removeQueueItemAction,
  getPlayHistoryAction,
  searchPlayerMusicAction,
  addStoreSongAction,
  removeStoreSongAction,
  type PlayerQueueItem,
  type PlayerBaseTrack,
  type PlayerSearchResult,
} from "./actions";

interface YTPlayer {
  loadVideoById: (id: string) => void;
  playVideo: () => void;
  getDuration?: () => number;
  getCurrentTime?: () => number;
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
  const [basePlaylist, setBasePlaylist] = useState<PlayerBaseTrack[]>([]);
  const [panel, setPanel] = useState<"queue" | "base" | "search" | "history">("queue");
  const [interruptBase, setInterruptBase] = useState(true);
  const [busy, setBusy] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<PlayerSearchResult[]>([]);
  const [searching, setSearching] = useState(false);

  const playerRef = useRef<YTPlayer | null>(null);
  const readyRef = useRef(false);
  const playingRef = useRef(false);
  const advancingRef = useRef(false);
  const atEndPollsRef = useRef(0);
  const advanceRef = useRef<(opts?: { interrupted?: boolean }) => Promise<void>>(async () => {});

  /**
   * `interrupted` = the current track is being cut off mid-play (a request jumping
   * the store's song); the server then resumes that store song once the queue empties.
   */
  const advance = useCallback(async (opts: { interrupted?: boolean } = {}) => {
    if (advancingRef.current) return;
    advancingRef.current = true;
    atEndPollsRef.current = 0;
    try {
      const res = await advancePlayerAction({ interrupted: opts.interrupted === true });
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

  /**
   * True when the current track has no end for the player to wait for: a live
   * stream (YouTube reports its duration as the elapsed stream time, so the
   * playhead sits at the very end) or metadata that never resolves. Without this
   * a request queued behind a live store song would never get its turn.
   */
  const currentTrackNeverEnds = useCallback(() => {
    const p = playerRef.current;
    if (!readyRef.current || !p?.getDuration || !p.getCurrentTime) return false;
    const duration = p.getDuration();
    const position = p.getCurrentTime();
    if (!Number.isFinite(duration) || duration <= 0) return position > 30;
    // A normal song can sit in its last seconds on one poll and then end by
    // itself — only a playhead pinned to the end on consecutive polls is live.
    // Otherwise the nearly-finished song would be flagged as cut off and replayed.
    if (position < duration - 2) {
      atEndPollsRef.current = 0;
      return false;
    }
    atEndPollsRef.current += 1;
    return atEndPollsRef.current >= 2;
  }, []);

  const refreshState = useCallback(async () => {
    const res = await getPlayerStateAction();
    if (res.error) return;
    setUpcoming(res.upcoming);
    setBasePlaylist(res.basePlaylist);
    setInterruptBase(res.interruptBaseOnRequest);
    // A "play now" donation — or the store's cut-in setting — interrupts at once.
    if (res.interrupt) void advanceRef.current({ interrupted: true });
    else if (!playingRef.current && res.upcoming.length > 0) void advanceRef.current();
    // Cut-in off, but the store song never ends (live) — play the request anyway.
    else if (res.waitingOnBase && currentTrackNeverEnds()) {
      void advanceRef.current({ interrupted: true });
    }
  }, [currentTrackNeverEnds]);

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

  function playBase(videoId: string, title: string) {
    setBusy(true);
    void (async () => {
      const res = await playBaseTrackAction(videoId, title);
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

  function doSearch() {
    const q = searchQuery.trim();
    if (!q) return;
    setSearching(true);
    setError(null);
    void (async () => {
      const res = await searchPlayerMusicAction(q);
      if (res.error) setError(res.error);
      setSearchResults(res.results);
      setSearching(false);
    })();
  }

  function addStoreSong(videoId: string, title: string) {
    setBusy(true);
    void (async () => {
      const res = await addStoreSongAction(videoId, title);
      if (res.error) setError(res.error);
      setBusy(false);
      void refreshState();
    })();
  }

  function removeStoreSong(videoId: string) {
    setBusy(true);
    void (async () => {
      const res = await removeStoreSongAction(videoId);
      if (res.error) setError(res.error);
      setBusy(false);
      void refreshState();
    })();
  }

  function playItem(requestId: string) {
    setBusy(true);
    void (async () => {
      const res = await playQueueItemAction(requestId);
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

  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // กด "/" เพื่อไปช่องค้นหา (แบบ YouTube) — ไม่แย่งตอนกำลังพิมพ์ในช่องอื่น
  useEffect(() => {
    if (!started) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      searchInputRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [started]);

  function submitSearch() {
    if (!searchQuery.trim()) return;
    setPanel("search");
    doSearch();
  }

  function openPanel(next: "queue" | "base" | "history") {
    setPanel(next);
    if (next === "base") void refreshState();
    if (next === "history") void loadHistory();
  }

  if (!started) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-[#0f0f0f] p-8 text-center text-white">
        <div className="flex h-16 w-24 items-center justify-center rounded-2xl bg-red-600 text-3xl shadow-lg shadow-red-900/40">
          ▶
        </div>
        <h1 className="mt-6 text-2xl font-bold">{storeName}</h1>
        <p className="mt-2 text-sm text-white/60">เครื่องเล่นเพลงอัตโนมัติ</p>
        <button
          onClick={() => setStarted(true)}
          className="mt-8 rounded-full bg-white px-10 py-3.5 text-lg font-bold text-black hover:bg-white/90 active:bg-white/80"
        >
          ▶ เริ่มเล่น
        </button>
        <p className="mt-6 max-w-xs text-xs text-white/40">
          เปิดทิ้งไว้ในแท็บนี้ ระบบจะเล่นเพลงต่อเนื่องและสลับเพลงเองอัตโนมัติ
        </p>
      </main>
    );
  }

  const tabs: { key: "queue" | "base" | "history"; label: string }[] = [
    { key: "queue", label: `ถัดไป${upcoming.length ? ` (${upcoming.length})` : ""}` },
    { key: "base", label: `เพลงของร้าน${basePlaylist.length ? ` (${basePlaylist.length})` : ""}` },
    { key: "history", label: "ประวัติ" },
  ];

  return (
    <main className="flex min-h-screen flex-col bg-[#0f0f0f] text-white">
      {/* Top bar — โลโก้ร้าน / ช่องค้นหาตรงกลาง / ตั้งค่า (แบบ YouTube) */}
      <header className="sticky top-0 z-20 flex items-center gap-3 bg-[#0f0f0f]/95 px-4 py-2.5 backdrop-blur">
        <div className="flex min-w-0 shrink-0 items-center gap-2">
          <span className="flex h-6 w-8 items-center justify-center rounded-md bg-red-600 text-[11px]">▶</span>
          <span className="hidden max-w-[12rem] truncate text-base font-bold sm:block">{storeName}</span>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submitSearch();
          }}
          className="mx-auto flex w-full max-w-xl min-w-0"
        >
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onFocus={() => setPanel("search")}
            placeholder="ค้นหาเพลง / ศิลปิน"
            aria-label="ค้นหาเพลง"
            // globals.css มีกฎ input แบบ unlayered ที่ชนะ utility class — ใส่สีพื้น/ตัวอักษรแบบ inline
            style={{ backgroundColor: "#121212", color: "#fff", borderColor: "rgba(255,255,255,0.15)" }}
            className="min-w-0 flex-1 rounded-l-full border px-4 py-2 text-sm placeholder-white/40 focus:outline-none"
          />
          <button
            type="submit"
            disabled={searching || !searchQuery.trim()}
            title="ค้นหา"
            className="shrink-0 rounded-r-full border border-l-0 border-white/15 bg-white/10 px-5 text-sm hover:bg-white/15 disabled:opacity-40"
          >
            {searching ? "…" : "🔍"}
          </button>
        </form>
        <a
          href="/settings/music-player"
          target="_blank"
          rel="noopener noreferrer"
          title="ตั้งค่าเครื่องเล่นเพลง"
          className="shrink-0 rounded-full px-2 py-1.5 text-lg text-white/70 hover:bg-white/10"
        >
          ⚙
        </a>
      </header>

      {error && (
        <div className="mx-4 mb-2 rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-300" role="alert">
          {error}
        </div>
      )}

      <div className="flex flex-1 flex-col gap-6 px-4 pb-6 lg:flex-row">
        {/* Player column */}
        <section className="min-w-0 lg:flex-1">
          <div className="relative w-full overflow-hidden rounded-xl bg-black" style={{ aspectRatio: "16 / 9" }}>
            <div id="yt-player" className="absolute inset-0 h-full w-full" />
            {idle && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-black text-center">
                <p className="text-4xl">🎶</p>
                <p className="mt-2 text-sm text-white/60">รอเพลงในคิว — ค้นหาเพลงด้านบน หรือให้ลูกค้าสแกนขอเพลง</p>
              </div>
            )}
          </div>

          <h1 className="mt-3 line-clamp-2 text-lg font-bold leading-snug sm:text-xl">{now?.title ?? "ยังไม่มีเพลงที่กำลังเล่น"}</h1>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {now && (
              <span
                className={`rounded-full px-3 py-1 text-xs font-medium ${
                  now.source === "base" ? "bg-white/10 text-white/70" : "bg-red-600/20 text-red-300"
                }`}
              >
                {now.source === "base" ? "เพลงของร้าน" : "ลูกค้าขอ"}
              </span>
            )}
            <div className="ml-auto flex overflow-hidden rounded-full bg-white/10">
              <button
                onClick={playPrevious}
                disabled={busy}
                className="px-4 py-2 text-sm font-medium hover:bg-white/15 disabled:opacity-40"
              >
                ⏮ ก่อนหน้า
              </button>
              <span className="my-2 w-px bg-white/20" aria-hidden="true" />
              <button
                onClick={skipCurrent}
                disabled={busy}
                className="px-4 py-2 text-sm font-medium hover:bg-white/15 disabled:opacity-40"
              >
                ถัดไป ⏭
              </button>
            </div>
          </div>
          <p className="mt-3 rounded-xl bg-white/5 px-3 py-2 text-xs text-white/50">
            {interruptBase
              ? "เพลงที่ลูกค้าขอจะแทรกเพลงของร้านทันที แล้วกลับไปเล่นเพลงของร้านต่อเมื่อคิวหมด"
              : "รอให้เพลงของร้านจบก่อนแล้วเล่นคิวถัดไป (ถ้าเป็นเพลง live ระบบจะแทรกให้เอง)"}
            {" · กด / เพื่อค้นหาเพลง"}
          </p>
        </section>

        {/* Side column — ถัดไป / เพลงร้าน / ประวัติ / ผลค้นหา */}
        <aside className="w-full shrink-0 lg:w-[400px] xl:w-[420px]">
          <div className="flex gap-2 overflow-x-auto pb-3">
            {tabs.map((t) => (
              <button
                key={t.key}
                onClick={() => openPanel(t.key)}
                className={`shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium ${
                  panel === t.key ? "bg-white text-black" : "bg-white/10 text-white hover:bg-white/15"
                }`}
              >
                {t.label}
              </button>
            ))}
            {panel === "search" && (
              <span className="shrink-0 rounded-lg bg-white px-3 py-1.5 text-sm font-medium text-black">ผลการค้นหา</span>
            )}
          </div>

          {panel === "search" ? (
            <ul className="space-y-1">
              {searching && <li className="py-6 text-center text-sm text-white/40">กำลังค้นหา…</li>}
              {!searching &&
                searchResults.map((r) => (
                  <TrackRow
                    key={r.videoId}
                    videoId={r.videoId}
                    thumbnailUrl={r.thumbnailUrl}
                    title={r.title}
                    durationSeconds={r.durationSeconds}
                    meta="แตะเพื่อเล่นทันที"
                    onPlay={() => playBase(r.videoId, r.title)}
                    disabled={busy}
                    actions={
                      <RowAction title="เพิ่มเข้าเพลงของร้าน" onClick={() => addStoreSong(r.videoId, r.title)} disabled={busy}>
                        ＋
                      </RowAction>
                    }
                  />
                ))}
              {!searching && searchResults.length === 0 && (
                <li className="py-6 text-center text-sm text-white/40">พิมพ์ชื่อเพลงในช่องด้านบนแล้วกด Enter</li>
              )}
            </ul>
          ) : panel === "base" ? (
            <ul className="space-y-1">
              <li className="px-1 pb-1 text-xs text-white/40">เฉพาะพนักงาน — ลูกค้าไม่เห็น แตะเพลงเพื่อเล่นทันที</li>
              {basePlaylist.map((t) => (
                <TrackRow
                  key={t.videoId}
                  videoId={t.videoId}
                  title={t.title}
                  meta="เพลงของร้าน"
                  onPlay={() => playBase(t.videoId, t.title)}
                  disabled={busy}
                  active={now?.source === "base" && now.youtubeVideoId === t.videoId}
                  actions={
                    <RowAction title="ลบออกจากเพลงของร้าน" onClick={() => removeStoreSong(t.videoId)} disabled={busy} danger>
                      ✕
                    </RowAction>
                  }
                />
              ))}
              {basePlaylist.length === 0 && (
                <li className="py-6 text-center text-sm text-white/40">ยังไม่มีเพลงของร้าน — ค้นหาด้านบนแล้วกด ＋ เพื่อเพิ่ม</li>
              )}
            </ul>
          ) : panel === "history" ? (
            <ul className="space-y-1">
              {history.map((h) => (
                <TrackRow
                  key={h.id}
                  videoId={h.youtubeVideoId}
                  title={h.title ?? h.youtubeVideoId ?? "—"}
                  meta={`${h.source === "base" ? "เพลงของร้าน" : "ลูกค้าขอ"} · ${new Date(h.playedAt).toLocaleTimeString("th-TH", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}`}
                />
              ))}
              {history.length === 0 && <li className="py-6 text-center text-sm text-white/40">ยังไม่มีประวัติ</li>}
            </ul>
          ) : (
            <ul className="space-y-1">
              {upcoming.map((q, i) => (
                <TrackRow
                  key={q.id}
                  index={i + 1}
                  videoId={q.videoId}
                  title={q.title}
                  durationSeconds={q.durationSeconds}
                  meta="ลูกค้าขอ · แตะเพื่อเล่นเลย"
                  badge={
                    q.playNow ? (
                      <span className="rounded bg-rose-500/20 px-1.5 py-0.5 text-[11px] text-rose-300">⚡ เปิดทันที</span>
                    ) : q.isDonation ? (
                      <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[11px] text-amber-300">💸 โดเนท</span>
                    ) : null
                  }
                  onPlay={() => playItem(q.id)}
                  disabled={busy}
                  actions={
                    <RowAction title="ลบออกจากคิว" onClick={() => removeItem(q.id)} disabled={busy} danger>
                      ✕
                    </RowAction>
                  }
                />
              ))}
              {upcoming.length === 0 && (
                <li className="py-6 text-center text-sm text-white/40">
                  ยังไม่มีเพลงที่ลูกค้าขอ — ระหว่างนี้จะเล่นเพลงของร้าน
                </li>
              )}
            </ul>
          )}
        </aside>
      </div>
    </main>
  );
}

function formatDuration(seconds?: number): string | null {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return null;
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

function thumbnailFor(videoId?: string, thumbnailUrl?: string): string | null {
  if (thumbnailUrl && /^https:\/\/i\.ytimg\.com\//.test(thumbnailUrl)) return thumbnailUrl;
  if (videoId && VIDEO_ID_RE.test(videoId)) return `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
  return null;
}

function RowAction({
  title,
  onClick,
  disabled,
  danger,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm text-white/60 hover:bg-white/15 disabled:opacity-40 ${
        danger ? "hover:text-red-400" : "hover:text-sky-300"
      }`}
    >
      {children}
    </button>
  );
}

function TrackRow({
  videoId,
  thumbnailUrl,
  title,
  meta,
  durationSeconds,
  index,
  badge,
  active,
  onPlay,
  disabled,
  actions,
}: {
  videoId?: string;
  thumbnailUrl?: string;
  title: string;
  meta?: string;
  durationSeconds?: number;
  index?: number;
  badge?: ReactNode;
  active?: boolean;
  onPlay?: () => void;
  disabled?: boolean;
  actions?: ReactNode;
}) {
  const thumb = thumbnailFor(videoId, thumbnailUrl);
  const duration = formatDuration(durationSeconds);
  const clickable = Boolean(onPlay) && !disabled;
  const body = (
    <>
      {index !== undefined && <span className="w-5 shrink-0 text-center text-xs text-white/40">{index}</span>}
      <div className="relative aspect-video w-36 shrink-0 overflow-hidden rounded-lg bg-white/10 sm:w-40">
        {thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumb} alt="" loading="lazy" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-xl text-white/30">🎵</div>
        )}
        {duration && (
          <span className="absolute bottom-1 right-1 rounded bg-black/80 px-1 text-[11px] font-medium">{duration}</span>
        )}
        {clickable && (
          <span className="absolute inset-0 hidden items-center justify-center bg-black/40 text-2xl group-hover:flex">▶</span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="line-clamp-2 text-sm font-medium leading-snug">{title}</p>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {badge}
          {meta && <span className="text-xs text-white/50">{meta}</span>}
        </div>
      </div>
    </>
  );
  // ปุ่มเล่น (รูปปก+ชื่อ) กับปุ่มจัดการ (＋/✕) เป็นปุ่มพี่น้องกัน ไม่ซ้อนกัน — ใช้คีย์บอร์ด/โปรแกรมอ่านจอได้ถูกต้อง
  return (
    <li className={`flex items-center gap-1 rounded-xl ${active ? "bg-white/10" : ""}`}>
      {onPlay ? (
        <button
          type="button"
          onClick={onPlay}
          disabled={disabled}
          aria-label={`เล่น ${title}`}
          className="group flex min-w-0 flex-1 items-center gap-2 rounded-xl p-1.5 text-left hover:bg-white/10 disabled:cursor-default disabled:hover:bg-transparent"
        >
          {body}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-2 p-1.5">{body}</div>
      )}
      {actions}
    </li>
  );
}
