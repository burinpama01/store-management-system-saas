"use client";

import { useEffect, useRef, useState } from "react";
import type { CustomerNowPlayingVideo } from "@/modules/music-requests/types";
import { parsePlaybackBroadcast, toCustomerNowPlayingVideo } from "@/modules/music-requests/customer-screen";
import { getSupabaseBrowserClient } from "@/server/integrations/supabase/client";
import { useWakeLock } from "@/shared/hooks/useWakeLock";

// จอลูกค้า (คาราโอเกะ): วิดีโอเดียวกับจอร้าน เล่นตรงตำแหน่งเดียวกันโดยประมาณ
// - ตำแหน่งคิดจาก elapsedSeconds ที่เซิร์ฟเวอร์คำนวณ + เวลาที่ผ่านไปบนเครื่องนี้ (performance.now)
//   จึงไม่พึ่งนาฬิกามือถือที่อาจตั้งผิด
// - ปิดเสียงเป็นค่าเริ่มต้น (เสียงมาจากลำโพงร้าน และ iOS ไม่ให้เล่นเองถ้าไม่ปิดเสียง)
// - ไม่ poll เพิ่ม: ใช้รอบโหลดคิวเดิมของ MusicTab + โหลดใหม่ทันทีเมื่อเพลงบนมือถือจบ

interface YTPlayer {
  loadVideoById: (opts: { videoId: string; startSeconds?: number }) => void;
  seekTo: (seconds: number, allowSeekAhead: boolean) => void;
  getCurrentTime?: () => number;
  getVideoData?: () => { video_id?: string };
  mute: () => void;
  unMute: () => void;
  playVideo: () => void;
  pauseVideo: () => void;
  getPlayerState?: () => number;
  destroy?: () => void;
}
interface YTNamespace {
  Player: new (el: HTMLElement, opts: unknown) => YTPlayer;
  PlayerState: { ENDED: number; PLAYING: number; BUFFERING: number };
}
// ไม่ใช้ declare global — หน้าเครื่องเล่นของร้านประกาศชนิด window.YT ของตัวเองไว้แล้ว
type YTWindow = Window & { YT?: YTNamespace; onYouTubeIframeAPIReady?: () => void };
const ytWindow = () => window as unknown as YTWindow;

/** เหลื่อมจากจอร้านเกินนี้ (วินาที) ค่อยกระโดดตาม — กันภาพกระตุกจากการ seek บ่อย */
const RESYNC_THRESHOLD_SECONDS = 4;

let ytApiPromise: Promise<YTNamespace> | null = null;
function loadYouTubeApi(): Promise<YTNamespace> {
  const w = ytWindow();
  if (w.YT?.Player) return Promise.resolve(w.YT);
  if (ytApiPromise) return ytApiPromise;
  ytApiPromise = new Promise<YTNamespace>((resolve, reject) => {
    // โหลดไม่ได้ (เน็ตหลุด / ถูกบล็อก) → reject และล้าง promise ให้กดเปิดใหม่แล้วลองอีกรอบได้
    const fail = () => {
      window.clearTimeout(timer);
      ytApiPromise = null;
      reject(new Error("youtube iframe api load failed"));
    };
    const timer = window.setTimeout(fail, 15000);
    const prev = w.onYouTubeIframeAPIReady;
    w.onYouTubeIframeAPIReady = () => {
      prev?.();
      window.clearTimeout(timer);
      if (w.YT?.Player) resolve(w.YT);
      else fail();
    };
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    tag.onerror = () => {
      tag.remove();
      fail();
    };
    document.body.appendChild(tag);
  });
  return ytApiPromise;
}

/** ตำแหน่งที่ควรเล่น ณ ตอนนี้ (วินาที) — ไม่เกินความยาวเพลง */
export function expectedPosition(
  video: Pick<CustomerNowPlayingVideo, "elapsedSeconds" | "durationSeconds"> & { paused?: boolean },
  receivedAtMs: number,
  nowMs: number,
): number {
  // ร้านกดหยุดอยู่ = ตำแหน่งไม่เดิน
  const pos = video.paused ? video.elapsedSeconds : video.elapsedSeconds + Math.max(0, nowMs - receivedAtMs) / 1000;
  if (video.durationSeconds && video.durationSeconds > 0) {
    return Math.min(pos, Math.max(0, video.durationSeconds - 1));
  }
  return pos;
}

/**
 * เพลงบนมือถือเล่นจบแล้ว แต่จอร้านยังไม่เปลี่ยนเพลง (ร้านช้ากว่า / มีโฆษณา / เครื่องร้านค้าง)
 * → ห้ามเล่นซ้ำหรือเลื่อนกลับไปท้ายเพลงวนไปเรื่อย ๆ ให้รอเพลงถัดไป
 */
export function shouldHoldAfterEnd(endedVideoId: string | null, videoId: string): boolean {
  return endedVideoId !== null && endedVideoId === videoId;
}

/** เรียกโหลดสถานะตอนเพลงจบได้ไม่ถี่กว่านี้ (กันยิงเซิร์ฟเวอร์รัวเมื่อเพลงจบซ้ำ ๆ) */
export const ENDED_RELOAD_MIN_INTERVAL_MS = 10_000;

export function CustomerScreen({
  storeId,
  video: polledVideo,
  receivedAtMs: polledAt,
  clockOffsetMs,
  onEnded,
}: {
  storeId: string;
  video: CustomerNowPlayingVideo | null;
  /** performance.now() ตอนได้รับ video จากเซิร์ฟเวอร์ */
  receivedAtMs: number;
  /** นาฬิกา server − นาฬิกาเครื่องนี้ */
  clockOffsetMs: number;
  onEnded: () => void;
}) {
  // สถานะสดจาก broadcast (ร้านกดหยุด/เล่นต่อ/เลื่อน/เปลี่ยนเพลง) ใช้แทนค่าจากรอบ poll ถ้าใหม่กว่า
  const [live, setLive] = useState<{ video: CustomerNowPlayingVideo | null; at: number } | null>(null);
  const useLive = live !== null && live.at > polledAt;
  const video = useLive ? live.video : polledVideo;
  const receivedAtMs = useLive ? live.at : polledAt;
  const [open, setOpen] = useState(false);
  const [muted, setMuted] = useState(true);
  const [failed, setFailed] = useState(false);
  const [apiError, setApiError] = useState(false);
  // เปิดจอเนื้อร้องอยู่ = กันจอมือถือดับ
  useWakeLock(open);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<YTPlayer | null>(null);
  const readyRef = useRef(false);
  const loadedIdRef = useRef<string | null>(null);
  // เพลงที่มือถือเล่นจบไปแล้ว — ค้างไว้จนร้านเปลี่ยนเป็นเพลงอื่น (กันลูปเล่นซ้ำ/seek ท้ายเพลง)
  const endedIdRef = useRef<string | null>(null);
  const lastEndedReloadRef = useRef(-Infinity);
  const videoRef = useRef(video);
  const receivedRef = useRef(receivedAtMs);
  const onEndedRef = useRef(onEnded);

  useEffect(() => {
    videoRef.current = video;
    receivedRef.current = receivedAtMs;
    onEndedRef.current = onEnded;
  }, [video, receivedAtMs, onEnded]);

  const clockOffsetRef = useRef(clockOffsetMs);
  useEffect(() => {
    clockOffsetRef.current = clockOffsetMs;
  }, [clockOffsetMs]);

  // ฟัง Realtime broadcast เฉพาะตอนเปิดจอ (มือถือที่ไม่ได้ดูไม่ต้องต่อ realtime)
  useEffect(() => {
    if (!open) return;
    const supabase = getSupabaseBrowserClient();
    const channel = supabase
      .channel(`music-playback:${storeId}`, { config: { private: true } })
      .on("broadcast", { event: "playback" }, (msg: { payload?: unknown }) => {
        const snap = parsePlaybackBroadcast(msg.payload);
        if (!snap) return;
        setLive({
          video: toCustomerNowPlayingVideo(snap, Date.now() + clockOffsetRef.current),
          at: performance.now(),
        });
      })
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [open, storeId]);

  // สร้างตัวเล่นเมื่อกดเปิดจอ (หลัง user gesture) และทำลายเมื่อปิด
  useEffect(() => {
    if (!open || !hostRef.current) return;
    let cancelled = false;
    const mount = document.createElement("div");
    hostRef.current.appendChild(mount);
    void loadYouTubeApi().then((YT) => {
      if (cancelled) return;
      const first = videoRef.current;
      playerRef.current = new YT.Player(mount, {
        height: "100%",
        width: "100%",
        videoId: first?.videoId,
        playerVars: {
          autoplay: 1,
          mute: 1,
          playsinline: 1,
          controls: 0,
          rel: 0,
          modestbranding: 1,
          start: first ? Math.floor(expectedPosition(first, receivedRef.current, performance.now())) : 0,
        },
        events: {
          onReady: () => {
            readyRef.current = true;
            loadedIdRef.current = videoRef.current?.videoId ?? null;
            playerRef.current?.mute();
            if (videoRef.current?.paused) playerRef.current?.pauseVideo();
            else playerRef.current?.playVideo();
          },
          onStateChange: (e: { data: number }) => {
            const YTns = ytWindow().YT;
            if (!YTns || e.data !== YTns.PlayerState.ENDED) return;
            endedIdRef.current = loadedIdRef.current;
            const now = performance.now();
            if (now - lastEndedReloadRef.current < ENDED_RELOAD_MIN_INTERVAL_MS) return;
            lastEndedReloadRef.current = now;
            onEndedRef.current();
          },
          // คลิปที่เจ้าของปิดการฝัง / ถูกลบ
          onError: () => setFailed(true),
        },
      });
    }).catch(() => {
      if (!cancelled) setApiError(true);
    });
    return () => {
      cancelled = true;
      playerRef.current?.destroy?.();
      playerRef.current = null;
      readyRef.current = false;
      loadedIdRef.current = null;
      endedIdRef.current = null;
      mount.remove();
    };
  }, [open]);

  // ตามเพลงร้าน: เปลี่ยนเพลง → โหลดใหม่ที่ตำแหน่งปัจจุบัน / เพลงเดิมแต่เหลื่อมมาก → เลื่อนตาม
  useEffect(() => {
    const p = playerRef.current;
    if (!open || !p || !readyRef.current || !video) return;
    const target = expectedPosition(video, receivedAtMs, performance.now());
    if (loadedIdRef.current !== video.videoId) {
      loadedIdRef.current = video.videoId;
      endedIdRef.current = null;
      setFailed(false);
      p.loadVideoById({ videoId: video.videoId, startSeconds: Math.floor(target) });
      if (video.paused) p.pauseVideo();
      return;
    }
    // จบไปแล้วบนมือถือ — รอจอร้านเปลี่ยนเพลง (ไม่ seek / ไม่ playVideo ซ้ำ)
    if (shouldHoldAfterEnd(endedIdRef.current, video.videoId)) return;
    const current = p.getCurrentTime?.();
    if (video.paused) {
      // ร้านกดหยุด → หยุดตรงตำแหน่งเดียวกับร้าน
      p.pauseVideo();
      if (typeof current === "number" && Math.abs(current - target) > 1) p.seekTo(target, true);
      return;
    }
    if (typeof current === "number" && Math.abs(current - target) > RESYNC_THRESHOLD_SECONDS) {
      p.seekTo(target, true);
    }
    // เล่นต่อเฉพาะเมื่อยังไม่ได้เล่นอยู่ — เรียก playVideo ซ้ำทุกรอบทำให้ iOS กระตุก/โหลดใหม่ได้
    const YTns = ytWindow().YT;
    const state = p.getPlayerState?.();
    if (YTns && state !== YTns.PlayerState.PLAYING && state !== YTns.PlayerState.BUFFERING) p.playVideo();
  }, [open, video, receivedAtMs]);

  function toggleMute() {
    const p = playerRef.current;
    if (!p) return;
    if (muted) {
      p.unMute();
      setMuted(false);
    } else {
      p.mute();
      setMuted(true);
    }
  }

  if (!video && !open) return null;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full rounded-xl bg-violet-600 px-4 py-3 text-sm font-bold text-white active:bg-violet-700"
      >
        🎤 ดูเนื้อร้องบนมือถือ
      </button>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl bg-black">
      <div className="relative w-full" style={{ aspectRatio: "16 / 9" }}>
        <div ref={hostRef} className="absolute inset-0 [&>div]:h-full [&>div]:w-full [&_iframe]:h-full [&_iframe]:w-full" />
        {!video && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-white/70">
            ยังไม่มีเพลงที่กำลังเล่น
          </div>
        )}
        {apiError && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/80 px-6 text-center text-sm text-white/80">
            โหลดวิดีโอไม่ได้ ตรวจอินเทอร์เน็ตแล้วกด ✕ แล้วเปิดใหม่อีกครั้ง
          </div>
        )}
        {failed && video && !apiError && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/80 px-6 text-center text-sm text-white/80">
            คลิปนี้เปิดบนมือถือไม่ได้ (เจ้าของคลิปปิดการฝัง) — ดูที่จอร้านแทนนะคะ
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 px-3 py-2 text-xs text-white/80">
        <button
          type="button"
          onClick={toggleMute}
          className="rounded-full bg-white/15 px-3 py-1.5 font-medium text-white active:bg-white/25"
        >
          {muted ? "🔇 แตะเพื่อเปิดเสียง" : "🔊 ปิดเสียง"}
        </button>
        <span className="min-w-0 flex-1 truncate">{video?.paused ? "⏸ ร้านหยุดเพลงไว้" : "ตรงกับจอร้าน (อาจช้ากว่า 1–3 วินาที)"}</span>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setMuted(true);
            setFailed(false);
            setApiError(false);
          }}
          aria-label="ปิดจอ"
          className="rounded-full px-2 py-1 text-white/70 active:bg-white/15"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
