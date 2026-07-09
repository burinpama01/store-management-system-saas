import {
  createSupabaseServerClient,
  createSupabaseServiceClient,
} from "@/server/integrations/supabase/server";
import { mapError } from "@/shared/utils/error";
import type { Database, Json } from "@/server/integrations/supabase/database.types";
import type {
  MusicRequest,
  MusicDecisionAction,
  PublicMusicRequest,
  PublicMusicRequestStatus,
  MusicPlayerSettings,
  PlaylistTrack,
  NowPlaying,
} from "./types";
import { selectNextTrack, type QueueItem, type NextTrack } from "./queue-engine";
import { validateDonationSlip, DONATION_SLIP_ERROR_MESSAGE } from "./donation-check";

type MusicRequestRow = Database["public"]["Tables"]["music_requests"]["Row"];
type PlayerSettingsRow = Database["public"]["Tables"]["store_music_player_settings"]["Row"];
type NowPlayingRow = Database["public"]["Tables"]["store_now_playing"]["Row"];

const PUBLIC_QUEUE_STATUSES: PublicMusicRequestStatus[] = ["pending", "approved", "played"];

export function mapMusicRequest(row: MusicRequestRow): MusicRequest {
  return {
    id: row.id,
    storeId: row.store_id,
    organizationId: row.organization_id,
    tableId: row.table_id ?? undefined,
    tableNumber: row.table_number ?? undefined,
    sessionId: row.session_id ?? undefined,
    requesterLabel: row.requester_label ?? undefined,
    songTitle: row.song_title,
    artistName: row.artist_name ?? undefined,
    note: row.note ?? undefined,
    status: row.status,
    donationStatus: row.donation_status,
    requestedAt: row.requested_at,
    decidedAt: row.decided_at ?? undefined,
    decidedBy: row.decided_by ?? undefined,
    playedAt: row.played_at ?? undefined,
  };
}

/** Strips internal-only fields (note, decidedBy, sessionId, ...) for customers. */
export function toPublicMusicRequest(row: MusicRequestRow): PublicMusicRequest {
  return {
    id: row.id,
    songTitle: row.song_title,
    artistName: row.artist_name ?? undefined,
    requesterLabel: row.requester_label ?? undefined,
    status: row.status as PublicMusicRequestStatus,
    requestedAt: row.requested_at,
  };
}

export interface SubmitMusicRequestInput {
  storeId: string;
  tableId: string;
  sessionId: string | null;
  songTitle: string;
  artistName?: string;
  requesterLabel?: string;
  note?: string;
  youtubeVideoId?: string;
  youtubeTitle?: string;
  thumbnailUrl?: string;
  durationSeconds?: number;
}

/**
 * Customer submit — goes through the SECURITY DEFINER RPC which re-enforces the
 * Enterprise/license/session gate server-side, then attaches the YouTube track
 * fields. Uses the service client because the caller is an anonymous QR visitor.
 */
export async function submitMusicRequest(input: SubmitMusicRequestInput) {
  const supabase = await createSupabaseServiceClient();
  const { data, error } = await supabase.rpc("create_music_request", {
    p_store_id: input.storeId,
    p_table_id: input.tableId,
    p_session_id: input.sessionId,
    p_song_title: input.songTitle,
    p_artist_name: input.artistName ?? null,
    p_requester_label: input.requesterLabel ?? null,
    p_note: input.note ?? null,
  });
  if (error) return { data: null, error: mapError(error) };
  const id = data as string;

  if (input.youtubeVideoId) {
    await supabase
      .from("music_requests")
      .update({
        youtube_video_id: input.youtubeVideoId,
        youtube_title: input.youtubeTitle ?? input.songTitle,
        thumbnail_url: input.thumbnailUrl ?? null,
        duration_seconds: input.durationSeconds ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);
  }
  return { data: id, error: null };
}

/**
 * Donation request: created via the gate RPC, then flagged donation 'pending'
 * with its YouTube track. Becomes 'verified' (and approved) once the slip checks.
 */
export async function submitMusicDonationRequest(
  input: SubmitMusicRequestInput & { donationAmount: number; playNow?: boolean },
) {
  const supabase = await createSupabaseServiceClient();
  const { data, error } = await supabase.rpc("create_music_request", {
    p_store_id: input.storeId,
    p_table_id: input.tableId,
    p_session_id: input.sessionId,
    p_song_title: input.songTitle,
    p_artist_name: input.artistName ?? null,
    p_requester_label: input.requesterLabel ?? null,
    p_note: input.note ?? null,
  });
  if (error) return { data: null, error: mapError(error) };
  const id = data as string;

  // A zero-price tier (store set the price to 0) needs no payment: the request
  // is verified+approved immediately, exactly like a slip-confirmed donation.
  const isFree = input.donationAmount <= 0;
  const now = new Date().toISOString();
  const { error: upErr } = await supabase
    .from("music_requests")
    .update({
      youtube_video_id: input.youtubeVideoId ?? null,
      youtube_title: input.youtubeTitle ?? input.songTitle,
      thumbnail_url: input.thumbnailUrl ?? null,
      duration_seconds: input.durationSeconds ?? null,
      donation_amount: input.donationAmount,
      donation_status: isFree ? "verified" : "pending",
      donation_play_now: Boolean(input.playNow),
      ...(isFree ? { status: "approved", decided_at: now } : {}),
      updated_at: now,
    })
    .eq("id", id);
  if (upErr) return { data: null, error: mapError(upErr) };
  return { data: id, error: null };
}

/**
 * Marks a donation verified after slip confirmation: the slip amount must cover
 * the pledged amount, and the transRef is recorded (unique — prevents slip reuse).
 * Verified donations are approved so they enter the priority queue.
 */
export interface DonationSlipData {
  amount: number | null;
  transRef: string | null;
  transDate: string | null;
  receiverAccount: string | null;
}

export async function verifyMusicDonation(
  storeId: string,
  requestId: string,
  slip: DonationSlipData,
) {
  const supabase = await createSupabaseServiceClient();
  const { data: req } = await supabase
    .from("music_requests")
    .select("donation_amount, donation_status, created_at")
    .eq("id", requestId)
    .eq("store_id", storeId)
    .maybeSingle();
  if (!req) return { ok: false, error: mapError(new Error("ไม่พบคำขอเพลง")) };
  if (req.donation_status === "verified") return { ok: true, error: null };

  const { data: rs } = await supabase
    .from("receipt_settings")
    .select("promptpay_id")
    .eq("store_id", storeId)
    .maybeSingle();

  const check = validateDonationSlip({
    slipAmount: slip.amount,
    slipTransRef: slip.transRef,
    slipTransDate: slip.transDate,
    slipReceiverAccount: slip.receiverAccount,
    expectedAmount: req.donation_amount,
    requestCreatedAt: req.created_at,
    storePromptpayId: rs?.promptpay_id ?? null,
    nowMs: Date.now(),
  });
  if (!check.ok) {
    return { ok: false, error: mapError(new Error(DONATION_SLIP_ERROR_MESSAGE[check.error])) };
  }

  const now = new Date().toISOString();
  const { error } = await supabase
    .from("music_requests")
    .update({
      donation_status: "verified",
      donation_ref: slip.transRef,
      status: "approved",
      decided_at: now,
      updated_at: now,
    })
    .eq("id", requestId)
    .eq("store_id", storeId);
  if (error) {
    // Unique index on donation_ref → this slip was already used.
    return { ok: false, error: mapError(new Error("สลิปนี้ถูกใช้ไปแล้ว")) };
  }
  return { ok: true, error: null };
}

/**
 * Public queue shown on the customer QR page. Read via service client (RLS
 * limits music_requests to store members) and reduced to the public-safe view.
 */
export async function listPublicMusicQueue(storeId: string, limit = 20) {
  const supabase = await createSupabaseServiceClient();
  const { data, error } = await supabase
    .from("music_requests")
    .select("*")
    .eq("store_id", storeId)
    .in("status", PUBLIC_QUEUE_STATUSES)
    .order("requested_at", { ascending: false })
    .limit(limit);
  if (error) return { data: [] as PublicMusicRequest[], error: mapError(error) };
  return { data: (data ?? []).map(toPublicMusicRequest), error: null };
}

export interface PlayedTrack {
  id: string;
  songTitle: string;
  artistName?: string;
  youtubeVideoId: string;
  youtubeTitle?: string;
  thumbnailUrl?: string;
  durationSeconds?: number;
  playedAt?: string;
}

/**
 * Recently played songs (distinct by video) for the customer "play again" list.
 * Read via the service client since the caller is an anonymous QR visitor.
 */
export async function listRecentlyPlayed(storeId: string, limit = 12) {
  const supabase = await createSupabaseServiceClient();
  const { data, error } = await supabase
    .from("music_requests")
    .select(
      "id, song_title, artist_name, youtube_video_id, youtube_title, thumbnail_url, duration_seconds, played_at",
    )
    .eq("store_id", storeId)
    .eq("status", "played")
    .not("youtube_video_id", "is", null)
    .order("played_at", { ascending: false })
    .limit(60);
  if (error) return { data: [] as PlayedTrack[], error: mapError(error) };

  const seen = new Set<string>();
  const tracks: PlayedTrack[] = [];
  for (const r of data ?? []) {
    const vid = r.youtube_video_id;
    if (!vid || seen.has(vid)) continue;
    seen.add(vid);
    tracks.push({
      id: r.id,
      songTitle: r.song_title,
      artistName: r.artist_name ?? undefined,
      youtubeVideoId: vid,
      youtubeTitle: r.youtube_title ?? undefined,
      thumbnailUrl: r.thumbnail_url ?? undefined,
      durationSeconds: r.duration_seconds ?? undefined,
      playedAt: r.played_at ?? undefined,
    });
    if (tracks.length >= limit) break;
  }
  return { data: tracks, error: null };
}

/**
 * Detect a near-duplicate submission (same song from the same table within a
 * short window) so a customer double-tap doesn't spam the queue.
 */
export async function hasRecentDuplicateRequest(
  storeId: string,
  tableId: string,
  songTitle: string,
  withinSeconds = 60,
) {
  const supabase = await createSupabaseServiceClient();
  const since = new Date(Date.now() - withinSeconds * 1000).toISOString();
  const { data, error } = await supabase
    .from("music_requests")
    .select("id")
    .eq("store_id", storeId)
    .eq("table_id", tableId)
    .eq("song_title", songTitle)
    .gte("requested_at", since)
    .limit(1);
  if (error) return { duplicate: false, error: mapError(error) };
  return { duplicate: (data ?? []).length > 0, error: null };
}

/** Dashboard queue (full detail), RLS-scoped to the staff member's stores. */
export async function listStoreMusicQueue(storeId: string, limit = 100) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("music_requests")
    .select("*")
    .eq("store_id", storeId)
    .order("requested_at", { ascending: false })
    .limit(limit);
  if (error) return { data: [] as MusicRequest[], error: mapError(error) };
  return { data: (data ?? []).map(mapMusicRequest), error: null };
}

/** Staff decision — RPC enforces cashier+ in the request's store and audits. */
export async function decideMusicRequest(
  requestId: string,
  action: MusicDecisionAction,
) {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("decide_music_request", {
    p_request_id: requestId,
    p_action: action,
  });
  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}

// --- Player settings + now-playing ---------------------------------------

export function mapMusicPlayerSettings(row: PlayerSettingsRow): MusicPlayerSettings {
  return {
    storeId: row.store_id,
    organizationId: row.organization_id,
    playerEnabled: row.player_enabled,
    autoApprove: row.auto_approve,
    donationEnabled: row.donation_enabled,
    minDonation: row.min_donation,
    playNowPrice: row.play_now_price ?? 100,
    maxDurationSeconds: row.max_duration_seconds,
    basePlaylist: Array.isArray(row.base_playlist)
      ? (row.base_playlist as unknown as PlaylistTrack[])
      : [],
    licensingAcknowledgedAt: row.licensing_acknowledged_at ?? undefined,
    updatedAt: row.updated_at,
  };
}

/** Default settings when a store has never configured the player. */
export function defaultMusicPlayerSettings(
  storeId: string,
  organizationId: string,
): MusicPlayerSettings {
  return {
    storeId,
    organizationId,
    playerEnabled: false,
    autoApprove: true,
    donationEnabled: false,
    minDonation: 10,
    playNowPrice: 100,
    maxDurationSeconds: 600,
    basePlaylist: [],
    licensingAcknowledgedAt: undefined,
    updatedAt: new Date(0).toISOString(),
  };
}

export async function getMusicPlayerSettings(storeId: string, organizationId: string) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("store_music_player_settings")
    .select("*")
    .eq("store_id", storeId)
    .maybeSingle();
  if (error) return { data: null, error: mapError(error) };
  return {
    data: data ? mapMusicPlayerSettings(data) : defaultMusicPlayerSettings(storeId, organizationId),
    error: null,
  };
}

export interface UpdateMusicPlayerSettingsInput {
  playerEnabled: boolean;
  autoApprove: boolean;
  donationEnabled: boolean;
  minDonation: number;
  playNowPrice: number;
  maxDurationSeconds: number;
  basePlaylist: PlaylistTrack[];
  licensingAcknowledged: boolean;
}

export async function upsertMusicPlayerSettings(
  storeId: string,
  organizationId: string,
  input: UpdateMusicPlayerSettingsInput,
) {
  const supabase = await createSupabaseServerClient();
  const existing = await supabase
    .from("store_music_player_settings")
    .select("licensing_acknowledged_at")
    .eq("store_id", storeId)
    .maybeSingle();
  const now = new Date().toISOString();
  const ackAt = input.licensingAcknowledged
    ? existing.data?.licensing_acknowledged_at ?? now
    : null;

  const { error } = await supabase.from("store_music_player_settings").upsert(
    {
      store_id: storeId,
      organization_id: organizationId,
      player_enabled: input.playerEnabled,
      auto_approve: input.autoApprove,
      donation_enabled: input.donationEnabled,
      min_donation: input.minDonation,
      play_now_price: input.playNowPrice,
      max_duration_seconds: input.maxDurationSeconds,
      base_playlist: input.basePlaylist as unknown as Json,
      licensing_acknowledged_at: ackAt,
      updated_at: now,
    },
    { onConflict: "store_id" },
  );
  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}

export function mapNowPlaying(row: NowPlayingRow): NowPlaying {
  return {
    storeId: row.store_id,
    musicRequestId: row.music_request_id ?? undefined,
    source: row.source,
    youtubeVideoId: row.youtube_video_id ?? undefined,
    title: row.title ?? undefined,
    durationSeconds: row.duration_seconds ?? undefined,
    startedAt: row.started_at,
  };
}

export async function getNowPlaying(storeId: string) {
  const supabase = await createSupabaseServiceClient();
  const { data, error } = await supabase
    .from("store_now_playing")
    .select("*")
    .eq("store_id", storeId)
    .maybeSingle();
  if (error) return { data: null, error: mapError(error) };
  return { data: data ? mapNowPlaying(data) : null, error: null };
}

/** Requests eligible to play: have a YouTube id and are queued (not yet played). */
export async function listPlayableQueue(
  storeId: string,
  autoApprove: boolean,
): Promise<QueueItem[]> {
  const supabase = await createSupabaseServiceClient();
  const statuses: ("pending" | "approved")[] = autoApprove
    ? ["pending", "approved"]
    : ["approved"];
  const { data } = await supabase
    .from("music_requests")
    .select(
      "id, youtube_video_id, youtube_title, song_title, duration_seconds, donation_status, donation_amount, donation_play_now, requested_at",
    )
    .eq("store_id", storeId)
    .in("status", statuses)
    .not("youtube_video_id", "is", null)
    .order("requested_at", { ascending: true });
  return (data ?? [])
    .filter((r) => r.youtube_video_id)
    .map((r) => ({
      id: r.id,
      youtubeVideoId: r.youtube_video_id as string,
      title: r.youtube_title ?? r.song_title,
      durationSeconds: r.duration_seconds ?? undefined,
      donationStatus: r.donation_status,
      donationAmount: r.donation_amount,
      playNow: r.donation_play_now,
      requestedAt: r.requested_at,
    }));
}

/** True when a video is already queued (not yet played) — prevents duplicates. */
export async function isVideoQueued(storeId: string, youtubeVideoId: string) {
  const supabase = await createSupabaseServiceClient();
  const { data, error } = await supabase
    .from("music_requests")
    .select("id")
    .eq("store_id", storeId)
    .eq("youtube_video_id", youtubeVideoId)
    .in("status", ["pending", "approved"])
    .limit(1);
  if (error) return { queued: false, error: mapError(error) };
  return { queued: (data ?? []).length > 0, error: null };
}

/**
 * Advance the player: mark the current request played, pick the next track via
 * the pure queue engine, and write store_now_playing. Service client (RLS denies
 * client writes on now_playing). Returns the next track, or null when idle.
 */
export async function advanceNowPlaying(
  storeId: string,
  settings: MusicPlayerSettings,
): Promise<{ data: NextTrack | null; error: ReturnType<typeof mapError> | null }> {
  const supabase = await createSupabaseServiceClient();
  const now = new Date().toISOString();

  const { data: current } = await supabase
    .from("store_now_playing")
    .select("*")
    .eq("store_id", storeId)
    .maybeSingle();

  // Mark the outgoing track played (no-op if already played).
  if (current?.music_request_id) {
    await supabase
      .from("music_requests")
      .update({ status: "played", played_at: now, updated_at: now })
      .eq("id", current.music_request_id)
      .neq("status", "played");
  }

  const queue = await listPlayableQueue(storeId, settings.autoApprove);
  const lastBaseVideoId =
    current?.source === "base" ? current.youtube_video_id ?? null : null;
  const next = selectNextTrack(queue, settings.basePlaylist, lastBaseVideoId);

  // A request that becomes "now playing" leaves the queue (and the รอตรวจ list)
  // immediately — mark it played the moment it starts.
  if (next?.requestId) {
    await supabase
      .from("music_requests")
      .update({ status: "played", played_at: now, decided_at: now, updated_at: now })
      .eq("id", next.requestId)
      .neq("status", "played");
  }

  const { error } = await supabase.from("store_now_playing").upsert(
    {
      store_id: storeId,
      music_request_id: next?.requestId ?? null,
      source: next?.source ?? "base",
      youtube_video_id: next?.youtubeVideoId ?? null,
      title: next?.title ?? null,
      duration_seconds: next?.durationSeconds ?? null,
      started_at: now,
      updated_at: now,
    },
    { onConflict: "store_id" },
  );
  if (error) return { data: null, error: mapError(error) };

  if (next) {
    await supabase.from("store_play_history").insert({
      store_id: storeId,
      music_request_id: next.requestId ?? null,
      source: next.source,
      youtube_video_id: next.youtubeVideoId,
      title: next.title,
      played_at: now,
    });
  }
  return { data: next, error: null };
}

/**
 * Immediately play a specific queued request (staff picks it from the queue).
 * Marks the outgoing track played, sets it as now-playing, and records history.
 */
export async function playRequestNow(
  storeId: string,
  requestId: string,
): Promise<{ data: NextTrack | null; error: ReturnType<typeof mapError> | null }> {
  const supabase = await createSupabaseServiceClient();
  const now = new Date().toISOString();

  const { data: req, error: reqErr } = await supabase
    .from("music_requests")
    .select("id, youtube_video_id, youtube_title, song_title, duration_seconds")
    .eq("id", requestId)
    .eq("store_id", storeId)
    .in("status", ["pending", "approved"])
    .not("youtube_video_id", "is", null)
    .maybeSingle();
  if (reqErr) return { data: null, error: mapError(reqErr) };
  if (!req || !req.youtube_video_id) {
    return { data: null, error: mapError(new Error("ไม่พบเพลงในคิว")) };
  }

  const { data: current } = await supabase
    .from("store_now_playing")
    .select("music_request_id")
    .eq("store_id", storeId)
    .maybeSingle();
  if (current?.music_request_id && current.music_request_id !== requestId) {
    await supabase
      .from("music_requests")
      .update({ status: "played", played_at: now, updated_at: now })
      .eq("id", current.music_request_id)
      .neq("status", "played");
  }

  const next: NextTrack = {
    source: "request",
    requestId: req.id,
    youtubeVideoId: req.youtube_video_id,
    title: req.youtube_title ?? req.song_title,
    durationSeconds: req.duration_seconds ?? undefined,
  };

  await supabase
    .from("music_requests")
    .update({ status: "played", played_at: now, decided_at: now, updated_at: now })
    .eq("id", req.id)
    .neq("status", "played");

  const { error } = await supabase.from("store_now_playing").upsert(
    {
      store_id: storeId,
      music_request_id: next.requestId ?? null,
      source: next.source,
      youtube_video_id: next.youtubeVideoId,
      title: next.title,
      duration_seconds: next.durationSeconds ?? null,
      started_at: now,
      updated_at: now,
    },
    { onConflict: "store_id" },
  );
  if (error) return { data: null, error: mapError(error) };

  await supabase.from("store_play_history").insert({
    store_id: storeId,
    music_request_id: next.requestId ?? null,
    source: next.source,
    youtube_video_id: next.youtubeVideoId,
    title: next.title,
    played_at: now,
  });
  return { data: next, error: null };
}

/**
 * Immediately play a specific store song (base playlist track). Staff-only;
 * never enters the customer-visible request queue. Marks the outgoing track
 * played, sets now-playing (source "base"), and records history.
 */
export async function playBaseTrackNow(
  storeId: string,
  youtubeVideoId: string,
  title: string,
): Promise<{ data: NextTrack | null; error: ReturnType<typeof mapError> | null }> {
  const supabase = await createSupabaseServiceClient();
  const now = new Date().toISOString();

  const { data: current } = await supabase
    .from("store_now_playing")
    .select("music_request_id")
    .eq("store_id", storeId)
    .maybeSingle();
  if (current?.music_request_id) {
    await supabase
      .from("music_requests")
      .update({ status: "played", played_at: now, updated_at: now })
      .eq("id", current.music_request_id)
      .neq("status", "played");
  }

  const next: NextTrack = { source: "base", youtubeVideoId, title };

  const { error } = await supabase.from("store_now_playing").upsert(
    {
      store_id: storeId,
      music_request_id: null,
      source: "base",
      youtube_video_id: youtubeVideoId,
      title,
      duration_seconds: null,
      started_at: now,
      updated_at: now,
    },
    { onConflict: "store_id" },
  );
  if (error) return { data: null, error: mapError(error) };

  await supabase.from("store_play_history").insert({
    store_id: storeId,
    music_request_id: null,
    source: "base",
    youtube_video_id: youtubeVideoId,
    title,
    played_at: now,
  });
  return { data: next, error: null };
}

export interface PlayHistoryItem {
  id: string;
  source: "request" | "base";
  youtubeVideoId?: string;
  title?: string;
  playedAt: string;
}

export async function listPlayHistory(storeId: string, limit = 30) {
  const supabase = await createSupabaseServiceClient();
  const { data, error } = await supabase
    .from("store_play_history")
    .select("id, source, youtube_video_id, title, played_at")
    .eq("store_id", storeId)
    .order("played_at", { ascending: false })
    .limit(limit);
  if (error) return { data: [] as PlayHistoryItem[], error: mapError(error) };
  return {
    data: (data ?? []).map((r) => ({
      id: r.id,
      source: r.source,
      youtubeVideoId: r.youtube_video_id ?? undefined,
      title: r.title ?? undefined,
      playedAt: r.played_at,
    })),
    error: null,
  };
}

/**
 * Re-plays the track that played before the current one: sets it as now-playing
 * and records it in history. Returns the track to load, or null if no history.
 */
export async function playPreviousTrack(
  storeId: string,
): Promise<{ data: NextTrack | null; error: ReturnType<typeof mapError> | null }> {
  const supabase = await createSupabaseServiceClient();
  const { data: rows } = await supabase
    .from("store_play_history")
    .select("*")
    .eq("store_id", storeId)
    .order("played_at", { ascending: false })
    .limit(2);
  const prev = (rows ?? [])[1];
  if (!prev || !prev.youtube_video_id) return { data: null, error: null };

  const now = new Date().toISOString();
  const track: NextTrack = {
    source: prev.source,
    requestId: prev.music_request_id ?? undefined,
    youtubeVideoId: prev.youtube_video_id,
    title: prev.title ?? prev.youtube_video_id,
  };

  const { error } = await supabase.from("store_now_playing").upsert(
    {
      store_id: storeId,
      music_request_id: track.requestId ?? null,
      source: track.source,
      youtube_video_id: track.youtubeVideoId,
      title: track.title,
      duration_seconds: null,
      started_at: now,
      updated_at: now,
    },
    { onConflict: "store_id" },
  );
  if (error) return { data: null, error: mapError(error) };

  await supabase.from("store_play_history").insert({
    store_id: storeId,
    music_request_id: track.requestId ?? null,
    source: track.source,
    youtube_video_id: track.youtubeVideoId,
    title: track.title,
    played_at: now,
  });
  return { data: track, error: null };
}
