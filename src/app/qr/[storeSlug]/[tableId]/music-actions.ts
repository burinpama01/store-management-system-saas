"use server";

import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { DEFAULT_BILLING_STATE, getPlanFeatures } from "@/modules/billing/types";
import { resolveQrMusicEligibility } from "@/modules/music-requests/gates";
import {
  validateMusicRequestInput,
  MUSIC_INPUT_ERROR_MESSAGE,
  type MusicRequestSubmitInput,
  type PublicMusicRequest,
} from "@/modules/music-requests/types";
import {
  submitMusicRequest,
  submitMusicDonationRequest,
  verifyMusicDonation,
  listPublicMusicQueue,
  listPlayableQueue,
  hasRecentDuplicateRequest,
  isVideoQueued,
  getNowPlaying,
} from "@/modules/music-requests/repository";
import { searchYouTube, type YouTubeSearchResult } from "@/modules/music-requests/youtube";
import { previewDonationPosition } from "@/modules/music-requests/queue-engine";
import { buildPromptPayPayload } from "@/modules/printing/promptpay-qr";
import { verifySlipByImageBase64, isSlip2goConfigured } from "@/modules/billing/slip2go";
import { notifyOwnerSafely } from "@/modules/notifications/dispatcher";
import { nowMs } from "@/shared/utils/time";

export interface MusicTrackInput {
  videoId: string;
  title: string;
  thumbnailUrl?: string;
  durationSeconds?: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUUID = (s: string) => UUID_RE.test(s);

interface MusicContext {
  organizationId: string;
  eligibility: ReturnType<typeof resolveQrMusicEligibility>;
  maxDurationSeconds: number;
  donationEnabled: boolean;
  minDonation: number;
  playNowPrice: number;
}

/** Re-resolves the music gate server-side; never trust client-provided flags. */
async function resolveMusicContext(
  storeId: string,
  tableId: string,
  querySessionId: string | null,
): Promise<{ ok: false; reason: string } | { ok: true; ctx: MusicContext }> {
  const supabase = await createSupabaseServiceClient();

  const { data: store, error: storeErr } = await supabase
    .from("stores")
    .select(
      "id, organization_id, is_active, qr_ordering_enabled, qr_ordering_mode, music_request_enabled, music_license_status",
    )
    .eq("id", storeId)
    .single();
  if (storeErr || !store || !store.is_active || !store.qr_ordering_enabled) {
    return { ok: false, reason: "ร้านไม่พร้อมรับคำขอ" };
  }

  const billingState =
    (await getOrganizationBillingState(store.organization_id)) ?? DEFAULT_BILLING_STATE;
  const features = getPlanFeatures(billingState);

  const { data: table, error: tableErr } = await supabase
    .from("tables")
    .select("id, store_id, is_active, qr_enabled, current_session_id, session_expires_at")
    .eq("id", tableId)
    .eq("store_id", storeId)
    .single();
  if (tableErr || !table || !table.is_active || !table.qr_enabled) {
    return { ok: false, reason: "โต๊ะไม่ถูกต้อง" };
  }

  const sessionActive = table.session_expires_at
    ? Date.parse(table.session_expires_at) > nowMs()
    : false;

  const eligibility = resolveQrMusicEligibility({
    qrMode: store.qr_ordering_mode,
    querySessionId,
    currentSessionId: table.current_session_id ?? null,
    sessionActive,
    isEnterprise: features.musicRequest,
    musicLicenseStatus: store.music_license_status,
    musicRequestEnabled: store.music_request_enabled,
  });

  const { data: settings } = await supabase
    .from("store_music_player_settings")
    .select("max_duration_seconds, donation_enabled, min_donation, play_now_price")
    .eq("store_id", storeId)
    .maybeSingle();

  return {
    ok: true,
    ctx: {
      organizationId: store.organization_id,
      eligibility,
      maxDurationSeconds: settings?.max_duration_seconds ?? 600,
      donationEnabled: settings?.donation_enabled ?? false,
      minDonation: settings?.min_donation ?? 10,
      playNowPrice: settings?.play_now_price ?? 100,
    },
  };
}

export async function listMusicQueueAction(
  storeId: string,
  tableId: string,
  querySessionId: string | null,
): Promise<{
  queue: PublicMusicRequest[];
  expired: boolean;
  nowPlayingTitle?: string | null;
  donationEnabled?: boolean;
  minDonation?: number;
  playNowPrice?: number;
  error: string | null;
}> {
  if (!isUUID(storeId) || !isUUID(tableId)) {
    return { queue: [], expired: false, error: "Invalid request" };
  }
  const resolved = await resolveMusicContext(storeId, tableId, querySessionId);
  if (!resolved.ok) return { queue: [], expired: false, error: resolved.reason };

  const { eligibility, donationEnabled, minDonation, playNowPrice } = resolved.ctx;
  if (!eligibility.canViewQueue) {
    return { queue: [], expired: eligibility.expiredWholeQr, error: eligibility.reason };
  }

  const [res, np] = await Promise.all([listPublicMusicQueue(storeId), getNowPlaying(storeId)]);
  if (res.error) return { queue: [], expired: false, error: res.error.userMessage };
  // The now-playing track is shown in its own banner — don't duplicate it in the list.
  const nowId = np.data?.musicRequestId ?? null;
  return {
    queue: nowId ? res.data.filter((q) => q.id !== nowId) : res.data,
    expired: false,
    nowPlayingTitle: np.data?.title ?? null,
    donationEnabled,
    minDonation,
    playNowPrice,
    error: null,
  };
}

export async function searchMusicAction(
  storeId: string,
  tableId: string,
  querySessionId: string | null,
  query: string,
): Promise<{ results: YouTubeSearchResult[]; error: string | null }> {
  if (!isUUID(storeId) || !isUUID(tableId)) return { results: [], error: "Invalid request" };
  const q = (query ?? "").trim();
  if (q.length < 2) return { results: [], error: null };

  const resolved = await resolveMusicContext(storeId, tableId, querySessionId);
  if (!resolved.ok) return { results: [], error: resolved.reason };
  if (!resolved.ctx.eligibility.canSubmitRequest) {
    return { results: [], error: resolved.ctx.eligibility.reason ?? "ขอเพลงไม่ได้ในขณะนี้" };
  }

  return searchYouTube(q, { maxDurationSeconds: resolved.ctx.maxDurationSeconds, limit: 10 });
}

export async function submitMusicRequestAction(
  storeId: string,
  tableId: string,
  querySessionId: string | null,
  input: MusicRequestSubmitInput,
  track?: MusicTrackInput,
): Promise<{ error: string | null }> {
  if (!isUUID(storeId) || !isUUID(tableId)) return { error: "Invalid request" };

  const validated = validateMusicRequestInput(input);
  if (!validated.ok) return { error: MUSIC_INPUT_ERROR_MESSAGE[validated.error] };

  const resolved = await resolveMusicContext(storeId, tableId, querySessionId);
  if (!resolved.ok) return { error: resolved.reason };

  const { eligibility, organizationId, maxDurationSeconds } = resolved.ctx;
  if (!eligibility.canSubmitRequest) {
    return { error: eligibility.reason ?? "ขอเพลงไม่ได้ในขณะนี้" };
  }

  if (track && track.durationSeconds && track.durationSeconds > maxDurationSeconds) {
    return { error: `เพลงต้องยาวไม่เกิน ${Math.floor(maxDurationSeconds / 60)} นาที` };
  }

  // Don't let the same video sit in the queue twice.
  if (track?.videoId) {
    const inQueue = await isVideoQueued(storeId, track.videoId);
    if (inQueue.queued) return { error: "มีเพลงนี้ในคิวแล้ว" };
  }

  // Minimal spam guard: collapse a double-tap of the same song from the table.
  const dup = await hasRecentDuplicateRequest(storeId, tableId, validated.value.songTitle);
  if (dup.duplicate) {
    return { error: "เพิ่งขอเพลงนี้ไปแล้ว กรุณารอสักครู่" };
  }

  const res = await submitMusicRequest({
    storeId,
    tableId,
    sessionId: querySessionId,
    songTitle: validated.value.songTitle,
    artistName: validated.value.artistName,
    requesterLabel: validated.value.requesterLabel,
    note: validated.value.note,
    youtubeVideoId: track?.videoId,
    youtubeTitle: track?.title,
    thumbnailUrl: track?.thumbnailUrl,
    durationSeconds: track?.durationSeconds,
  });
  if (res.error) return { error: res.error.userMessage };

  // Reuse the customer-signal notification channel (no dedicated music type).
  notifyOwnerSafely({
    type: "service_request",
    organizationId,
    storeId,
    title: "🎵 มีคำขอเพลงใหม่",
    message: `ขอเพลง: ${validated.value.songTitle}${
      validated.value.artistName ? ` — ${validated.value.artistName}` : ""
    }`,
    metadata: { songTitle: validated.value.songTitle },
  });

  return { error: null };
}

/**
 * Tells the customer which queue position their donation amount would reach —
 * a position number only. Never returns other donors' amounts.
 */
export async function previewDonationPositionAction(
  storeId: string,
  tableId: string,
  querySessionId: string | null,
  amount: number,
): Promise<{ position: number; minDonation: number; error: string | null }> {
  if (!isUUID(storeId) || !isUUID(tableId)) {
    return { position: 0, minDonation: 0, error: "Invalid request" };
  }
  const resolved = await resolveMusicContext(storeId, tableId, querySessionId);
  if (!resolved.ok) return { position: 0, minDonation: 0, error: resolved.reason };
  const { donationEnabled, minDonation, eligibility } = resolved.ctx;
  if (!eligibility.canSubmitRequest || !donationEnabled) {
    return { position: 0, minDonation, error: "ร้านนี้ยังไม่เปิดรับโดเนท" };
  }

  const queue = await listPlayableQueue(storeId, true);
  const position = previewDonationPosition(amount, queue);
  return { position, minDonation, error: null };
}

/**
 * Creates a pending donation request and returns a PromptPay payload to pay.
 * The request only enters the priority queue after the slip is verified.
 * When the store priced the tier at 0 THB, the request is free: no payment
 * step — it is verified immediately (`free: true`, no payload returned).
 */
export async function startMusicDonationAction(
  storeId: string,
  tableId: string,
  querySessionId: string | null,
  track: MusicTrackInput,
  requesterLabel: string | undefined,
  amount: number,
  playNow = false,
): Promise<{
  requestId: string | null;
  promptPayPayload: string | null;
  promptpayId: string | null;
  amount: number | null;
  free?: boolean;
  error: string | null;
}> {
  const empty = { requestId: null, promptPayPayload: null, promptpayId: null, amount: null };
  if (!isUUID(storeId) || !isUUID(tableId)) return { ...empty, error: "Invalid request" };
  if (!track?.videoId) return { ...empty, error: "กรุณาเลือกเพลงก่อน" };

  const resolved = await resolveMusicContext(storeId, tableId, querySessionId);
  if (!resolved.ok) return { ...empty, error: resolved.reason };
  const { eligibility, donationEnabled, minDonation, playNowPrice, maxDurationSeconds } = resolved.ctx;
  if (!eligibility.canSubmitRequest) return { ...empty, error: eligibility.reason ?? "ขอเพลงไม่ได้" };
  if (!donationEnabled) return { ...empty, error: "ร้านนี้ยังไม่เปิดรับโดเนท" };
  // Store-configured prices: play-now is a fixed-price tier; queue-jump has a minimum.
  const effectiveMin = playNow ? playNowPrice : minDonation;
  if (!Number.isFinite(amount) || amount < effectiveMin) {
    return { ...empty, error: `ยอดโดเนทขั้นต่ำ ${effectiveMin} บาท` };
  }
  if (track.durationSeconds && track.durationSeconds > maxDurationSeconds) {
    return { ...empty, error: `เพลงต้องยาวไม่เกิน ${Math.floor(maxDurationSeconds / 60)} นาที` };
  }

  // Don't let the same video sit in the queue twice.
  const inQueue = await isVideoQueued(storeId, track.videoId);
  if (inQueue.queued) return { ...empty, error: "มีเพลงนี้ในคิวแล้ว" };

  // Store priced this tier at 0 → free path: no PromptPay needed at all.
  const isFree = amount <= 0;

  let promptpayId: string | null = null;
  if (!isFree) {
    const supabase = await createSupabaseServiceClient();
    const { data: rs } = await supabase
      .from("receipt_settings")
      .select("promptpay_id")
      .eq("store_id", storeId)
      .maybeSingle();
    promptpayId = rs?.promptpay_id ?? null;
    if (!promptpayId) return { ...empty, error: "ร้านยังไม่ได้ตั้งค่า PromptPay" };
  }

  const res = await submitMusicDonationRequest({
    storeId,
    tableId,
    sessionId: querySessionId,
    songTitle: track.title,
    requesterLabel,
    youtubeVideoId: track.videoId,
    youtubeTitle: track.title,
    thumbnailUrl: track.thumbnailUrl,
    durationSeconds: track.durationSeconds,
    donationAmount: isFree ? 0 : amount,
    playNow,
  });
  if (res.error) return { ...empty, error: res.error.userMessage };

  if (isFree) {
    // Verified at creation (repository) — the song is already in the priority queue.
    return { requestId: res.data, promptPayPayload: null, promptpayId: null, amount: 0, free: true, error: null };
  }

  let payload: string;
  try {
    payload = buildPromptPayPayload({ recipientId: promptpayId!, amount });
  } catch {
    return { ...empty, error: "PromptPay ของร้านไม่ถูกต้อง" };
  }
  return { requestId: res.data, promptPayPayload: payload, promptpayId, amount, error: null };
}

/** Verifies the uploaded slip and promotes the donation into the queue. */
export async function verifyMusicDonationAction(
  storeId: string,
  requestId: string,
  slipBase64: string,
): Promise<{ error: string | null }> {
  if (!isUUID(storeId) || !isUUID(requestId)) return { error: "Invalid request" };
  if (!isSlip2goConfigured()) return { error: "ระบบตรวจสลิปยังไม่พร้อมใช้งาน" };
  if (!slipBase64) return { error: "กรุณาแนบสลิป" };

  const v = await verifySlipByImageBase64(slipBase64);
  if (!v.ok) return { error: v.error ?? "ตรวจสลิปไม่สำเร็จ" };

  // Deeper validation (exact amount + fresh date + after request) happens in
  // verifyMusicDonation — slip2go alone would accept old / mismatched slips.
  const res = await verifyMusicDonation(storeId, requestId, {
    amount: v.amount,
    transRef: v.transRef,
    transDate: v.transDate ?? null,
    receiverAccount: v.receiverAccount,
  });
  if (!res.ok) return { error: res.error?.userMessage ?? "ตรวจโดเนทไม่สำเร็จ" };
  return { error: null };
}
