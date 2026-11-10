import type { CustomerNowPlayingVideo } from "./types";

// จอลูกค้า (คาราโอเกะ): คำนวณตำแหน่งที่ควรเล่น ใช้ร่วมกันทั้งฝั่ง server (ตอบรอบ poll)
// และฝั่งมือถือ (ตอนได้ broadcast ว่าร้านกดหยุด/เลื่อนเพลง)

const YT_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

export interface PlaybackSnapshot {
  videoId?: string | null;
  title?: string | null;
  durationSeconds?: number | null;
  startedAt?: string | null;
  /** สถานะที่เครื่องเล่นของร้านรายงานล่าสุด */
  state?: "playing" | "paused" | string | null;
  positionSeconds?: number | null;
  positionAt?: string | null;
}

/**
 * ตำแหน่ง ณ เวลา `nowMs` (นาฬิกาฝั่ง server):
 * - มีรายงานจากเครื่องเล่น → ตำแหน่งที่รายงาน (+ เวลาที่ผ่านไป ถ้ากำลังเล่น)
 * - ยังไม่มีรายงาน → นับจากเวลาเริ่มเพลง
 */
export function toCustomerNowPlayingVideo(
  snap: PlaybackSnapshot | null,
  nowMs: number,
): CustomerNowPlayingVideo | null {
  if (!snap?.videoId || !YT_ID_RE.test(snap.videoId)) return null;
  const paused = snap.state === "paused";
  const duration = snap.durationSeconds && snap.durationSeconds > 0 ? snap.durationSeconds : null;

  let elapsed = 0;
  const reportedAt = snap.positionAt ? Date.parse(snap.positionAt) : NaN;
  const reportedPos = Number(snap.positionSeconds);
  if (Number.isFinite(reportedAt) && Number.isFinite(reportedPos) && reportedPos >= 0) {
    elapsed = paused ? reportedPos : reportedPos + Math.max(0, nowMs - reportedAt) / 1000;
  } else {
    const started = snap.startedAt ? Date.parse(snap.startedAt) : NaN;
    elapsed = Number.isFinite(started) ? Math.max(0, (nowMs - started) / 1000) : 0;
  }

  return {
    videoId: snap.videoId,
    title: snap.title ?? "",
    elapsedSeconds: Math.round(elapsed * 10) / 10,
    durationSeconds: duration,
    paused,
  };
}

/** แปลง payload ของ Realtime broadcast (หัวข้อ music-playback:<store>) — ไม่เชื่อชนิดข้อมูลจากภายนอก */
export function parsePlaybackBroadcast(payload: unknown): PlaybackSnapshot | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
  return {
    videoId: str(p.videoId),
    title: str(p.title),
    durationSeconds: num(p.durationSeconds),
    startedAt: str(p.startedAt),
    state: str(p.state),
    positionSeconds: num(p.positionSeconds),
    positionAt: str(p.positionAt),
  };
}
