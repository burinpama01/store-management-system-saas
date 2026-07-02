"use server";

import { requirePermission } from "@/modules/auth/guards";
import { getCurrentUser, getUserStores, resolveCurrentStore } from "@/modules/auth/session";
import {
  getMusicPlayerSettings,
  getNowPlaying,
  listPlayableQueue,
  advanceNowPlaying,
  decideMusicRequest,
  listPlayHistory,
  playPreviousTrack,
  playRequestNow,
  playBaseTrackNow,
  upsertMusicPlayerSettings,
  type PlayHistoryItem,
} from "@/modules/music-requests/repository";
import { searchYouTube } from "@/modules/music-requests/youtube";
import { orderQueue, type NextTrack } from "@/modules/music-requests/queue-engine";
import type { NowPlaying, PlaylistTrack } from "@/modules/music-requests/types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function getStoreContext() {
  const user = await getCurrentUser();
  if (!user) throw new Error("ไม่มีสิทธิ์เข้าถึง");
  const { organizations, stores, memberships } = await getUserStores();
  const ctx = await resolveCurrentStore(stores, organizations, memberships);
  if (!ctx) throw new Error("ไม่พบข้อมูลร้านค้า");
  return { user, ctx };
}

/** Upcoming-queue item for the player display — no donation amounts. */
export interface PlayerQueueItem {
  id: string;
  title: string;
  isDonation: boolean;
  playNow: boolean;
}

/** A store-curated song (base playlist) — staff-only, never shown to customers. */
export interface PlayerBaseTrack {
  videoId: string;
  title: string;
}

export async function getPlayerStateAction(): Promise<{
  nowPlaying: NowPlaying | null;
  upcoming: PlayerQueueItem[];
  basePlaylist: PlayerBaseTrack[];
  interrupt: boolean;
  error: string | null;
}> {
  try {
    await requirePermission("orders.manage_qr");
    const { ctx } = await getStoreContext();
    const settingsRes = await getMusicPlayerSettings(ctx.storeId, ctx.organizationId);
    const [npRes, queue] = await Promise.all([
      getNowPlaying(ctx.storeId),
      listPlayableQueue(ctx.storeId, settingsRes.data?.autoApprove ?? true),
    ]);
    const ordered = orderQueue(queue);
    const upcoming = ordered.map((q) => ({
      id: q.id,
      title: q.title,
      isDonation: q.donationStatus === "verified",
      playNow: Boolean(q.playNow),
    }));
    const basePlaylist = (settingsRes.data?.basePlaylist ?? []).map((t) => ({
      videoId: t.videoId,
      title: t.title,
    }));
    // A "play now" donation that isn't already the current track must interrupt.
    const currentId = npRes.data?.musicRequestId ?? null;
    const interrupt = ordered.some((q) => q.playNow && q.id !== currentId);
    return { nowPlaying: npRes.data, upcoming, basePlaylist, interrupt, error: null };
  } catch (e) {
    return {
      nowPlaying: null,
      upcoming: [],
      basePlaylist: [],
      interrupt: false,
      error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด",
    };
  }
}

export async function advancePlayerAction(): Promise<{
  next: NextTrack | null;
  error: string | null;
}> {
  try {
    await requirePermission("orders.manage_qr");
    const { ctx } = await getStoreContext();
    const settingsRes = await getMusicPlayerSettings(ctx.storeId, ctx.organizationId);
    if (!settingsRes.data?.playerEnabled) {
      return { next: null, error: "เครื่องเล่นเพลงยังไม่เปิดใช้งาน" };
    }
    const res = await advanceNowPlaying(ctx.storeId, settingsRes.data);
    if (res.error) return { next: null, error: res.error.userMessage };
    return { next: res.data, error: null };
  } catch (e) {
    return { next: null, error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

/** Removes a still-queued request (marks it skipped). */
export async function removeQueueItemAction(
  requestId: string,
): Promise<{ error: string | null }> {
  try {
    await requirePermission("orders.manage_qr");
    await getStoreContext();
    if (!UUID_RE.test(requestId)) return { error: "คำขอไม่ถูกต้อง" };
    const res = await decideMusicRequest(requestId, "skip");
    if (res.error) return { error: res.error.userMessage };
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

/** Immediately plays a specific request from the queue (staff selection). */
export async function playQueueItemAction(
  requestId: string,
): Promise<{ next: NextTrack | null; error: string | null }> {
  try {
    await requirePermission("orders.manage_qr");
    const { ctx } = await getStoreContext();
    if (!UUID_RE.test(requestId)) return { next: null, error: "คำขอไม่ถูกต้อง" };
    const res = await playRequestNow(ctx.storeId, requestId);
    if (res.error) return { next: null, error: res.error.userMessage };
    return { next: res.data, error: null };
  } catch (e) {
    return { next: null, error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

/** Immediately plays a specific store song (base playlist) — staff-only. */
export async function playBaseTrackAction(
  videoId: string,
  title: string,
): Promise<{ next: NextTrack | null; error: string | null }> {
  try {
    await requirePermission("orders.manage_qr");
    const { ctx } = await getStoreContext();
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return { next: null, error: "วิดีโอไม่ถูกต้อง" };
    const res = await playBaseTrackNow(ctx.storeId, videoId, (title ?? "").slice(0, 200));
    if (res.error) return { next: null, error: res.error.userMessage };
    return { next: res.data, error: null };
  } catch (e) {
    return { next: null, error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

/** Re-plays the previously played track. */
export async function playPreviousAction(): Promise<{
  next: NextTrack | null;
  error: string | null;
}> {
  try {
    await requirePermission("orders.manage_qr");
    const { ctx } = await getStoreContext();
    const res = await playPreviousTrack(ctx.storeId);
    if (res.error) return { next: null, error: res.error.userMessage };
    return { next: res.data, error: null };
  } catch (e) {
    return { next: null, error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function getPlayHistoryAction(): Promise<{
  history: PlayHistoryItem[];
  error: string | null;
}> {
  try {
    await requirePermission("orders.manage_qr");
    const { ctx } = await getStoreContext();
    const res = await listPlayHistory(ctx.storeId);
    if (res.error) return { history: [], error: res.error.userMessage };
    return { history: res.data, error: null };
  } catch (e) {
    return { history: [], error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export interface PlayerSearchResult {
  videoId: string;
  title: string;
  thumbnailUrl?: string;
  durationSeconds?: number;
}

/** Staff searches YouTube by name to find a song to play or add to the store list. */
export async function searchPlayerMusicAction(
  query: string,
): Promise<{ results: PlayerSearchResult[]; error: string | null }> {
  try {
    await requirePermission("orders.manage_qr");
    await getStoreContext();
    const { results, error } = await searchYouTube(query, { limit: 10 });
    return {
      results: results.map((r) => ({
        videoId: r.videoId,
        title: r.title,
        thumbnailUrl: r.thumbnailUrl,
        durationSeconds: r.durationSeconds,
      })),
      error,
    };
  } catch (e) {
    return { results: [], error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

async function saveBasePlaylist(
  storeId: string,
  organizationId: string,
  tracks: PlaylistTrack[],
): Promise<{ error: string | null }> {
  const settingsRes = await getMusicPlayerSettings(storeId, organizationId);
  const s = settingsRes.data;
  if (!s) return { error: settingsRes.error?.userMessage ?? "โหลดการตั้งค่าไม่สำเร็จ" };
  const res = await upsertMusicPlayerSettings(storeId, organizationId, {
    playerEnabled: s.playerEnabled,
    autoApprove: s.autoApprove,
    donationEnabled: s.donationEnabled,
    minDonation: s.minDonation,
    playNowPrice: s.playNowPrice,
    maxDurationSeconds: s.maxDurationSeconds,
    basePlaylist: tracks,
    licensingAcknowledged: Boolean(s.licensingAcknowledgedAt),
  });
  return { error: res.error ? res.error.userMessage : null };
}

/** Adds a searched song to the store's own playlist (stored with its real title). */
export async function addStoreSongAction(
  videoId: string,
  title: string,
): Promise<{ error: string | null }> {
  try {
    await requirePermission("orders.manage_qr");
    const { ctx } = await getStoreContext();
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return { error: "วิดีโอไม่ถูกต้อง" };
    const cur = (await getMusicPlayerSettings(ctx.storeId, ctx.organizationId)).data?.basePlaylist ?? [];
    if (cur.some((t) => t.videoId === videoId)) return { error: "มีเพลงนี้ในรายการแล้ว" };
    if (cur.length >= 100) return { error: "รายการเพลงเต็มแล้ว (สูงสุด 100)" };
    const next: PlaylistTrack[] = [...cur, { videoId, title: (title ?? "").slice(0, 200) || videoId }];
    return await saveBasePlaylist(ctx.storeId, ctx.organizationId, next);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

/** Removes a song from the store's own playlist. */
export async function removeStoreSongAction(videoId: string): Promise<{ error: string | null }> {
  try {
    await requirePermission("orders.manage_qr");
    const { ctx } = await getStoreContext();
    const cur = (await getMusicPlayerSettings(ctx.storeId, ctx.organizationId)).data?.basePlaylist ?? [];
    const next = cur.filter((t) => t.videoId !== videoId);
    return await saveBasePlaylist(ctx.storeId, ctx.organizationId, next);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}
