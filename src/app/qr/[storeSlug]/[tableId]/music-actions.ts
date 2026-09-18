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
  listRecentlyPlayed,
  hasRecentDuplicateRequest,
  isVideoQueued,
  getNowPlaying,
  type PlayedTrack,
} from "@/modules/music-requests/repository";
import { searchYouTube, type YouTubeSearchResult } from "@/modules/music-requests/youtube";
import { previewDonationPosition } from "@/modules/music-requests/queue-engine";
import { buildPromptPayPayload } from "@/modules/printing/promptpay-qr";
import { verifySlipByImageBase64, isSlip2goConfigured } from "@/modules/billing/slip2go";
import { notifyOwnerSafely } from "@/modules/notifications/dispatcher";
import { nowMs } from "@/shared/utils/time";
import { logSystemEvent } from "@/modules/system/event-log";
import { createBeamQrPayment, isBeamReadyForStore, refreshBeamPayment } from "@/modules/payments/beam-service";
import type { BeamQrForPos } from "@/modules/payments/types";

export interface MusicTrackInput {
  videoId: string;
  title: string;
  thumbnailUrl?: string;
  durationSeconds?: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUUID = (s: string) => UUID_RE.test(s);
/** tableId = null คือ QR ขอเพลงของร้าน (ไม่ผูกโต๊ะ) */
const isValidTarget = (storeId: string, tableId: string | null) =>
  isUUID(storeId) && (tableId === null || isUUID(tableId));

interface MusicContext {
  organizationId: string;
  eligibility: ReturnType<typeof resolveQrMusicEligibility>;
  maxDurationSeconds: number;
  donationEnabled: boolean;
  minDonation: number;
  playNowPrice: number;
  /** แพ็กเกจมี Payment Gateway (BYO) — ร้านที่เปิด Beam ใช้ Beam แทนสลิป */
  beamAllowed: boolean;
}

/** Re-resolves the music gate server-side; never trust client-provided flags. */
async function resolveMusicContext(
  storeId: string,
  tableId: string | null,
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
  // QR ขอเพลงของร้าน (tableId = null) ไม่ต้องเปิด QR Order — ร้านที่ไม่รับออร์เดอร์ผ่าน QR ก็ให้ขอเพลงได้
  if (storeErr || !store || !store.is_active || (tableId !== null && !store.qr_ordering_enabled)) {
    return { ok: false, reason: "ร้านไม่พร้อมรับคำขอ" };
  }

  const billingState =
    (await getOrganizationBillingState(store.organization_id)) ?? DEFAULT_BILLING_STATE;
  const features = getPlanFeatures(billingState);

  const { data: settings } = await supabase
    .from("store_music_player_settings")
    .select("max_duration_seconds, donation_enabled, min_donation, play_now_price")
    .eq("store_id", storeId)
    .maybeSingle();
  const playerSettings = {
    beamAllowed: features.byoPaymentGateway,
    maxDurationSeconds: settings?.max_duration_seconds ?? 600,
    donationEnabled: settings?.donation_enabled ?? false,
    minDonation: settings?.min_donation ?? 10,
    playNowPrice: settings?.play_now_price ?? 100,
  };

  if (tableId === null) {
    // ไม่มีโต๊ะ/รอบบิล — ใช้กติกาเดียวกับ table_bound (ขอเพลงได้โดยไม่ต้องเปิดโต๊ะ)
    const eligibility = resolveQrMusicEligibility({
      qrMode: "table_bound",
      querySessionId: null,
      currentSessionId: null,
      sessionActive: false,
      isEnterprise: features.musicRequest,
      musicLicenseStatus: store.music_license_status,
      musicRequestEnabled: store.music_request_enabled,
    });
    return { ok: true, ctx: { organizationId: store.organization_id, eligibility, ...playerSettings } };
  }

  const { data: table, error: tableErr } = await supabase
    .from("tables")
    .select("id, store_id, is_active, qr_enabled, current_session_id, session_started_at, session_expires_at")
    .eq("id", tableId)
    .eq("store_id", storeId)
    .single();
  if (tableErr || !table || !table.is_active || !table.qr_enabled) {
    return { ok: false, reason: "โต๊ะไม่ถูกต้อง" };
  }

  // "ไม่จับเวลา" = session_started_at ถูกเซ็ต แต่ session_expires_at เป็น null → เปิดตลอด
  const sessionActive = table.session_expires_at
    ? Date.parse(table.session_expires_at) > nowMs()
    : Boolean(table.session_started_at);

  const eligibility = resolveQrMusicEligibility({
    qrMode: store.qr_ordering_mode,
    querySessionId,
    currentSessionId: table.current_session_id ?? null,
    sessionActive,
    isEnterprise: features.musicRequest,
    musicLicenseStatus: store.music_license_status,
    musicRequestEnabled: store.music_request_enabled,
  });

  return { ok: true, ctx: { organizationId: store.organization_id, eligibility, ...playerSettings } };
}

export async function listMusicQueueAction(
  storeId: string,
  tableId: string | null,
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
  if (!isValidTarget(storeId, tableId)) {
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

/** รายการเพลงที่เคยเล่นไปแล้ว (ให้ลูกค้ากด "ขอเล่นอีกครั้ง") */
export async function listPlayedHistoryAction(
  storeId: string,
  tableId: string | null,
  querySessionId: string | null,
): Promise<{ tracks: PlayedTrack[]; canRequest: boolean; error: string | null }> {
  if (!isValidTarget(storeId, tableId)) {
    return { tracks: [], canRequest: false, error: "Invalid request" };
  }
  const resolved = await resolveMusicContext(storeId, tableId, querySessionId);
  if (!resolved.ok) return { tracks: [], canRequest: false, error: resolved.reason };
  if (!resolved.ctx.eligibility.canViewQueue) {
    return { tracks: [], canRequest: false, error: null };
  }
  const res = await listRecentlyPlayed(storeId, 12);
  return {
    tracks: res.data,
    canRequest: resolved.ctx.eligibility.canSubmitRequest,
    error: res.error?.userMessage ?? null,
  };
}

export async function searchMusicAction(
  storeId: string,
  tableId: string | null,
  querySessionId: string | null,
  query: string,
): Promise<{ results: YouTubeSearchResult[]; error: string | null }> {
  if (!isValidTarget(storeId, tableId)) return { results: [], error: "Invalid request" };
  const q = (query ?? "").trim();
  if (q.length < 2) return { results: [], error: null };

  const resolved = await resolveMusicContext(storeId, tableId, querySessionId);
  if (!resolved.ok) return { results: [], error: resolved.reason };
  if (!resolved.ctx.eligibility.canSubmitRequest) {
    return { results: [], error: resolved.ctx.eligibility.reason ?? "ขอเพลงไม่ได้ในขณะนี้" };
  }

  const res = await searchYouTube(q, { maxDurationSeconds: resolved.ctx.maxDurationSeconds, limit: 10 });
  if (res.error) {
    await logSystemEvent({
      level: "warn",
      source: "music-request.search",
      action: "searchMusicAction",
      message: res.error,
      storeId,
      organizationId: resolved.ctx.organizationId,
    });
  }
  return res;
}

export async function submitMusicRequestAction(
  storeId: string,
  tableId: string | null,
  querySessionId: string | null,
  input: MusicRequestSubmitInput,
  track?: MusicTrackInput,
): Promise<{ error: string | null }> {
  if (!isValidTarget(storeId, tableId)) return { error: "Invalid request" };

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
  tableId: string | null,
  querySessionId: string | null,
  amount: number,
): Promise<{ position: number; minDonation: number; error: string | null }> {
  if (!isValidTarget(storeId, tableId)) {
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
  tableId: string | null,
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
  /** ร้านเปิด Beam: สแกนจ่ายแล้วระบบยืนยันเอง (ไม่ต้องแนบสลิป) */
  beam?: BeamQrForPos | null;
  error: string | null;
}> {
  const empty = { requestId: null, promptPayPayload: null, promptpayId: null, amount: null };
  if (!isValidTarget(storeId, tableId)) return { ...empty, error: "Invalid request" };
  if (!track?.videoId) return { ...empty, error: "กรุณาเลือกเพลงก่อน" };

  const resolved = await resolveMusicContext(storeId, tableId, querySessionId);
  if (!resolved.ok) return { ...empty, error: resolved.reason };
  const { eligibility, donationEnabled, minDonation, playNowPrice, maxDurationSeconds, beamAllowed, organizationId } = resolved.ctx;
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

  // ร้านที่เปิด Beam (และแพ็กเกจมี BYO gateway) → จ่ายผ่าน Beam ยืนยันอัตโนมัติ ไม่ต้องใช้สลิป
  const service = await createSupabaseServiceClient();
  const useBeam = !isFree && beamAllowed && (await isBeamReadyForStore(storeId, service));

  let promptpayId: string | null = null;
  if (!isFree && !useBeam) {
    const supabase = service;
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

  if (useBeam && res.data) {
    const beam = await createBeamQrPayment({
      organizationId,
      storeId,
      amountMajor: amount,
      // 1 คำขอ = 1 รายการชำระ (retry ได้ QR เดิม)
      clientRequestId: `music-${res.data}`,
      actorUserId: null,
      musicRequestId: res.data,
      client: service,
    });
    if (!beam.ok) {
      // สร้าง QR ไม่ได้ → ปิดคำขอที่ค้างจ่าย ไม่ให้ลอยอยู่ในระบบ
      await service
        .from("music_requests")
        .update({ donation_status: "rejected", status: "rejected", updated_at: new Date().toISOString() })
        .eq("id", res.data)
        .eq("store_id", storeId)
        .eq("donation_status", "pending");
      await logSystemEvent({
        level: "warn",
        source: "music.donation",
        action: "beamQrCreate",
        message: `สร้าง QR Beam สำหรับขอเพลงไม่สำเร็จ: ${beam.error}`,
        organizationId,
        storeId,
        context: { requestId: res.data, amount },
      }).catch(() => undefined);
      return { ...empty, error: beam.error };
    }
    await logSystemEvent({
      level: "info",
      source: "music.donation",
      action: "beamQrCreate",
      message: `สร้าง QR Beam ขอเพลง ฿${amount}`,
      organizationId,
      storeId,
      context: { requestId: res.data, gatewayPaymentId: beam.qr.gatewayPaymentId, playNow },
    }).catch(() => undefined);
    return { requestId: res.data, promptPayPayload: null, promptpayId: null, amount, beam: beam.qr, error: null };
  }

  let payload: string;
  try {
    payload = buildPromptPayPayload({ recipientId: promptpayId!, amount });
  } catch {
    return { ...empty, error: "PromptPay ของร้านไม่ถูกต้อง" };
  }
  return { requestId: res.data, promptPayPayload: payload, promptpayId, amount, error: null };
}

/**
 * ลูกค้ารอหน้า QR Beam: ถามสถานะการจ่าย (webhook อัปเดตให้อยู่แล้ว ถ้ายังไม่มาจะถาม Beam ตรง)
 * PAID → trigger ใน DB ยืนยันคำขอเพลงให้ (ยอดต้องตรง) — คืนผลว่าคำขอเข้าคิวแล้วหรือยัง
 */
export async function checkMusicDonationPaymentAction(
  storeId: string,
  requestId: string,
): Promise<{ status: string | null; verified: boolean; error: string | null }> {
  if (!isUUID(storeId) || !isUUID(requestId)) return { status: null, verified: false, error: "Invalid request" };
  const service = await createSupabaseServiceClient();
  const { data: payment } = await service
    .from("gateway_payments")
    .select("id")
    .eq("store_id", storeId)
    .eq("music_request_id", requestId)
    .maybeSingle();
  if (!payment) return { status: null, verified: false, error: "ไม่พบรายการชำระ" };

  const refreshed = await refreshBeamPayment({ storeId, gatewayPaymentId: payment.id, client: service });
  const status = refreshed.ok ? refreshed.status : null;

  const { data: request } = await service
    .from("music_requests")
    .select("donation_status")
    .eq("id", requestId)
    .eq("store_id", storeId)
    .maybeSingle();
  const verified = request?.donation_status === "verified";
  if (status === "PAID" && !verified) {
    return { status, verified, error: "ได้รับเงินแล้ว แต่ยอดไม่ตรงกับที่ขอ — แจ้งพนักงานเพื่อตรวจสอบ" };
  }
  return { status, verified, error: refreshed.ok ? null : refreshed.error };
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
